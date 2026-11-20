import { sqliteSettings, configureSqlite } from "./sqlite-config.js";
import { applySqliteMigrations } from "./sqlite-migrations.js";
/**
 * SQLite Persistent Queue Store
 *
 * Stores oracle job queue entries in SQLite with automatic cleanup of old entries.
 * Suitable for smaller deployments where MongoDB is not available.
 *
 * Every database call is wrapped with retry + exponential backoff (#52):
 * if another process holds the SQLite file lock (e.g. a backup script
 * running `sqlite3 .backup` or a concurrent writer), a query fails with
 * SQLITE_BUSY/SQLITE_LOCKED rather than blocking. Previously that error
 * propagated straight to the caller with the underlying SQLite error code
 * discarded, which surfaced as an opaque, unlogged crash. Now it's retried
 * a configurable number of times with the error logged before each retry,
 * and only re-thrown once retries are exhausted (or the error isn't a
 * lock-contention error to begin with).
 */

import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import type {
  DlqEntry,
  PersistentQueueStore,
} from "./persistent-queue-store.js";
import logger from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** SQLite error codes that mean "another connection holds the lock right now" — worth retrying, not a real failure. */
const RETRYABLE_SQLITE_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);

/** Default number of retry attempts after the initial try, before giving up. Overridable via SQLITE_MAX_RETRIES. */
const DEFAULT_MAX_RETRIES = 5;
/** Base delay for exponential backoff (doubles each attempt: 50ms, 100ms, 200ms, ...). Overridable via SQLITE_RETRY_BASE_DELAY_MS. */
const DEFAULT_BASE_DELAY_MS = 50;

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getMaxRetries(): number {
  return readPositiveInt(process.env.SQLITE_MAX_RETRIES, DEFAULT_MAX_RETRIES);
}

function getRetryBaseDelayMs(): number {
  return readPositiveInt(
    process.env.SQLITE_RETRY_BASE_DELAY_MS,
    DEFAULT_BASE_DELAY_MS,
  );
}

export interface SqliteError extends Error {
  code?: string;
  errno?: number;
}

