'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 1;
const DEFAULT_DLQ_TTL_DAYS = 30;
const DEFAULT_EXPIRATION_INTERVAL_MS = 60 * 60 * 1000;

function resolveTtlDays(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_DLQ_TTL_DAYS;
}

class DeadLetterQueue {
  constructor(options = {}) {
    const dbPath = options.dbPath || path.join(process.cwd(), 'data', 'dlq.sqlite');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this._migrate();
    this._insertStmt = this.db.prepare(
      'INSERT INTO dlq_entries (job_id, queue, payload, error, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this._listStmt = this.db.prepare('SELECT * FROM dlq_entries ORDER BY id ASC');
    this._getStmt = this.db.prepare('SELECT * FROM dlq_entries WHERE id = ?');
    this._deleteStmt = this.db.prepare('DELETE FROM dlq_entries WHERE id = ?');
    this._countStmt = this.db.prepare('SELECT COUNT(*) AS count FROM dlq_entries');
    this._expireStmt = this.db.prepare('DELETE FROM dlq_entries WHERE created_at < ?');

    this.ttlDays = resolveTtlDays(options.ttlDays ?? process.env.DLQ_TTL_DAYS);
    this.logger = options.logger || console;
    this._expirationTimer = null;
    this._expirationIntervalMs = options.expirationIntervalMs || DEFAULT_EXPIRATION_INTERVAL_MS;

    if (options.autoExpire !== false) {
      this.startExpirationJob(this._expirationIntervalMs);
    }
  }

  _migrate() {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)'
    );
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get();
    let current = row ? row.version : 0;

    if (current < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS dlq_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT,
          queue TEXT,
          payload TEXT,
          error TEXT,
          attempts INTEGER DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dlq_entries_created_at ON dlq_entries (created_at);
      `);
      current = 1;
    }

    if (row) {
      this.db.prepare('UPDATE schema_version SET version = ?').run(current);
    } else {
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(current);
    }
    this.schemaVersion = current;
  }

  add(entry) {
    const createdAt = entry.createdAt || new Date().toISOString();
    const payload = typeof entry.payload === 'string' ? entry.payload : JSON.stringify(entry.payload ?? null);
    const info = this._insertStmt.run(
      entry.jobId ?? null,
      entry.queue ?? null,
      payload,
      entry.error ?? null,
      entry.attempts ?? 0,
      createdAt
    );
    return this.get(info.lastInsertRowid);
  }

  get(id) {
    const row = this._getStmt.get(id);
    return row ? this._hydrate(row) : null;
  }

  list() {
    return this._listStmt.all().map((row) => this._hydrate(row));
  }

  remove(id) {
    return this._deleteStmt.run(id).changes > 0;
  }

  size() {
    return this._countStmt.get().count;
  }

  expire(now = Date.now()) {
    const cutoffMs = now - this.ttlDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date(cutoffMs).toISOString();
    const removed = this._expireStmt.run(cutoff).changes;
    if (removed > 0) {
      this.logger.info(
        `[dlq] expired ${removed} entr${removed === 1 ? 'y' : 'ies'} older than ${this.ttlDays} day(s) (cutoff ${cutoff})`
      );
    } else {
      this.logger.debug(`[dlq] expiration run: no entries older than ${this.ttlDays} day(s)`);
    }
    return removed;
  }

  startExpirationJob(intervalMs = this._expirationIntervalMs) {
    if (this._expirationTimer) {
      return this._expirationTimer;
    }
    this._expirationIntervalMs = intervalMs;
    this._expirationTimer = setInterval(() => {
      try {
        this.expire();
      } catch (err) {
        this.logger.error(`[dlq] expiration job failed: ${err && err.message ? err.message : err}`);
      }
    }, intervalMs);
    if (typeof this._expirationTimer.unref === 'function') {
      this._expirationTimer.unref();
    }
    return this._expirationTimer;
  }

  stopExpirationJob() {
    if (this._expirationTimer) {
      clearInterval(this._expirationTimer);
      this._expirationTimer = null;
    }
  }

  backup(destination) {
    const target = destination || `${this.dbPath}.backup-${Date.now()}`;
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db.backup(target);
    return target;
  }

  _hydrate(row) {
    let payload = row.payload;
    try {
      payload = row.payload == null ? null : JSON.parse(row.payload);
    } catch (_err) {
      payload = row.payload;
    }
    return {
      id: row.id,
      jobId: row.job_id,
      queue: row.queue,
      payload,
      error: row.error,
      attempts: row.attempts,
      createdAt: row.created_at,
    };
  }

  close() {
    this.stopExpirationJob();
    this.db.close();
  }
}

module.exports = { DeadLetterQueue, SCHEMA_VERSION, DEFAULT_DLQ_TTL_DAYS };
