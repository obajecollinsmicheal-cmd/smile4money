# Persistent Queue & Dead-Letter Queue (DLQ)

This document describes the durable queue storage used by the backend, including
the dead-letter queue (DLQ) persistence introduced in issue #2173.

## Overview

All queue state — including dead-letter entries — is persisted to a local
SQLite database so that entries survive process restarts. The database file is
created on first use and lives alongside the application data directory.

- **Storage engine:** SQLite (file-backed, durable)
- **Durability:** entries are committed to disk on write and reloaded on startup
- **Schema versioning:** tracked via `PRAGMA user_version` with forward migrations
- **Backup:** supported via the SQLite online backup API / file copy

## Dead-letter queue persistence

When a job exhausts its retries it is moved to the DLQ. Instead of being held
only in memory, each DLQ entry is written to the `dlq_entries` table:

| Column        | Type    | Notes                                   |
|---------------|---------|-----------------------------------------|
| `id`          | INTEGER | Primary key, autoincrement              |
| `job_id`      | TEXT    | Original job identifier                 |
| `queue`       | TEXT    | Source queue name                       |
| `payload`     | TEXT    | Serialized job payload (JSON)           |
| `error`       | TEXT    | Last error message                      |
| `attempts`    | INTEGER | Number of attempts made                 |
| `created_at`  | INTEGER | Unix epoch milliseconds                 |

Because entries are committed to disk, a process restart does not lose DLQ
state: on startup the queue manager reopens the database and the DLQ is
immediately available for inspection, replay, or purge.

## Schema versioning

The database records its schema version in `PRAGMA user_version`. On open, the
queue manager compares the stored version against the expected version and
applies any pending migrations in order. This allows the schema to evolve
without losing existing DLQ entries.

## Backup

Because the DLQ is a single SQLite file, backups are straightforward:

- **Online backup:** use the SQLite backup API (or `VACUUM INTO 'backup.db'`)
  to produce a consistent snapshot while the process is running.
- **Offline backup:** stop the process and copy the database file.

Restoring a backup consists of replacing the database file (with the process
stopped) and restarting; the schema version is validated on open.
