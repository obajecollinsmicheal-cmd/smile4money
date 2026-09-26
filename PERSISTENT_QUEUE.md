# Persistent Job Queue for Oracle

## Overview

The oracle job queue persists failed oracle submissions durably, allowing the backend to recover pending jobs on restart. Without persistence, any failed submissions are lost when the process exits.

### Problem Solved

**Before**: Oracle job queue was held in memory. If the backend crashed or was restarted during a deployment, all pending jobs were lost and matches would never receive oracle submissions unless manually re-queued.

**After**: Failed submissions are persisted to a durable store (MongoDB or SQLite). On startup, the backend loads pending jobs from the store and resumes retries automatically.

## Architecture

### Components

1. **PersistentQueueStore Interface** (`src/store/persistent-queue-store.ts`)
   - Defines the contract for all queue store implementations
   - Methods: `add()`, `getAll()`, `remove()`, `update()`, `count()`, `clear()`, `initialize()`, `close()`

2. **Store Implementations**
   - **InMemoryQueueStore**: Fallback for development/testing (data lost on restart)
   - **MongoDBQueueStore**: Production-ready with automatic TTL cleanup (30 days)
   - **SQLiteQueueStore**: Lightweight file-based alternative with auto-expiry
   
3. **Queue Manager** (`src/queue.ts`)
   - Async functions: `writeToDlq()`, `listDlqEntries()`, `removeDlqEntry()`, `updateDlqEntry()`
   - Retry worker: `startRetryWorker()` periodically retries failed submissions
   - Lifecycle: `initializeQueue()`, `closeQueue()`

4. **Server Integration** (`src/server.ts`)
   - Initializes queue on startup
   - Loads pending jobs on startup
   - Starts retry worker
   - Gracefully shuts down queue on exit

## Configuration

### Environment Variables

```bash
# Queue store selection
QUEUE_STORE=auto  # auto (default), mongodb, sqlite, or memory

# MongoDB connection (if using MongoDB or auto-select with MongoDB available)
MONGODB_URL=mongodb://localhost:27017/smile4money
```

### Store Selection

The backend automatically selects the queue store:

1. **If `QUEUE_STORE=auto` (default)**
   - If `MONGODB_URL` is set: Uses MongoDB
   - Otherwise: Uses SQLite with file-based persistence

2. **If `QUEUE_STORE=mongodb`**
   - Requires `MONGODB_URL` to be set
   - Automatic TTL cleanup (30 days)

3. **If `QUEUE_STORE=sqlite`**
   - Uses SQLite database file
   - Default location: `data/oracle-queue.db`
   - Automatic cleanup of expired entries (30 days)

4. **If `QUEUE_STORE=memory`**
   - ⚠️ **Development only** — data lost on restart
   - Useful for testing

## Usage

### Basic Flow

```typescript
import { writeToDlq, listDlqEntries, startRetryWorker, initializeQueue } from './queue';

// 1. Initialize queue store on startup
await initializeQueue();

// 2. Load pending jobs
const pending = await listDlqEntries();
console.log(`Loaded ${pending.length} pending jobs`);

// 3. Start retry worker
const stopWorker = startRetryWorker(async (entry) => {
  // Implement your retry logic here
  await submitOracleResult(entry.payload);
}, 60_000); // retry every 60 seconds

// 4. When a submission fails, write to queue
try {
  await submitOracleResult(payload);
} catch (error) {
  await writeToDlq(payload, error.message);
}

// 5. Graceful shutdown
stopWorker();
await closeQueue();
```

### Retry Behavior

- Entries are retried at a configurable interval (default: 60 seconds)
- Failed retries keep the entry in the queue and increment the attempt count
- Successful retries remove the entry from the queue
- Entries automatically expire after 30 days

### Monitoring

Queue depth is logged as JSON:

```json
{"timestamp":"2026-07-28T10:31:41.823Z","level":"info","message":"oracle_dlq_depth","metric":"oracle_dlq_depth","value":5}
```

## Implementation Details

### DLQ Entry Structure

```typescript
interface DlqEntry {
  id: string;                    // Unique entry ID
  payload: unknown;              // Original submission payload
  failureReason: string;         // Error message from failure
  attempts: number;              // Retry attempt count
  createdAt: number;             // Timestamp (ms) when entry was created
  lastAttemptAt: number | null;  // Timestamp (ms) of last retry attempt
}
```

### Data Persistence

