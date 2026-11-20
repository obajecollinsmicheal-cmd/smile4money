/**
 * In-Memory Persistent Queue Store (fallback for development)
 *
 * WARNING: This is NOT suitable for production. Use MongoDB or SQLite instead.
 * Data is lost on process exit.
 */

import type { DlqEntry, PersistentQueueStore } from './persistent-queue-store.js';
import { PRIORITY_ORDER } from './persistent-queue-store.js';

export class InMemoryQueueStore implements PersistentQueueStore {
  private store = new Map<string, DlqEntry>();

  async add(entry: DlqEntry): Promise<void> {
    this.store.set(entry.id, { ...entry });
  }

  async getAll(): Promise<DlqEntry[]> {
    return Array.from(this.store.values())
      .map((e) => ({ ...e }))
      .sort((a, b) => {
        const pa = PRIORITY_ORDER[a.priority ?? 'medium'];
        const pb = PRIORITY_ORDER[b.priority ?? 'medium'];
        if (pa !== pb) return pa - pb;
        return a.createdAt - b.createdAt;
      });
  }

  async remove(id: string): Promise<void> {
    this.store.delete(id);
  }

  async update(id: string, updates: Partial<DlqEntry>): Promise<void> {
    const existing = this.store.get(id);
    if (existing) {
      this.store.set(id, { ...existing, ...updates });
    }
  }

  async count(): Promise<number> {
    return this.store.size;
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async initialize(): Promise<void> {
    // No-op for in-memory store
  }

  async close(): Promise<void> {
    // No-op for in-memory store
  }
}
