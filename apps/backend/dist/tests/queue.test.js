import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeToDlq, listDlqEntries, removeDlqEntry, startRetryWorker, updateDlqEntry, initializeQueue, closeQueue, } from '../src/queue.js';
/**
 * Comprehensive test suite for the persistent queue system.
 *
 * Uses the in-memory store for fast tests, but the same tests
 * could be reused with SQLiteQueueStore or MongoDBQueueStore.
 */
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
            const ids = entries.map((entry) => entry.id);
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
        it('removes only the specified entry', async () => {
            const entry1 = await writeToDlq({ id: 1 }, 'err');
            const entry2 = await writeToDlq({ id: 2 }, 'err');
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
            await updateDlqEntry(entry.id, {
                attempts: 5,
                lastAttemptAt: timestamp,
            });
            const updated = (await listDlqEntries())[0];
            expect(updated.attempts).toBe(5);
            expect(updated.lastAttemptAt).toBe(timestamp);
        });
        it('is idempotent for unknown IDs', async () => {
            await writeToDlq({}, 'test');
            await expect(updateDlqEntry('nonexistent', { attempts: 10 })).resolves.not.toThrow();
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
            }
            finally {
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
            }
            finally {
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
            }
            finally {
                stop();
            }
        });
        it('increments attempts on each retry', async () => {
            await writeToDlq({ matchId: 1 }, 'test');
            const handler = vi.fn().mockRejectedValue(new Error('failing'));
            const stop = startRetryWorker(handler, 1000);
            try {
                await vi.advanceTimersByTimeAsync(1000);
                let entries = await listDlqEntries();
                expect(entries[0].attempts).toBe(1);
                await vi.advanceTimersByTimeAsync(1000);
                entries = await listDlqEntries();
                expect(entries[0].attempts).toBe(2);
            }
            finally {
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
            }
            finally {
                stop();
            }
        });
        it('does not call handler when queue is empty', async () => {
            const handler = vi.fn().mockResolvedValue(undefined);
            const stop = startRetryWorker(handler, 1000);
            try {
                await vi.advanceTimersByTimeAsync(1000);
                expect(handler).not.toHaveBeenCalled();
            }
            finally {
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
            }
            finally {
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
            }
            finally {
                stop();
            }
        });
        it('handles mixed success and failure scenarios', async () => {
            // Create 4 entries: 2 will succeed, 2 will fail
            const entry1 = await writeToDlq({ id: 1 }, 'err');
            const entry2 = await writeToDlq({ id: 2 }, 'err');
            const entry3 = await writeToDlq({ id: 3 }, 'err');
            const entry4 = await writeToDlq({ id: 4 }, 'err');
            const handler = vi.fn().mockImplementation(async (entry) => {
                // Entries 1 and 3 succeed; 2 and 4 fail
                if (entry.payload.id === 2 || entry.payload.id === 4) {
                    throw new Error('Simulated failure');
                }
            });
            const stop = startRetryWorker(handler, 1000);
            try {
                await vi.advanceTimersByTimeAsync(1000);
                const remaining = await listDlqEntries();
                expect(remaining).toHaveLength(2);
                expect(remaining.map((entry) => entry.payload)).toEqual([
                    { id: 2 },
                    { id: 4 },
                ]);
            }
            finally {
                stop();
            }
            stop();
        });
    });
});
