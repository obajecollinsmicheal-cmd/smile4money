/**
 * Persistent Queue Store Interface
 *
 * Defines the contract for storing oracle job queue entries durably.
 * Implementations can use MongoDB, PostgreSQL, SQLite, or other data stores.
 */

export interface DlqEntry {
  id: string;
  payload: unknown;
  failureReason: string;
  attempts: number;
  createdAt: number;
  lastAttemptAt: number | null;
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
