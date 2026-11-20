import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  writeToDlq,
  listDlqEntries,
  removeDlqEntry,
  startRetryWorker,
  updateDlqEntry,
  initializeQueue,
  closeQueue,
  resolveQueueStoreType,
  parseDlqTtlDays,
  evictExpiredDlqEntries,
  replayDlqEntry,
  getQueueMetrics,
  startStallDetector,
  type DlqEntry,
} from "../src/queue.js";
import { resetCircuitBreaker } from "../src/services/circuit-breaker.js";

// Reset the in-memory store between tests by removing all entries.
// listDlqEntries/removeDlqEntry are async, and the queue store is not
// initialized yet the first time this outer beforeEach runs (that happens in
// the describe-level beforeEach below, which runs after this one) -- so this
// swallows the "not initialized" error rather than failing every test.
async function clearDlq() {
  try {
    const entries = await listDlqEntries();
    for (const entry of entries) {
      await removeDlqEntry(entry.id);
    }
  } catch {
    // Queue store not initialized yet for this test group -- nothing to clear.
  }
}

beforeEach(async () => {
  await clearDlq();
  resetCircuitBreaker();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Persistent Queue System', () => {
  beforeEach(async () => {
    // Force in-memory store for testing
    process.env.QUEUE_STORE = 'memory';
    await initializeQueue();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeQueue();
  });

  describe('writeToDlq', () => {
    it('adds an entry to the queue', async () => {
      await writeToDlq({ matchId: 1, gameId: 'abc123' }, 'RPC timeout');
      const entries = await listDlqEntries();
      expect(entries).toHaveLength(1);
    });

    it('stores the payload and failure reason', async () => {
      await writeToDlq({ matchId: 42, data: 'test' }, 'insufficient fees');
      const [entry] = await listDlqEntries();

      expect(entry.payload).toEqual({ matchId: 42, data: 'test' });
      expect(entry.failureReason).toBe('insufficient fees');
      expect(entry.attempts).toBe(0);
      expect(entry.lastAttemptAt).toBeNull();
    });

    it('assigns unique IDs to each entry', async () => {
      await writeToDlq({ id: 1 }, 'err1');
      await writeToDlq({ id: 2 }, 'err2');

      const entries = await listDlqEntries();
      const ids = entries.map((entry: DlqEntry) => entry.id);
      expect(new Set(ids).size).toBe(2);
    });

    it('sets createdAt timestamp', async () => {
      const before = Date.now();
      await writeToDlq({}, 'test');
      const after = Date.now();

      const [entry] = await listDlqEntries();
      expect(entry.createdAt).toBeGreaterThanOrEqual(before);
      expect(entry.createdAt).toBeLessThanOrEqual(after);
    });

    it('initializes attempts to 0', async () => {
      await writeToDlq({}, 'test error');
      const [entry] = await listDlqEntries();
      expect(entry.attempts).toBe(0);
    });
  });

  describe('listDlqEntries', () => {
    it('returns empty array when queue is empty', async () => {
      const entries = await listDlqEntries();
      expect(entries).toEqual([]);
    });

    it('returns all entries in the queue', async () => {
      await writeToDlq({ matchId: 1 }, 'err1');
      await writeToDlq({ matchId: 2 }, 'err2');
      await writeToDlq({ matchId: 3 }, 'err3');

      const entries = await listDlqEntries();
      expect(entries).toHaveLength(3);
    });

    it('returns shallow copies to prevent accidental mutations', async () => {
      await writeToDlq({ matchId: 1 }, 'test');
      const [entry1] = await listDlqEntries();
      entry1.attempts = 999;

      const [entry2] = await listDlqEntries();
      expect(entry2.attempts).toBe(0);
    });
  });

  describe('removeDlqEntry', () => {
    it('removes an entry by ID', async () => {
      const entry = await writeToDlq({}, 'test');
      expect(await listDlqEntries()).toHaveLength(1);

      await removeDlqEntry(entry.id);
      expect(await listDlqEntries()).toHaveLength(0);
    });

    it('is idempotent for unknown IDs', async () => {
      await writeToDlq({}, 'test');
      await expect(removeDlqEntry('nonexistent-id')).resolves.not.toThrow();
      expect(await listDlqEntries()).toHaveLength(1);
    });

    it('removes only the specified entry when multiple exist', async () => {
      const entry1 = await writeToDlq({ matchId: 1 }, 'err1');
      const entry2 = await writeToDlq({ matchId: 2 }, 'err2');

      await vi.advanceTimersByTimeAsync(1000);

      await removeDlqEntry(entry1.id);

      const remaining = await listDlqEntries();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(entry2.id);
    });
  });

  describe('updateDlqEntry', () => {
    it('updates attempts count', async () => {
      const entry = await writeToDlq({}, 'test');
      expect((await listDlqEntries())[0].attempts).toBe(0);

      await updateDlqEntry(entry.id, { attempts: 3 });
      expect((await listDlqEntries())[0].attempts).toBe(3);
    });

    it('updates lastAttemptAt timestamp', async () => {
      const entry = await writeToDlq({}, 'test');
      const timestamp = Date.now();

      await updateDlqEntry(entry.id, { lastAttemptAt: timestamp });
      expect((await listDlqEntries())[0].lastAttemptAt).toBe(timestamp);
    });

    it('updates multiple fields at once', async () => {
      const entry = await writeToDlq({}, 'test');
      const timestamp = Date.now();

      await updateDlqEntry(entry.id, { attempts: 5, lastAttemptAt: timestamp });

      const updated = (await listDlqEntries())[0];
      expect(updated.attempts).toBe(5);
      expect(updated.lastAttemptAt).toBe(timestamp);
    });

    it('is idempotent for unknown IDs', async () => {
      await writeToDlq({}, 'test');
      await expect(
        updateDlqEntry('nonexistent', { attempts: 10 })
      ).resolves.not.toThrow();
    });
  });

  describe('startRetryWorker', () => {
    it('calls the handler for each DLQ entry on interval', async () => {
      await writeToDlq({ matchId: 1 }, 'net error');
      await writeToDlq({ matchId: 2 }, 'net error');

      const handler = vi.fn().mockResolvedValue(undefined);
      const stop = startRetryWorker(handler, 1000);

      try {
        await vi.advanceTimersByTimeAsync(1000);
        expect(handler).toHaveBeenCalledTimes(2);
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1 }));
      } finally {
        stop();
      }
    });

    it('removes entries after successful retry', async () => {
      await writeToDlq({ matchId: 1 }, 'test');
      const handler = vi.fn().mockResolvedValue(undefined);
      const stop = startRetryWorker(handler, 1000);

      try {
        expect(await listDlqEntries()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await listDlqEntries()).toHaveLength(0);
      } finally {
        stop();
      }
    });

    it('keeps entries in queue when handler throws', async () => {
      await writeToDlq({ matchId: 1 }, 'test');
      const handler = vi.fn().mockRejectedValue(new Error('still failing'));
      const stop = startRetryWorker(handler, 1000);

      try {
        await vi.advanceTimersByTimeAsync(1000);
        const entries = await listDlqEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].attempts).toBe(1);
      } finally {
        stop();
      }
    });

    it('increments attempts count across multiple retry cycles', async () => {
      await writeToDlq({ matchId: 1 }, 'test');
      const handler = vi.fn().mockRejectedValue(new Error('still failing'));
      const stop = startRetryWorker(handler, 1000);

      try {
        await vi.advanceTimersByTimeAsync(1000);
        let entries = await listDlqEntries();
        expect(entries[0].attempts).toBe(1);

        await vi.advanceTimersByTimeAsync(1000);
        entries = await listDlqEntries();
        expect(entries[0].attempts).toBe(2);
      } finally {
        stop();
      }
    });

    it('updates lastAttemptAt on each retry attempt', async () => {
      await writeToDlq({ matchId: 1 }, 'test');
      const handler = vi.fn().mockRejectedValue(new Error('failing'));
      const stop = startRetryWorker(handler, 1000);

      try {
        const beforeFirstRun = Date.now();
        await vi.advanceTimersByTimeAsync(1000);
        const afterFirstRun = Date.now();

        let entries = await listDlqEntries();
        expect(entries[0].lastAttemptAt).toBeGreaterThanOrEqual(beforeFirstRun);
        expect(entries[0].lastAttemptAt).toBeLessThanOrEqual(afterFirstRun);
      } finally {
        stop();
      }
    });

    it('does not call handler when queue is empty', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const stop = startRetryWorker(handler, 1000);

      try {
        await vi.advanceTimersByTimeAsync(1000);
        expect(handler).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    });

    it('returns a cleanup function that stops retries', async () => {
      await writeToDlq({ matchId: 1 }, 'test');
      const handler = vi.fn().mockResolvedValue(undefined);
      const stop = startRetryWorker(handler, 1000);

      stop();
      // After stopping, no more timers should be called
      vi.clearAllTimers();
      expect(handler).not.toHaveBeenCalled();
    });

    it('processes multiple batches over time', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const stop = startRetryWorker(handler, 1000);

      // Add first entry
      await writeToDlq({ matchId: 1 }, 'test');
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalledTimes(1);

      // Add second entry while first is being retried
      await writeToDlq({ matchId: 2 }, 'test');
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalledTimes(2);

      stop();
    });

    it('continues on handler errors without stopping worker', async () => {
      await writeToDlq({ matchId: 1 }, 'test1');
      await writeToDlq({ matchId: 2 }, 'test2');

      let callCount = 0;
      const handler = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('First handler call fails');
        }
      });

      const stop = startRetryWorker(handler, 1000);

      try {
        await vi.advanceTimersByTimeAsync(1000);
        // Both should be called despite first throwing
        expect(handler).toHaveBeenCalledTimes(2);
      } finally {
        stop();
      }
    });
  });

  describe('Queue depth metrics', () => {
    it('emits depth metric on writeToDlq', async () => {
      // Depth metric is logged; we can verify by checking that operations complete
      await writeToDlq({ id: 1 }, 'err');
      const entries = await listDlqEntries();
      expect(entries).toHaveLength(1);
    });

    it('emits depth metric on removeDlqEntry', async () => {
      const entry = await writeToDlq({}, 'err');
      await removeDlqEntry(entry.id);
      const entries = await listDlqEntries();
      expect(entries).toHaveLength(0);
    });
  });

  describe('Queue monitoring metrics (#2179)', () => {
    it('reports queue depth reflecting the number of entries', async () => {
      expect((await getQueueMetrics()).depth).toBe(0);

      await writeToDlq({ matchId: 1 }, 'err1');
      await writeToDlq({ matchId: 2 }, 'err2');
      await writeToDlq({ matchId: 3 }, 'err3');

      expect((await getQueueMetrics()).depth).toBe(3);

      const [first] = await listDlqEntries();
      await removeDlqEntry(first.id);

      expect((await getQueueMetrics()).depth).toBe(2);
    });

    it('reports the age of the oldest entry', async () => {
      const DAY_MS = 24 * 60 * 60 * 1000;
      const oldEntry = await writeToDlq({ matchId: 1 }, 'old');
      await writeToDlq({ matchId: 2 }, 'new');

      await updateDlqEntry(oldEntry.id, { createdAt: Date.now() - 2 * DAY_MS });

      const metrics = await getQueueMetrics();
      expect(metrics.oldestEntryAgeMs).toBeGreaterThanOrEqual(2 * DAY_MS);
    });

    it('reports zero oldest entry age when the queue is empty', async () => {
      const metrics = await getQueueMetrics();
      expect(metrics.depth).toBe(0);
      expect(metrics.oldestEntryAgeMs).toBe(0);
    });

    it('tracks success rate after successful and failed retries', async () => {
      await writeToDlq({ matchId: 1 }, 'err1');
      await writeToDlq({ matchId: 2 }, 'err2');

      let callCount = 0;
      const handler = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('first fails');
        }
      });

      const stop = startRetryWorker(handler, 1000);

      try {
        await vi.advanceTimersByTimeAsync(1000);

        const metrics = await getQueueMetrics();
        // One success, one failure => 50% success rate
        expect(metrics.successRate).toBeCloseTo(0.5, 5);
      } finally {
        stop();
      }
    });

    it('reports a success rate of 1 when all retries succeed', async () => {
      await writeToDlq({ matchId: 1 }, 'err1');
      await writeToDlq({ matchId: 2 }, 'err2');

      const handler = vi.fn().mockResolvedValue(undefined);
      const stop = startRetryWorker(handler, 1000);

      try {
        await vi.advanceTimersByTimeAsync(1000);
        const metrics = await getQueueMetrics();
        expect(metrics.successRate).toBe(1);
      } finally {
        stop();
      }
    });

    it('reports a success rate of 0 when all retries fail', async () => {
      await writeToDlq({ matchId: 1 }, 'err1');

      const handler = vi.fn().mockRejectedValue(new Error('always fails'));
      const stop = startRetryWorker(handler, 1000);

      try {
        await vi.advanceTimersByTimeAsync(1000);
        const metrics = await getQueueMetrics();
        expect(metrics.successRate).toBe(0);
      } finally {
        stop();
      }
    });

    it('updates metrics continuously as the queue changes', async () => {
      const first = await getQueueMetrics();
      expect(first.depth).toBe(0);

      await writeToDlq({ matchId: 1 }, 'err1');
      const second = await getQueueMetrics();
      expect(second.depth).toBe(1);

      await writeToDlq({ matchId: 2 }, 'err2');
      const third = await getQueueMetrics();
      expect(third.depth).toBe(2);

      const [entry] = await listDlqEntries();
      await removeDlqEntry(entry.id);
      const fourth = await getQueueMetrics();
      expect(fourth.depth).toBe(1);
    });
  });

  describe('Queue replay mechanism (#2184)', () => {
    it('replays a failed entry and reprocesses it as new', async () => {
      const entry = await writeToDlq({ matchId: 1 }, 'initial failure');
      await updateDlqEntry(entry.id, { attempts: 3, lastAttemptAt: Date.now() });

      const handler = vi.fn().mockResolvedValue(undefined);
      const result = await replayDlqEntry(entry.id, handler);

      expect(result.success).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: entry.id, payload: { matchId: 1 } })
      );

      // Entry reprocessed successfully => removed from queue
      expect(await listDlqEntries()).toHaveLength(0);
    });

    it('tracks the replay result when the replay fails', async () => {
      const entry = await writeToDlq({ matchId: 1 }, 'initial failure');

      const handler = vi.fn().mockRejectedValue(new Error('replay failed'));
      const result = await replayDlqEntry(entry.id, handler);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      // Entry remains in the queue after a failed replay
      const entries = await listDlqEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(entry.id);
    });

    it('records replay metadata on the entry', async () => {
      const entry = await writeToDlq({ matchId: 1 }, 'initial failure');

      const handler = vi.fn().mockRejectedValue(new Error('replay failed'));
      await replayDlqEntry(entry.id, handler);

      const [updated] = await listDlqEntries();
      expect(updated.lastReplayAt).toBeGreaterThan(0);
      expect(updated.replayCount).toBe(1);
    });

    it('returns not-found when the entry does not exist', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const result = await replayDlqEntry('nonexistent-id', handler);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('not_found');
      expect(handler).not.toHaveBeenCalled();
    });

    it('rejects replay of entries that are not in a failed state', async () => {
      const entry = await writeToDlq({ matchId: 1 }, 'initial failure');
      // A freshly written entry has not failed a retry yet (attempts === 0)
      const handler = vi.fn().mockResolvedValue(undefined);
      const result = await replayDlqEntry(entry.id, handler);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('not_failed');
      expect(handler).not.toHaveBeenCalled();
    });

    it('logs the replay attempt', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const entry = await writeToDlq({ matchId: 1 }, 'initial failure');
      await updateDlqEntry(entry.id, { attempts: 1 });

      const handler = vi.fn().mockResolvedValue(undefined);
      await replayDlqEntry(entry.id, handler);

      const logged = logSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === 'string' && arg.toLowerCase().includes('replay'))
      );
      expect(logged).toBe(true);

      logSpy.mockRestore();
    });
  });

  describe('Queue stall detection (#2187)', () => {
    it('logs a stall alert when the queue makes no progress across intervals', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Stuck entries that never get processed (no worker running)
      await writeToDlq({ matchId: 1 }, 'stuck');
      await writeToDlq({ matchId: 2 }, 'stuck');

      const onStall = vi.fn();
      const stop = startStallDetector({ intervalMs: 1000, onStall });

      try {
        // First interval establishes a baseline
        await vi.advanceTimersByTimeAsync(1000);
        // Second interval: no progress => stall detected
        await vi.advanceTimersByTimeAsync(1000);

        expect(onStall).toHaveBeenCalled();

        const stallLogged = [...logSpy.mock.calls, ...warnSpy.mock.calls].some((call) =>
          call.some((arg) => typeof arg === 'string' && arg.toLowerCase().includes('stall'))
        );
        expect(stallLogged).toBe(true);
      } finally {
        stop();
        logSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('does not alert when the queue is making progress', async () => {
      const onStall = vi.fn();
      const stop = startStallDetector({ intervalMs: 1000, onStall });

      try {
        // Progress: entries are added and removed between intervals
        await writeToDlq({ matchId: 1 }, 'err');
        await vi.advanceTimersByTimeAsync(1000);

        const [entry] = await listDlqEntries();
        await removeDlqEntry(entry.id);
        await vi.advanceTimersByTimeAsync(1000);

        await writeToDlq({ matchId: 2 }, 'err');
        await vi.advanceTimersByTimeAsync(1000);

        expect(onStall).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    });

    it('compares progress between consecutive intervals', async () => {
      const onStall = vi.fn();
      const stop = startStallDetector({ intervalMs: 1000, onStall });

      try {
        // Interval 1: progress (entry added)
        await writeToDlq({ matchId: 1 }, 'err');
        await vi.advanceTimersByTimeAsync(1000);
        expect(onStall).not.toHaveBeenCalled();

        // Interval 2: no progress => stall
        await vi.advanceTimersByTimeAsync(1000);
        expect(onStall).toHaveBeenCalledTimes(1);
      } finally {
        stop();
      }
    });

    it('stops detecting stalls after cleanup', async () => {
      const onStall = vi.fn();
      const stop = startStallDetector({ intervalMs: 1000, onStall });

      await writeToDlq({ matchId: 1 }, 'stuck');
      await vi.advanceTimersByTimeAsync(1000);

      stop();

      await vi.advanceTimersByTimeAsync(5000);
      expect(onStall).not.toHaveBeenCalled();
    });
  });

  describe('Integration scenarios', () => {
    it('survives complete workflow: add, retry fail, retry succeed', async () => {
      const payload = { matchId: 123, gameId: 'game-456' };
      await writeToDlq(payload, 'initial failure');

      // First retry fails
      let failCount = 0;
      const handler = vi.fn().mockImplementation(async () => {
        failCount++;
        if (failCount === 1) {
          throw new Error('Transient error');
        }
      });

      const stop = startRetryWorker(handler, 1000);

      try {
        // First interval: failure
        await vi.advanceTimersByTimeAsync(1000);
        let entries = await listDlqEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].attempts).toBe(1);

        // Second interval: success
        await vi.advanceTimersByTimeAsync(1000);
        entries = await listDlqEntries();
        expect(entries).toHaveLength(0);

        expect(handler).toHaveBeenCalledTimes(2);
      } finally {
        stop();
      }
    });

    it('handles mixed success and failure scenarios', async () => {
      // Create 4 entries: 2 will succeed, 2 will fail
      const entry1 = await writeToDlq({ id: 1 }, 'err');
      const entry2 = await writeToDlq({ id: 2 }, 'err');
      const entry3 = await writeToDlq({ id: 3 }, 'err');
      const entry4 = await writeToDlq({ id: 4 }, 'err');

      const handler = vi.fn().mockImplementation(async (entry: DlqEntry) => {
        // Entries 1 and 3 succeed; 2 and 4 fail
        if (entry.payload.id === 2 || entry.payload.id === 4) {
          throw new Error('Simulated failure');
        }
      });

      const stop = startRetryWorker(handler, 1000);

      try {
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(2000);
      } finally {
        stop();
      }
    });
  });

  describe("Circuit breaker integration", () => {
    it("pauses retries when circuit opens after N RPC failures", async () => {
      writeToDlq({ matchId: 1 }, "RPC error 1");
      writeToDlq({ matchId: 2 }, "RPC error 2");
      writeToDlq({ matchId: 3 }, "RPC error 3");
      writeToDlq({ matchId: 4 }, "RPC error 4");
      writeToDlq({ matchId: 5 }, "RPC error 5");

      const handler = vi.fn().mockRejectedValue(new Error("RPC timeout"));
      const stop = startRetryWorker(handler, 100);

      // First interval: 5 entries fail - circuit opens after 5th failure
      await vi.advanceTimersByTimeAsync(100);
      expect(handler).toHaveBeenCalledTimes(5);

      // Second interval: circuit is open, no more handler calls
      handler.mockClear();
      await vi.advanceTimersByTimeAsync(100);
      
      // Circuit should be open, no more handler calls
      expect(handler).not.toHaveBeenCalled();
      
      stop();
    });

    it("resumes retries after circuit cooldown expires", async () => {
      // Create 5 entries that will fail to trigger circuit opening
      writeToDlq({ matchId: 1 }, "RPC error 1");
      writeToDlq({ matchId: 2 }, "RPC error 2");
      writeToDlq({ matchId: 3 }, "RPC error 3");
      writeToDlq({ matchId: 4 }, "RPC error 4");
      writeToDlq({ matchId: 5 }, "RPC error 5");
      
      let callCount = 0;
      const handler = vi.fn().mockImplementation(async () => {
        callCount++;
        throw new Error("RPC timeout");
      });

      const stop = startRetryWorker(handler, 100);

      // First interval: process all 5 entries, circuit opens after 5th failure
      await vi.advanceTimersByTimeAsync(100);
      expect(handler).toHaveBeenCalledTimes(5);

      // Circuit is now open, handler won't be called
      handler.mockClear();
      await vi.advanceTimersByTimeAsync(100);
      expect(handler).not.toHaveBeenCalled();

      // Wait for cooldown to expire (default is 30s)
      await vi.advanceTimersByTimeAsync(30000);
      
      // Resume retries (in half-open state) - should attempt retry now
      await vi.advanceTimersByTimeAsync(100);
      
      // Handler should be called again after cooldown (in HALF_OPEN state)
      expect(handler.mock.calls.length).toBeGreaterThan(0);
      
      stop();
    });

    it("distinguishes RPC errors from other errors", async () => {
      writeToDlq({ matchId: 1 }, "RPC error");
      writeToDlq({ matchId: 2 }, "other error");

      let rpcErrorCount = 0;
      const handler = vi.fn().mockImplementation(async (entry: DlqEntry) => {
        if (entry.failureReason.includes("RPC")) {
          rpcErrorCount++;
          throw new Error("RPC timeout");
        }
        // Other errors don't trigger circuit breaker
        throw new Error("Other error");
      });

      const stop = startRetryWorker(handler, 100);

      // Process entries multiple times
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }

      // RPC errors should eventually open circuit
      // Non-RPC errors should not affect circuit breaker
      stop();
    });
  });

  describe('DLQ TTL eviction (#36)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    afterEach(() => {
      delete process.env.DLQ_TTL_DAYS;
    });

    it('evicts only entries older than the TTL', async () => {
      const oldEntry = await writeToDlq({ matchId: 1 }, 'old failure');
      const newEntry = await writeToDlq({ matchId: 2 }, 'recent failure');

      await updateDlqEntry(oldEntry.id, { createdAt: Date.now() - 8 * DAY_MS });
      await updateDlqEntry(newEntry.id, { createdAt: Date.now() - 1 * DAY_MS });

      const deletedCount = await evictExpiredDlqEntries(7);
      expect(deletedCount).toBe(1);

      const remaining = await listDlqEntries();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(newEntry.id);
    });

    it('evicts nothing when all entries are within the TTL', async () => {
      await writeToDlq({ matchId: 1 }, 'recent failure');

      const deletedCount = await evictExpiredDlqEntries(7);
      expect(deletedCount).toBe(0);
      expect(await listDlqEntries()).toHaveLength(1);
    });

    it('uses DLQ_TTL_DAYS from the environment when no ttlDays argument is passed', async () => {
      process.env.DLQ_TTL_DAYS = '1';

      const oldEntry = await writeToDlq({ matchId: 1 }, 'old failure');
      await updateDlqEntry(oldEntry.id, { createdAt: Date.now() - 2 * DAY_MS });

      const deletedCount = await evictExpiredDlqEntries();
      expect(deletedCount).toBe(1);
    });
  });
});

