/**
 * Persistent Queue Store Interface
 *
 * Defines the contract for storing oracle job queue entries durably.
 * Implementations can use MongoDB, PostgreSQL, SQLite, or other data stores.
 */

import type { PersistedTraceContext } from "../tracing/trace-context.js";

/** Processing urgency for a DLQ entry. High-priority entries are processed before medium, medium before low. */
export type JobPriority = "high" | "medium" | "low";

/** Numeric weight used for in-process sorting: lower number = processed first. */
export const PRIORITY_ORDER: Record<JobPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export interface DlqEntry {
  id: string;
  payload: unknown;
  failureReason: string;
  attempts: number;
  createdAt: number;
  lastAttemptAt: number | null;
  /**
   * Processing priority for this entry. High-priority entries are dequeued
   * before medium, and medium before low. Defaults to 'medium' when absent
   * (entries written before this field existed are treated as medium).
   */
  priority?: JobPriority;
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
   * Implementations must ensure this is atomic and durable.
   */
  add(entry: DlqEntry): Promise<void>;

  /**
   * Retrieve all entries from the queue.
   * Should return shallow copies to prevent accidental mutations.
   */
  getAll(): Promise<DlqEntry[]>;

  /**
   * Remove an entry by ID.
   * Should be idempotent (safe to call for non-existent IDs).
   */
  remove(id: string): Promise<void>;

  /**
   * Update an entry (used to record retry attempts).
   * Merges the provided fields with the existing entry.
   */
  update(id: string, updates: Partial<DlqEntry>): Promise<void>;

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
