/**
 * Tests for shared, SQLite-backed rate limiter counters (#1723).
 *
 * The key scenario the acceptance criteria calls out directly: two separate
 * backend instances (modeled here as two separate `SqliteRateLimitStore`
 * instances, each with its own sqlite3 connection) sharing the same
 * database file must enforce one global limit, not one limit per instance.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { SqliteRateLimitStore } from '../../src/store/sqlite-rate-limit-store.js';

function tmpDbPath(): string {
  return path.join(
    '/tmp',
    `test-rate-limit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('SqliteRateLimitStore', () => {
  let dbPath: string;
  let stores: SqliteRateLimitStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.map((s) => s.destroy().catch(() => undefined)));
    stores = [];
    if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  function makeStore(capacity: number, refillIntervalMs: number, refillAmount: number) {
    const store = new SqliteRateLimitStore(capacity, refillIntervalMs, refillAmount, dbPath);
    stores.push(store);
    return store;
  }

  it('allows requests up to capacity, then rejects', async () => {
    dbPath = tmpDbPath();
    const store = makeStore(3, 60_000, 3);
    await store.initialize();

    expect((await store.isAllowed('client-a')).allowed).toBe(true);
    expect((await store.isAllowed('client-a')).allowed).toBe(true);
    expect((await store.isAllowed('client-a')).allowed).toBe(true);
    const fourth = await store.isAllowed('client-a');
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('tracks separate clients independently', async () => {
    dbPath = tmpDbPath();
    const store = makeStore(1, 60_000, 1);
    await store.initialize();

    expect((await store.isAllowed('client-a')).allowed).toBe(true);
    expect((await store.isAllowed('client-a')).allowed).toBe(false);
    // A different client has its own untouched bucket.
    expect((await store.isAllowed('client-b')).allowed).toBe(true);
  });

  it('refills tokens over time', async () => {
    dbPath = tmpDbPath();
    const store = makeStore(1, 100, 1); // 1 token, refills fully every 100ms
    await store.initialize();

    expect((await store.isAllowed('client-a')).allowed).toBe(true);
    expect((await store.isAllowed('client-a')).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect((await store.isAllowed('client-a')).allowed).toBe(true);
  });

  // The acceptance-criteria scenario: the limit must hold *globally* across
  // multiple simulated backend instances sharing one store.
  it('enforces one global limit across two simulated backend instances sharing the same database file', async () => {
    dbPath = tmpDbPath();
    // Instance 1 creates the schema.
    const instance1 = makeStore(5, 60_000, 5);
    await instance1.initialize();

    // Instance 2: a separate SqliteRateLimitStore (separate sqlite3
    // connection, as a second process would have) pointed at the same file.
    const instance2 = makeStore(5, 60_000, 5);
    await instance2.initialize();

    const results: boolean[] = [];
    // Alternate requests between the two "instances" for the same client —
    // exactly the scenario a load balancer round-robining requests across
    // backend instances would produce.
    for (let i = 0; i < 5; i++) {
      results.push((await instance1.isAllowed('shared-client')).allowed);
      results.push((await instance2.isAllowed('shared-client')).allowed);
    }

    // 10 requests total against a capacity of 5: exactly 5 allowed, 5 rejected,
    // regardless of which "instance" happened to handle each one. If each
    // instance kept its own counter (the in-memory store's bug), all 10 would
    // be allowed (5 per instance).
    const allowedCount = results.filter(Boolean).length;
    expect(allowedCount).toBe(5);
    expect(results.filter((r) => !r).length).toBe(5);
  });

  it('getRemainingTokens reflects consumption made through a different store instance on the same file', async () => {
    dbPath = tmpDbPath();
    const instance1 = makeStore(10, 60_000, 10);
    await instance1.initialize();
    const instance2 = makeStore(10, 60_000, 10);
    await instance2.initialize();

    await instance1.isAllowed('shared-client');
    await instance1.isAllowed('shared-client');
    await instance1.isAllowed('shared-client');

    const remaining = await instance2.getRemainingTokens('shared-client');
    expect(remaining).toBeCloseTo(7, 0);
  });
});
