/**
 * Tests for circuit breaker state persistence (#1716):
 * - SqliteCircuitBreakerStore save/load round-trips the exact snapshot.
 * - initializeCircuitBreaker restores state across a simulated restart
 *   (a fresh CircuitBreaker + a fresh SqliteCircuitBreakerStore instance
 *   pointed at the same on-disk database, mirroring a real process restart).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { SqliteCircuitBreakerStore } from '../../src/store/sqlite-circuit-breaker-store.js';
import {
  CircuitState,
  initializeCircuitBreaker,
  resetCircuitBreaker,
} from '../../src/services/circuit-breaker.js';

function tmpDbPath(): string {
  return path.join(
    '/tmp',
    `test-circuit-breaker-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('SqliteCircuitBreakerStore', () => {
  let dbPath: string;
  let store: SqliteCircuitBreakerStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new SqliteCircuitBreakerStore(dbPath);
  });

  afterEach(async () => {
    await store.close().catch(() => undefined);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('load() returns null before anything has been saved', async () => {
    await store.initialize();
    expect(await store.load()).toBeNull();
  });

  it('save() then load() round-trips the exact snapshot', async () => {
    await store.initialize();

    await store.save({
      state: CircuitState.OPEN,
      failureCount: 5,
      successCount: 0,
      lastFailureTime: 1_700_000_000_000,
      openedAt: 1_700_000_000_500,
      attemptCount: 2,
    });

    const loaded = await store.load();
    expect(loaded).toEqual({
      state: CircuitState.OPEN,
      failureCount: 5,
      successCount: 0,
      lastFailureTime: 1_700_000_000_000,
      openedAt: 1_700_000_000_500,
      attemptCount: 2,
    });
  });

  it('save() overwrites the previous snapshot (single row)', async () => {
    await store.initialize();

    await store.save({
      state: CircuitState.CLOSED,
      failureCount: 1,
      successCount: 0,
      lastFailureTime: null,
      openedAt: null,
      attemptCount: 0,
    });
    await store.save({
      state: CircuitState.OPEN,
      failureCount: 5,
      successCount: 0,
      lastFailureTime: 123,
      openedAt: 456,
      attemptCount: 1,
    });

    const loaded = await store.load();
    expect(loaded?.state).toBe(CircuitState.OPEN);
    expect(loaded?.failureCount).toBe(5);
  });

  it('correctly round-trips null lastFailureTime/openedAt for a fresh CLOSED breaker', async () => {
    await store.initialize();

    await store.save({
      state: CircuitState.CLOSED,
      failureCount: 0,
      successCount: 0,
      lastFailureTime: null,
      openedAt: null,
      attemptCount: 0,
    });

    const loaded = await store.load();
    expect(loaded?.lastFailureTime).toBeNull();
    expect(loaded?.openedAt).toBeNull();
  });
});

describe('initializeCircuitBreaker restoration across a restart (#1716)', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    resetCircuitBreaker();
  });

  afterEach(async () => {
    resetCircuitBreaker();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('a fresh process (no persisted state) starts CLOSED', async () => {
    const store = new SqliteCircuitBreakerStore(dbPath);
    const breaker = await initializeCircuitBreaker(undefined, store);

    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    await store.close();
  });

  it('restores an OPEN breaker across two separate process instances sharing the same db file', async () => {
    // "Process 1": opens the circuit and persists it.
    const store1 = new SqliteCircuitBreakerStore(dbPath);
    const breaker1 = await initializeCircuitBreaker(
      { failureThreshold: 2, cooldownMs: 60_000, backoffMultiplier: 2, maxCooldownMs: 600_000, successThreshold: 2 },
      store1,
    );
    breaker1.recordFailure();
    breaker1.recordFailure();
    expect(breaker1.getState()).toBe(CircuitState.OPEN);

    // Give the fire-and-forget persistence a tick to land before "restarting".
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store1.close();

    // "Process 2": a brand new store + breaker pointed at the same db file,
    // simulating a backend restart while the upstream RPC is still down.
    resetCircuitBreaker();
    const store2 = new SqliteCircuitBreakerStore(dbPath);
    const breaker2 = await initializeCircuitBreaker(
      { failureThreshold: 2, cooldownMs: 60_000, backoffMultiplier: 2, maxCooldownMs: 600_000, successThreshold: 2 },
      store2,
    );

    // The whole point of #1716: restarting while the persisted cooldown
    // (60s) has not elapsed must resume OPEN, not silently reset to CLOSED
    // and let a burst of requests through against a known-bad endpoint.
    expect(breaker2.getState()).toBe(CircuitState.OPEN);
    expect(breaker2.allowRequest()).toBe(false);

    await store2.close();
  });

  it('discards a stale persisted OPEN state and restarts CLOSED', async () => {
    const store1 = new SqliteCircuitBreakerStore(dbPath);
    await store1.initialize();
    // Simulate a breaker that opened long enough ago that its (short) cooldown
    // has already elapsed by the time the process restarts.
    await store1.save({
      state: CircuitState.OPEN,
      failureCount: 5,
      successCount: 0,
      lastFailureTime: Date.now() - 120_000,
      openedAt: Date.now() - 120_000,
      attemptCount: 0,
    });
    await store1.close();

    const store2 = new SqliteCircuitBreakerStore(dbPath);
    const breaker2 = await initializeCircuitBreaker(
      { failureThreshold: 2, cooldownMs: 30_000, backoffMultiplier: 2, maxCooldownMs: 600_000, successThreshold: 2 },
      store2,
    );

    expect(breaker2.getState()).toBe(CircuitState.CLOSED);
    expect(breaker2.getFailureCount()).toBe(0);
    expect(breaker2.allowRequest()).toBe(true);

    await store2.close();
  });
});
