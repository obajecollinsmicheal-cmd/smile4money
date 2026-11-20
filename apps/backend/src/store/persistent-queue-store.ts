/**
 * Persistent Queue Store Interface
 *
 * Defines the contract for storing oracle job queue entries durably.
 * Implementations can use MongoDB, PostgreSQL, SQLite, or other data stores.
 */

import type { PersistedTraceContext } from "../tracing/trace-context.js";

export interface DlqEntry {
  id: string;
  payload: unknown;
  failureReason: string;
  attempts: number;
  createdAt: number;
  lastAttemptAt: number | null;
  /**
   * W3C trace context the entry was queued under (#123), resumed as a child
   * span on every retry. Holds only `traceparent`/`tracestate`: random ids and
   * a sanitised vendor list, never payload data or credentials. Absent on
   * entries written before this field existed.
   */
  traceContext?: PersistedTraceContext;
}

export interface PersistentQueueStore {
  /**
   * Write an entry to the queue.
   * Implementations must ensure this is atomic and durable: once the promise
   * resolves the entry must survive a process restart.
   */
  add(entry: DlqEntry): Promise<void>;

  /**
   * Retrieve all entries from the queue.
   * Should return shallow copies to prevent accidental mutations.
   * Must reflect all durably persisted entries.
   */
  getAll(): Promise<DlqEntry[]>;

  /**
   * Remove an entry by ID.
   * Should be idempotent (safe to call for non-existent IDs).
   * The removal must be durable once the promise resolves.
   */
  remove(id: string): Promise<void>;

  /**
   * Update an entry (used to record retry attempts).
   * Merges the provided fields with the existing entry.
   * The update must be durable once the promise resolves.
   */
  update(id: string, updates: Partial<DlqEntry>): Promise<void>;

  /**
   * Delete all entries whose `createdAt` is older than the given cutoff
   * (epoch milliseconds). Used by the DLQ TTL expiration job.
   * Returns the number of entries deleted. Deletions must be durable.
   */
  deleteExpired(olderThanMs: number): Promise<number>;

  /**
   * Get count of entries in the queue.
   */
  count(): Promise<number>;

  /**
   * Clear all entries (useful for testing and manual intervention).
   */
  clear(): Promise<void>;

  /**
   * Initialize the store (create tables, indices, etc.).
   * Called on application startup.
   */
  initialize(): Promise<void>;

  /**
   * Close the store connection(s).
   * Called on application shutdown.
   */
  close(): Promise<void>;
}
