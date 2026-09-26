/**
 * In-Memory Persistent Queue Store (fallback for development)
 *
 * WARNING: This is NOT suitable for production. Use MongoDB or SQLite instead.
 * Data is lost on process exit.
 */
export class InMemoryQueueStore {
    constructor() {
        this.store = new Map();
    }
    async add(entry) {
        this.store.set(entry.id, { ...entry });
    }
    async getAll() {
        return Array.from(this.store.values()).map((e) => ({ ...e }));
    }
    async remove(id) {
        this.store.delete(id);
    }
    async update(id, updates) {
        const existing = this.store.get(id);
        if (existing) {
            this.store.set(id, { ...existing, ...updates });
        }
    }
    async count() {
        return this.store.size;
    }
    async clear() {
        this.store.clear();
    }
    async initialize() {
        // No-op for in-memory store
    }
    async close() {
        // No-op for in-memory store
    }
}