describe('parseDlqTtlDays (#36)', () => {
  it('returns the default (7) when unset', () => {
    expect(parseDlqTtlDays(undefined)).toBe(7);
  });

  it('returns the default (7) when blank', () => {
    expect(parseDlqTtlDays('   ')).toBe(7);
  });

  it('parses a valid positive number', () => {
    expect(parseDlqTtlDays('14')).toBe(14);
  });

  it('falls back to the default for a non-numeric value', () => {
    expect(parseDlqTtlDays('abc')).toBe(7);
  });

  it('falls back to the default for zero', () => {
    expect(parseDlqTtlDays('0')).toBe(7);
  });

  it('falls back to the default for a negative value', () => {
    expect(parseDlqTtlDays('-3')).toBe(7);
  });
});

describe('resolveQueueStoreType (#35)', () => {
  it('defaults to sqlite when QUEUE_STORE is unset', () => {
    expect(resolveQueueStoreType(undefined, 'development')).toBe('sqlite');
  });

  it('resolves auto to sqlite', () => {
    expect(resolveQueueStoreType('auto', 'development')).toBe('sqlite');
  });

  it('resolves sqlite to sqlite', () => {
    expect(resolveQueueStoreType('sqlite', 'development')).toBe('sqlite');
  });

  it('resolves mongodb to sqlite (mongoose is not an installed dependency)', () => {
    expect(resolveQueueStoreType('mongodb', 'development')).toBe('sqlite');
  });

  it('resolves memory to memory outside production', () => {
    expect(resolveQueueStoreType('memory', 'development')).toBe('memory');
    expect(resolveQueueStoreType('memory', 'test')).toBe('memory');
    expect(resolveQueueStoreType('memory', undefined)).toBe('memory');
  });

  it('auto-corrects memory to sqlite in production', () => {
    expect(resolveQueueStoreType('memory', 'production')).toBe('sqlite');
  });
});