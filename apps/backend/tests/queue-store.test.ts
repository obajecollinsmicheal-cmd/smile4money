import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryQueueStore } from "../src/store/in-memory-queue-store.js";
import { SQLiteQueueStore } from "../src/store/sqlite-queue-store.js";
import type { DlqEntry } from "../src/store/persistent-queue-store.js";
import path from "path";
import fs from "fs";
import sqlite3 from "sqlite3";

/**
 * Test suite for queue store implementations.
 * Can be parameterized to test all store types.
 */

async function testQueueStore(createStore: () => any) {
  describe("Queue Store Implementation", () => {
    let store: any;

    beforeEach(async () => {
      store = createStore();
      await store.initialize();
    });

    afterEach(async () => {
      await store.close();
    });

    const createEntry = (id: string, payload: any = {}): DlqEntry => ({
      id,
      payload,
      failureReason: "test error",
      attempts: 0,
      createdAt: Date.now(),
      lastAttemptAt: null,
    });

    describe("add and getAll", () => {
      it("stores and retrieves entries", async () => {
        const entry = createEntry("e1");
        await store.add(entry);

        const all = await store.getAll();
        expect(all).toHaveLength(1);
        expect(all[0].id).toBe("e1");
      });

      it("retrieves multiple entries in order", async () => {
        await store.add(createEntry("e1"));
        await store.add(createEntry("e2"));
        await store.add(createEntry("e3"));

        const all = await store.getAll();
        expect(all).toHaveLength(3);
        expect(all.map((entry: DlqEntry) => entry.id)).toEqual([
          "e1",
          "e2",
          "e3",
        ]);
      });

      it("preserves payload data", async () => {
        const payload = {
          matchId: 42,
          gameId: "abc123",
          nested: { data: "value" },
        };
        const entry = createEntry("e1", payload);
        await store.add(entry);

        const [retrieved] = await store.getAll();
        expect(retrieved.payload).toEqual(payload);
      });
    });

    describe("remove", () => {
      it("removes entry by ID", async () => {
        await store.add(createEntry("e1"));
        await store.add(createEntry("e2"));

        await store.remove("e1");

        const all = await store.getAll();
        expect(all).toHaveLength(1);
        expect(all[0].id).toBe("e2");
      });

      it("is idempotent", async () => {
        await store.add(createEntry("e1"));
        await store.remove("e1");
        await expect(store.remove("e1")).resolves.not.toThrow();
        await expect(store.remove("nonexistent")).resolves.not.toThrow();
      });
    });

    describe("update", () => {
      it("updates attempts field", async () => {
        const entry = createEntry("e1");
        await store.add(entry);

        await store.update("e1", { attempts: 3 });

        const [retrieved] = await store.getAll();
        expect(retrieved.attempts).toBe(3);
      });

      it("updates lastAttemptAt field", async () => {
        const entry = createEntry("e1");
        await store.add(entry);

        const timestamp = Date.now();
        await store.update("e1", { lastAttemptAt: timestamp });

        const [retrieved] = await store.getAll();
        expect(retrieved.lastAttemptAt).toBe(timestamp);
      });

      it("updates multiple fields", async () => {
        const entry = createEntry("e1");
        await store.add(entry);

        const timestamp = Date.now();
        await store.update("e1", {
          attempts: 5,
          lastAttemptAt: timestamp,
        });

        const [retrieved] = await store.getAll();
        expect(retrieved.attempts).toBe(5);
        expect(retrieved.lastAttemptAt).toBe(timestamp);
      });
    });

    describe("count", () => {
      it("returns correct count", async () => {
        expect(await store.count()).toBe(0);

        await store.add(createEntry("e1"));
        expect(await store.count()).toBe(1);

        await store.add(createEntry("e2"));
        expect(await store.count()).toBe(2);

        await store.remove("e1");
        expect(await store.count()).toBe(1);
      });
    });

    describe("clear", () => {
      it("removes all entries", async () => {
        await store.add(createEntry("e1"));
        await store.add(createEntry("e2"));
        await store.add(createEntry("e3"));

        expect(await store.count()).toBe(3);

        await store.clear();

        expect(await store.count()).toBe(0);
        expect(await store.getAll()).toEqual([]);
      });
    });

    describe("data integrity", () => {
      it("preserves all fields", async () => {
        const now = Date.now();
        const entry: DlqEntry = {
          id: "e1",
          payload: { test: "data" },
          failureReason: "specific error message",
          attempts: 7,
          createdAt: now - 10000,
          lastAttemptAt: now - 5000,
        };

        await store.add(entry);
        const [retrieved] = await store.getAll();

        expect(retrieved.id).toBe(entry.id);
        expect(retrieved.payload).toEqual(entry.payload);
        expect(retrieved.failureReason).toBe(entry.failureReason);
        expect(retrieved.attempts).toBe(entry.attempts);
        expect(retrieved.createdAt).toBe(entry.createdAt);
        expect(retrieved.lastAttemptAt).toBe(entry.lastAttemptAt);
      });

      it("handles large payloads", async () => {
        const largePayload = {
          matchId: 1,
          data: "x".repeat(10000),
        };
        const entry = createEntry("e1", largePayload);
        await store.add(entry);

        const [retrieved] = await store.getAll();
        expect(retrieved.payload.data).toBe("x".repeat(10000));
      });

      it("handles complex nested payloads", async () => {
        const complexPayload = {
          level1: {
            level2: {
              level3: {
                value: 42,
                array: [1, 2, 3, { nested: true }],
              },
            },
          },
        };
        const entry = createEntry("e1", complexPayload);
        await store.add(entry);

        const [retrieved] = await store.getAll();
        expect(retrieved.payload).toEqual(complexPayload);
      });

      it("handles null and undefined in payload", async () => {
        const payload = {
          nullValue: null,
          undefinedValue: undefined,
          otherValue: "test",
        };
        const entry = createEntry("e1", payload);
        await store.add(entry);

        const [retrieved] = await store.getAll();
        // Note: JSON serialization converts undefined to null
        expect(retrieved.payload.nullValue).toBe(null);
        expect(retrieved.payload.otherValue).toBe("test");
      });
    });
  });
}

