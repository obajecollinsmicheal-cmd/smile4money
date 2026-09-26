/**
 * SQLite Persistent Queue Store
 *
 * Stores oracle job queue entries in SQLite with automatic cleanup of old entries.
 * Suitable for smaller deployments where MongoDB is not available.
 */
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export class SQLiteQueueStore {
    constructor(dbPath) {
        this.db = null;
        this.initialized = false;
        this.dbPath = dbPath || path.join(__dirname, '../../data/oracle-queue.db');
    }
    getDb() {
        if (!this.db) {
            throw new Error('SQLiteQueueStore not initialized. Call initialize() first.');
        }
        return this.db;
    }
    async initialize() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                // Create table if not exists
                this.db.run(`
          CREATE TABLE IF NOT EXISTS oracle_dlq (
            id TEXT PRIMARY KEY NOT NULL,
            payload TEXT NOT NULL,
            failureReason TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            createdAt INTEGER NOT NULL,
            lastAttemptAt INTEGER,
            expireAt INTEGER NOT NULL,
            CONSTRAINT expireAt_check CHECK (expireAt > 0)
          )
          `, (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    // Create index for efficient queries and TTL cleanup
                    this.db.run(`CREATE INDEX IF NOT EXISTS idx_oracle_dlq_expireAt ON oracle_dlq(expireAt)`, (err) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        this.initialized = true;
                        resolve();
                    });
                });
            });
        });
    }
    async add(entry) {
        return new Promise((resolve, reject) => {
            const expireAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
            this.getDb().run(`
        INSERT INTO oracle_dlq (id, payload, failureReason, attempts, createdAt, lastAttemptAt, expireAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
                entry.id,
                JSON.stringify(entry.payload),
                entry.failureReason,
                entry.attempts,
                entry.createdAt,
                entry.lastAttemptAt,
                expireAt,
            ], (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    async getAll() {
        return new Promise((resolve, reject) => {
            // Delete expired entries
            this.getDb().run(`DELETE FROM oracle_dlq WHERE expireAt < ?`, [Date.now()], (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                // Fetch remaining entries
                this.getDb().all(`SELECT * FROM oracle_dlq ORDER BY createdAt ASC`, (err, rows) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    const entries = (rows || []).map((row) => ({
                        id: row.id,
                        payload: JSON.parse(row.payload),
                        failureReason: row.failureReason,
                        attempts: row.attempts,
                        createdAt: row.createdAt,
                        lastAttemptAt: row.lastAttemptAt || null,
                    }));
                    resolve(entries);
                });
            });
        });
    }
    async remove(id) {
        return new Promise((resolve, reject) => {
            this.getDb().run(`DELETE FROM oracle_dlq WHERE id = ?`, [id], (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    async update(id, updates) {
        return new Promise((resolve, reject) => {
            const setClauses = [];
            const values = [];
            if (updates.attempts !== undefined) {
                setClauses.push('attempts = ?');
                values.push(updates.attempts);
            }
            if (updates.lastAttemptAt !== undefined) {
                setClauses.push('lastAttemptAt = ?');
                values.push(updates.lastAttemptAt);
            }
            if (setClauses.length === 0) {
                resolve();
                return;
            }
            values.push(id);
            this.getDb().run(`UPDATE oracle_dlq SET ${setClauses.join(', ')} WHERE id = ?`, values, (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    async count() {
        return new Promise((resolve, reject) => {
            this.getDb().get(`SELECT COUNT(*) as count FROM oracle_dlq WHERE expireAt > ?`, [Date.now()], (err, row) => {
                if (err)
                    reject(err);
                else
                    resolve(row?.count || 0);
            });
        });
    }
    async clear() {
        return new Promise((resolve, reject) => {
            this.getDb().run(`DELETE FROM oracle_dlq`, (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    async close() {
        return new Promise((resolve, reject) => {
            if (this.db) {
                this.db.close((err) => {
                    if (err)
                        reject(err);
                    else {
                        this.db = null;
                        resolve();
                    }
                });
            }
            else {
                resolve();
            }
        });
    }
}
