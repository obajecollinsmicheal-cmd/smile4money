/**
 * Tests for RATE_LIMIT_STORE backend selection (#1723).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import {
  resolveRateLimitStoreType,
  createRateLimitStore,
} from '../src/middleware/rate-limit.js';
import { RateLimitStore } from '../src/middleware/rate-limit.js';
import { SqliteRateLimitStore } from '../src/store/sqlite-rate-limit-store.js';

describe('resolveRateLimitStoreType', () => {
  it('defaults to memory when unset', () => {
    expect(resolveRateLimitStoreType(undefined)).toBe('memory');
  });

  it('resolves "memory" to memory', () => {
    expect(resolveRateLimitStoreType('memory')).toBe('memory');
  });

  it('resolves "sqlite" to sqlite', () => {
    expect(resolveRateLimitStoreType('sqlite')).toBe('sqlite');
  });

  it('resolves "redis" to sqlite (not yet implemented, falls back)', () => {
    expect(resolveRateLimitStoreType('redis')).toBe('sqlite');
  });

  it('is case-insensitive', () => {
    expect(resolveRateLimitStoreType('SQLITE')).toBe('sqlite');
  });
});

describe('createRateLimitStore', () => {
  const dbPath = `/tmp/test-rate-limit-factory-${Date.now()}.db`;
  let created: Array<{ destroy: () => Promise<void> | void }> = [];

  afterEach(async () => {
    for (const store of created) {
      await store.destroy();
    }
    created = [];
    delete process.env.RATE_LIMIT_STORE;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('returns an in-memory RateLimitStore by default', async () => {
    delete process.env.RATE_LIMIT_STORE;
    const store = await createRateLimitStore(10, 60_000, 10);
    created.push(store);
    expect(store).toBeInstanceOf(RateLimitStore);
  });

  it('returns an initialized SqliteRateLimitStore when RATE_LIMIT_STORE=sqlite', async () => {
    process.env.RATE_LIMIT_STORE = 'sqlite';
    const store = await createRateLimitStore(10, 60_000, 10, dbPath);
    created.push(store);
    expect(store).toBeInstanceOf(SqliteRateLimitStore);

    // Confirm it's actually usable (initialize() was called by the factory).
    const result = await store.isAllowed('client-a');
    expect(result.allowed).toBe(true);
  });
});