| Store | Persistence | TTL Cleanup | Suitable For |
|-------|-------------|-------------|--------------|
| InMemory | None | N/A | Testing only |
| MongoDB | Durable | 30-day TTL index | Production |
| SQLite | File-based | Query-based (on read) | Production |

### Database Schema

**SQLite (`oracle_dlq` table)**:
```sql
CREATE TABLE oracle_dlq (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  failureReason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  lastAttemptAt INTEGER,
  expireAt INTEGER NOT NULL,
  INDEX idx_oracle_dlq_expireAt
);
```

**MongoDB (`oracle_dlq` collection)**:
- Field `id`: Unique index
- Field `expireAt`: TTL index (auto-deletes after 30 days)

## Deployment Guide

### Development

```bash
# Use SQLite (default)
npm run dev

# Or use in-memory (testing only)
QUEUE_STORE=memory npm run dev

# Or use MongoDB
MONGODB_URL=mongodb://localhost:27017/smile4money npm run dev
```

### Production - MongoDB

```bash
# Set environment variables
export QUEUE_STORE=mongodb
export MONGODB_URL=mongodb://user:password@mongodb-host:27017/smile4money

npm run build
npm start
```

### Production - SQLite

```bash
# SQLite is the default if MONGODB_URL is not set
export QUEUE_STORE=sqlite
# Create data directory if it doesn't exist
mkdir -p data

npm run build
npm start
```

## Graceful Shutdown

The server implements graceful shutdown to prevent data loss:

```typescript
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  
  // Stop accepting new requests
  server.close();
  
  // Stop retry worker
  stopRetryWorker();
  
  // Flush pending state to database
  await closeQueue();
  
  process.exit(0);
});
```

On deployment with containerized apps (Docker, Kubernetes, ECS):
1. Orchestrator sends SIGTERM signal
2. Server stops accepting new requests
3. Current operations complete
4. Queue state is persisted
5. Container exits cleanly

## Testing

```bash
# Run all queue tests
npm test -- tests/queue.test.ts

# Run store implementation tests
npm test -- tests/queue-store.test.ts

# Run all backend tests
npm test
```

Test coverage includes:
- Basic queue operations (add, remove, update, getAll, count, clear)
- Retry worker behavior (interval execution, attempt tracking, success/failure handling)
- Data integrity and persistence
- Timer management
- Integration scenarios (failure + retry → success)

## Troubleshooting

### Entries not being retried

1. **Check queue is initialized**
   ```bash
   # Look for log: "Queue store initialized"
   ```

2. **Check retry worker started**
   ```bash
   # Look for periodic logs: "oracle_dlq: retry worker running"
   ```

3. **Verify handler is being called**
   - Add logging in your retry handler
   - Check attempt counts are incrementing

### SQLite database locked

If using SQLite in high-concurrency scenarios:
- SQLite has limited write concurrency
- Consider MongoDB for production workloads with multiple instances
- Ensure proper cleanup (close queue on shutdown)

### MongoDB connection issues

```bash
# Test connection
mongodb+srv://user:password@cluster.mongodb.net/smile4money

# Common issues:
# - IP whitelist: Add your server IP to MongoDB Atlas
# - Connection string format: Use mongodb+srv:// or mongodb://
# - Database permissions: Ensure user has write access
```

### Entries stuck in queue

1. **Check handler is not crashing**
   - Logs should show: "oracle_dlq: retry failed"
   - If handler crashes, logs will show the error

2. **Check expiry settings**
   - Entries automatically expire after 30 days
   - Manual deletion: Call `store.clear()` or remove entries via database

3. **Increase retry interval for testing**
   ```typescript
   startRetryWorker(handler, 5_000); // 5 seconds instead of 60
   ```

## Future Enhancements

- [ ] Configurable TTL per entry
- [ ] Max retry attempts limit
- [ ] Exponential backoff for retries
- [ ] Dead-letter queue metrics/alerts
- [ ] Admin UI for queue inspection and manual retry
- [ ] Circuit breaker to stop retries after repeated failures
- [ ] Partition strategy for horizontal scaling with MongoDB

## References

- [Issue #545: Oracle job queue not persisted](https://github.com/smile4money/smile4money/issues/545)
- [MongoDB TTL Indexes](https://docs.mongodb.com/manual/core/index-ttl/)
- [SQLite PRAGMA auto_vacuum](https://www.sqlite.org/pragma.html#pragma_auto_vacuum)