/** Exported for direct unit testing (#52). */
export function isRetryableSqliteError(err: unknown): err is SqliteError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as SqliteError).code === "string" &&
    RETRYABLE_SQLITE_CODES.has((err as SqliteError).code as string)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs a single sqlite3 call (anything shaped like `(cb) => db.run(sql, params, cb)`)
 * with retry + exponential backoff on SQLITE_BUSY/SQLITE_LOCKED.
 *
 * `operationName` is purely for the log line, so a retried/failed operation
 * is identifiable (e.g. "add", "getAll:deleteExpired"). Exported for direct
 * unit testing (#52).
 */
export async function withRetry<T>(
  operationName: string,
  operation: (callback: (err: Error | null, result?: T) => void) => void,
): Promise<T> {
  const maxRetries = getMaxRetries();
  const baseDelayMs = getRetryBaseDelayMs();

  let attempt = 0;
  for (;;) {
    try {
      return await new Promise<T>((resolve, reject) => {
        operation((err, result) => {
          if (err) reject(err);
          else resolve(result as T);
        });
      });
    } catch (err) {
      if (!isRetryableSqliteError(err) || attempt >= maxRetries) {
        throw err;
      }

      attempt += 1;
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn(
        {
          operation: operationName,
          sqlite_error_code: err.code,
          sqlite_error_message: err.message,
          attempt,
          max_retries: maxRetries,
          retry_delay_ms: delayMs,
        },
        "sqlite_operation_retrying",
      );
      await sleep(delayMs);
    }
  }
}

export class SQLiteQueueStore implements PersistentQueueStore {
  private db: sqlite3.Database | null = null;
  private dbPath: string;
  private initialized = false;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(__dirname, "../../data/oracle-queue.db");
  }

  private getDb(): sqlite3.Database {
    if (!this.db) {
      throw new Error(
        "SQLiteQueueStore not initialized. Call initialize() first.",
      );
    }
    return this.db;
  }

  async initialize(): Promise<void> {
    sqliteSettings();
    // Ensure the data directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await new Promise<void>((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await configureSqlite(this.getDb());

    // Versioned schema: creates/upgrades the dlq_entries table and its
    // indexes, recording the applied version in schema_migrations.
    await applySqliteMigrations(this.getDb());

    this.initialized = true;
  }

  async add(entry: DlqEntry): Promise<void> {
    await withRetry<void>("add", (cb) =>
      this.getDb().run(
        `
        INSERT INTO dlq_entries (id, payload, failure_reason, attempts, created_at, last_attempt_at, trace_context)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          entry.id,
          JSON.stringify(entry.payload),
          entry.failureReason,
          entry.attempts,
          entry.createdAt,
          entry.lastAttemptAt ?? null,
          entry.traceContext ? JSON.stringify(entry.traceContext) : null,
        ],
        (err: Error | null) => cb(err),
      ),
    );
  }

  async getAll(): Promise<DlqEntry[]> {
    const rows = await withRetry<any[]>("getAll:select", (cb) =>
      this.getDb().all(
        `SELECT * FROM dlq_entries ORDER BY created_at ASC, id ASC`,
        (err: Error | null, result: any[]) => cb(err, result),
      ),
    );

    return (rows || []).map((row) => this.rowToEntry(row));
  }

  async remove(id: string): Promise<void> {
    await withRetry<void>("remove", (cb) =>
      this.getDb().run(
        `DELETE FROM dlq_entries WHERE id = ?`,
        [id],
        (err: Error | null) => cb(err),
      ),
    );
  }

  async update(id: string, updates: Partial<DlqEntry>): Promise<void> {
    const setClauses: string[] = [];
    const values: any[] = [];

    if (updates.attempts !== undefined) {
      setClauses.push("attempts = ?");
      values.push(updates.attempts);
    }
    if (updates.lastAttemptAt !== undefined) {
      setClauses.push("last_attempt_at = ?");
      values.push(updates.lastAttemptAt);
    }
    if (updates.failureReason !== undefined) {
      setClauses.push("failure_reason = ?");
      values.push(updates.failureReason);
    }
    if (updates.payload !== undefined) {
      setClauses.push("payload = ?");
      values.push(JSON.stringify(updates.payload));
    }
    if (updates.traceContext !== undefined) {
      setClauses.push("trace_context = ?");
      values.push(
        updates.traceContext ? JSON.stringify(updates.traceContext) : null,
      );
    }

    if (setClauses.length === 0) {
      return;
    }

    values.push(id);

    await withRetry<void>("update", (cb) =>
      this.getDb().run(
        `UPDATE dlq_entries SET ${setClauses.join(", ")} WHERE id = ?`,
        values,
        (err: Error | null) => cb(err),
      ),
    );
  }

  async count(): Promise<number> {
    const row = await withRetry<any>("count", (cb) =>
      this.getDb().get(
        `SELECT COUNT(*) as count FROM dlq_entries`,
        (err: Error | null, result: any) => cb(err, result),
      ),
    );
    return row?.count || 0;
  }

  async clear(): Promise<void> {
    await withRetry<void>("clear", (cb) =>
      this.getDb().run(`DELETE FROM dlq_entries`, (err: Error | null) =>
        cb(err),
      ),
    );
  }

  /**
   * Deletes entries created before `olderThanMs` (epoch millis) and returns
   * the number of rows removed. Used by the periodic DLQ expiration job.
   */
  async deleteExpired(olderThanMs: number): Promise<number> {
    const deleted = await withRetry<number>("deleteExpired", (cb) =>
      this.getDb().run(
        `DELETE FROM dlq_entries WHERE created_at < ?`,
        [olderThanMs],
        function (this: sqlite3.RunResult, err: Error | null) {
          cb(err, this?.changes);
        },
      ),
    );
    return deleted ?? 0;
  }

  private rowToEntry(row: any): DlqEntry {
    return {
      id: row.id,
      payload: JSON.parse(row.payload),
      failureReason: row.failure_reason,
      attempts: row.attempts,
      createdAt: row.created_at,
      lastAttemptAt: row.last_attempt_at ?? null,
      ...(row.trace_context
        ? { traceContext: JSON.parse(row.trace_context) }
        : {}),
    };
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err: Error | null) => {
          if (err) reject(err);
          else {
            this.db = null;
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
}