// Test in-memory store
testQueueStore(() => new InMemoryQueueStore());

// Test SQLite store
testQueueStore(() => {
  const dbPath = path.join("/tmp", `test-oracle-queue-${Date.now()}.db`);
  const store = new SQLiteQueueStore(dbPath);

  // Clean up after tests
  const originalClose = store.close.bind(store);
  store.close = async () => {
    await originalClose();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  };

  return store;
});

describe("Priority ordering (#2183)", () => {
  async function testPriorityOrdering(createStore: () => any) {
    let store: any;

    beforeEach(async () => {
      store = createStore();
      await store.initialize();
    });

    afterEach(async () => {
      await store.close();
    });

    const makeEntry = (id: string, priority?: DlqEntry["priority"], createdAt = Date.now()): DlqEntry => ({
      id,
      payload: { id },
      failureReason: "test",
      attempts: 0,
      createdAt,
      lastAttemptAt: null,
      priority,
    });

    it("returns high before medium before low regardless of insertion order", async () => {
      await store.add(makeEntry("low1", "low", 1000));
      await store.add(makeEntry("med1", "medium", 2000));
      await store.add(makeEntry("hi1", "high", 3000));

      const all = await store.getAll();
      expect(all.map((e: DlqEntry) => e.id)).toEqual(["hi1", "med1", "low1"]);
    });

    it("within the same priority level, orders by createdAt ascending", async () => {
      await store.add(makeEntry("hi2", "high", 2000));
      await store.add(makeEntry("hi1", "high", 1000));
      await store.add(makeEntry("hi3", "high", 3000));

      const all = await store.getAll();
      expect(all.map((e: DlqEntry) => e.id)).toEqual(["hi1", "hi2", "hi3"]);
    });

    it("treats entries with no priority as medium", async () => {
      await store.add(makeEntry("lo1", "low", 1000));
      await store.add(makeEntry("none", undefined, 2000));
      await store.add(makeEntry("hi1", "high", 3000));

      const all = await store.getAll();
      expect(all[0].id).toBe("hi1");
      // 'none' has implicit medium priority — before 'lo1'
      expect(all[1].id).toBe("none");
      expect(all[2].id).toBe("lo1");
    });

    it("preserves the priority field on round-trip", async () => {
      await store.add(makeEntry("h", "high"));
      await store.add(makeEntry("m", "medium"));
      await store.add(makeEntry("l", "low"));

      const all = await store.getAll();
      const byId: Record<string, DlqEntry> = {};
      for (const e of all) byId[e.id] = e;

      expect(byId["h"].priority).toBe("high");
      expect(byId["m"].priority).toBe("medium");
      expect(byId["l"].priority).toBe("low");
    });
  }

  describe("InMemoryQueueStore", () => {
    testPriorityOrdering(() => new InMemoryQueueStore());
  });

  describe("SQLiteQueueStore", () => {
    testPriorityOrdering(() => {
      const dbPath = path.join("/tmp", `test-priority-queue-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
      const store = new SQLiteQueueStore(dbPath);
      const originalClose = store.close.bind(store);
      store.close = async () => {
        await originalClose();
        for (const suffix of ["", "-wal", "-shm"]) {
          if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
        }
      };
      return store;
    });
  });

  describe("SQLiteQueueStore migration (pre-existing DB without priority column)", () => {
    it("adds the priority column to a database that pre-dates #2183", async () => {
      const dbPath = path.join("/tmp", `test-migration-queue-${Date.now()}.db`);

      // Create a bare-bones database without the priority column, simulating
      // a DB from before this feature was added.
      await new Promise<void>((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => err ? reject(err) : resolve());
        db.run(
          `CREATE TABLE oracle_dlq (
            id TEXT PRIMARY KEY NOT NULL,
            payload TEXT NOT NULL,
            failureReason TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            createdAt INTEGER NOT NULL,
            lastAttemptAt INTEGER,
            expireAt INTEGER NOT NULL
          )`,
          () => db.close(),
        );
      });

      // Insert a legacy row without priority.
      await new Promise<void>((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => err ? reject(err) : resolve());
        const expireAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
        db.run(
          `INSERT INTO oracle_dlq (id, payload, failureReason, attempts, createdAt, lastAttemptAt, expireAt)
           VALUES ('legacy1', '{}', 'rpc error', 0, ?, NULL, ?)`,
          [Date.now(), expireAt],
          () => db.close(),
        );
      });

      const store = new SQLiteQueueStore(dbPath);
      try {
        await store.initialize();
        const all = await store.getAll();
        expect(all).toHaveLength(1);
        // Legacy entry should come back with the default medium priority.
        expect(all[0].id).toBe("legacy1");
        expect(all[0].priority ?? "medium").toBe("medium");

        // New high-priority entry should sort before the legacy medium one.
        await store.add({
          id: "hi1",
          payload: {},
          failureReason: "test",
          attempts: 0,
          createdAt: Date.now(),
          lastAttemptAt: null,
          priority: "high",
        });
        const ordered = await store.getAll();
        expect(ordered[0].id).toBe("hi1");
        expect(ordered[1].id).toBe("legacy1");
      } finally {
        await store.close();
        for (const suffix of ["", "-wal", "-shm"]) {
          if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
        }
      }
    });
  });
});

describe("SQLite WAL mode", () => {
  it("enables WAL and allows reads during writes", async () => {
    const dbPath = path.join("/tmp", `test-oracle-queue-wal-${Date.now()}.db`);
    const store = new SQLiteQueueStore(dbPath);
    const writer = new sqlite3.Database(dbPath);
    const reader = new sqlite3.Database(dbPath);

    const run = (db: sqlite3.Database, sql: string) =>
      new Promise<void>((resolve, reject) => {
        db.run(sql, (err: Error | null) => (err ? reject(err) : resolve()));
      });
    const get = <T>(db: sqlite3.Database, sql: string) =>
      new Promise<T>((resolve, reject) => {
        db.get(sql, (err: Error | null, row: T) =>
          err ? reject(err) : resolve(row),
        );
      });
    const close = (db: sqlite3.Database) =>
      new Promise<void>((resolve, reject) => {
        db.close((err: Error | null) => (err ? reject(err) : resolve()));
      });

    try {
      await store.initialize();
      const journalMode = await get<{ journal_mode: string }>(
        reader,
        `PRAGMA journal_mode`,
      );
      expect(journalMode.journal_mode).toBe("wal");

      await run(writer, `BEGIN IMMEDIATE`);
      await expect(
        get<{ count: number }>(
          reader,
          `SELECT COUNT(*) AS count FROM oracle_dlq`,
        ),
      ).resolves.toEqual({ count: 0 });
      await run(writer, `ROLLBACK`);
    } finally {
      await store.close();
      await close(writer);
      await close(reader);
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
      if (fs.existsSync(`${dbPath}-wal`)) {
        fs.unlinkSync(`${dbPath}-wal`);
      }
      if (fs.existsSync(`${dbPath}-shm`)) {
        fs.unlinkSync(`${dbPath}-shm`);
      }
    }
  });
});
