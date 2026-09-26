# Game Polling System — Implementation Guide

## Problem Statement

Previously, the backend had **no explicit mechanism** to detect and handle in-progress games:

1. **Fetchers** correctly returned `result: null` for games still being played
2. **Oracle service** only handled already-completed results (it was a submission service, not a polling service)
3. **Routes** validated games existed but didn't trigger background polling
4. **Queue** only had dead-letter queue for failures, not for "game not finished yet" scenarios

**Result**: Jobs polling for game results could be left in an **unknown state** if the game was still in progress.

## Solution Overview

Implemented a **three-layer polling system** that explicitly detects and re-enqueues in-progress games:

```
┌─────────────────────────────────────────────────────────────┐
│ Backend Process                                              │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  PollingWorker                                                │
│  ├─ Runs on configurable interval (default: 30s)             │
│  ├─ Polls all pending jobs                                   │
│  └─ Handles results & errors                                 │
│                                                               │
│       ↓                                                        │
│                                                               │
│  ChessPlatformPoller                                          │
│  ├─ Calls Lichess API: fetchLichessResult()                   │
│  ├─ Calls Chess.com API: fetchChessDotComResult()             │
│  └─ Returns: 'in_progress', 'completed', or 'failed'         │
│                                                               │
│       ↓                                                        │
│                                                               │
│  PollingJobStore                                              │
│  ├─ Tracks active polling jobs                               │
│  ├─ Increments attempt counters                              │
│  └─ Removes completed jobs                                   │
│                                                               │
└──────────────────────────────────────────────────────────────┘

Poll Cycle (every 30 seconds):
  1. Get all pending jobs from store
  2. For each job:
     a. Fetch game status from API
     b. If in_progress: increment attempt, re-schedule after delay
     c. If completed: remove job, emit event (submit to oracle)
     d. If failed: check max attempts, retry or move to DLQ
```

## Components

### 1. PollingJobStore (`services/polling.ts`)

**Purpose**: Tracks active polling jobs with in-memory storage (swap for Redis/DB for persistence).

**Key Methods**:
```typescript
// Create a new polling job
createJob(matchId: number, gameId: string, platform: 'lichess' | 'chessdotcom', username?: string): PollJob

// Get job by ID or matchId
getJob(jobId: string): PollJob | null
getJobByMatchId(matchId: number): PollJob | null

// Track polling progress
incrementAttempt(jobId: string): void

// Complete and remove job
completeJob(jobId: string): void
```

**Data Structure**:
```typescript
interface PollJob {
  id: string;                              // Unique job ID
  matchId: number;                         // On-chain match ID
  gameId: string;                          // Chess.com or Lichess game ID
  platform: 'lichess' | 'chessdotcom';    // Chess platform
  username?: string;                       // Chess.com username (required for Chess.com)
  pollingAttempt: number;                  // Attempt counter (starts at 0)
  createdAt: number;                       // Timestamp
  lastPolledAt: number | null;             // Last poll time
}
```

### 2. PollingWorker (`services/polling.ts`)

**Purpose**: Periodically polls all pending jobs and handles results.

**Configuration** (via environment variables):
```typescript
interface PollingConfig {
  pollingIntervalMs: number;        // Base polling interval (default: 30_000 ms)
  maxPollingAttempts: number;       // Max retries before DLQ (default: 1440 ≈ 12h)
  backoffMultiplier: number;        // Backoff multiplier (default: 1.0 = no backoff)
}
```

**Usage**:
```typescript
const store = new PollingJobStore();
const poller = new ChessPlatformPoller();
const worker = new PollingWorker(store, poller, {
  pollingIntervalMs: 30_000,
  maxPollingAttempts: 1440,
  backoffMultiplier: 1.1,
});

// Start worker (returns cleanup function)
const cleanup = worker.start();

// Later, stop worker
cleanup();
```

### 3. ChessPlatformPoller (`services/game-poller.ts`)

**Purpose**: Fetches game results from chess platform APIs and translates to polling status.

**Handles**:
- Lichess API: `fetchLichessResult(gameId)`
- Chess.com API: `fetchChessDotComResult(username, gameId)`
- Game in progress: `result === null` → status: 'in_progress'
- Game completed: `result !== null` → status: 'completed' + result
- API errors: network, 404, rate limiting → status: 'failed'

**Return Value**:
```typescript
interface PollJobStatus {
  status: 'pending' | 'completed' | 'failed' | 'in_progress';
  result?: MatchResult;        // Only when status === 'completed'
  reason?: string;             // Only when status === 'failed'
}
```

## Polling Flow

### Cycle 1: Game In Progress
```
1. Worker polls: "Is game-123 finished?"
   ↓
2. Fetcher returns: { result: null, status: 'started' }
   ↓
3. Store detects: attempt=0, game_in_progress
   ↓
4. Action: Increment attempt → 1
           Schedule next poll after: 30s * 1.1^0 = 30s
           Keep job in store
   ↓
5. Log: INFO attempt=1 next_poll_ms=30000
```

### Cycle 2-N: Game Still In Progress
```
Same as Cycle 1, but:
- attempt increments: 1 → 2 → 3 → ...
- delay increases with backoff: 30s → 33s → 36.3s → ...
```

### Final Cycle: Game Completed
```
1. Worker polls: "Is game-123 finished?"
   ↓
2. Fetcher returns: { result: 'Player1Wins', status: 'mate' }
   ↓
3. Store detects: game_completed
   ↓
4. Action: Remove job from store
           Emit event: game_completed(match=123, result='Player1Wins')
   ↓
5. Log: INFO match_id=123 result=Player1Wins polling_attempts=N
```

### Error Case: Max Attempts Exceeded
```
1. Worker polls: "Is game-123 finished?"
   ↓
2. Fetcher returns: error (API down, game deleted, etc.)
   ↓
3. Store detects: attempt >= maxAttempts
   ↓
4. Action: Remove job from store
           Move to DLQ for manual investigation
   ↓
5. Log: ERROR attempt=1440 max_attempts=1440 reason=... moving_to_dlq
```

## Configuration

### Environment Variables

| Variable | Type | Default | Purpose |
|----------|------|---------|---------|
| `POLLING_INTERVAL_MS` | number | `30000` | Base polling interval in milliseconds |
| `MAX_POLLING_ATTEMPTS` | number | `1440` | Max retry attempts before DLQ (~12 hours at 30s intervals) |
| `POLLING_BACKOFF_MULTIPLIER` | number | `1.0` | Backoff multiplier for retry delays |

### Examples

```bash
# Every 10 seconds, no backoff (rapid polling for testing)
POLLING_INTERVAL_MS=10000 \
POLLING_BACKOFF_MULTIPLIER=1.0 \
npm run dev

# Every 30 seconds with linear backoff (30s → 33s → 36s...)
POLLING_INTERVAL_MS=30000 \
POLLING_BACKOFF_MULTIPLIER=1.1 \
npm run dev

# Every 60 seconds with exponential backoff (60s → 90s → 135s...)
POLLING_INTERVAL_MS=60000 \
POLLING_BACKOFF_MULTIPLIER=1.5 \
npm run dev

# Max 2880 attempts = 24 hours at 30s intervals
MAX_POLLING_ATTEMPTS=2880 \
npm run dev
```

## Backoff Calculation

Retry delay grows with each polling attempt:

```
delay_ms = base_interval * (backoff_multiplier ^ attempt_count)
```

### Examples with 30s base interval:

**No backoff (multiplier = 1.0)**:
- All retries: 30s, 30s, 30s, ...

**Linear backoff (multiplier = 1.1)**:
- Attempt 0: 30s
- Attempt 1: 33s
- Attempt 2: 36.3s
- Attempt 5: 48.3s
- Attempt 10: 77.8s

**Exponential backoff (multiplier = 1.5)**:
- Attempt 0: 30s
- Attempt 1: 45s
- Attempt 2: 67.5s
- Attempt 3: 101.25s
- Attempt 5: 227.8s (3.8 minutes)
- Attempt 10: 5,218s (87 minutes)

## Integration with Existing Backend

### Step 1: Create polling job when match is created

```typescript
// In routes/matches.ts POST handler
const match = await store.createMatch({ ... });

// NEW: Start polling for result
const pollingJob = pollingStore.createJob(
  match.matchId,
  match.gameId,
  match.platform as 'lichess' | 'chessdotcom',
  match.username, // Optional, for Chess.com
);

logger.info({ match_id: match.matchId }, 'match_created_polling_started');
```

### Step 2: Start worker on backend startup

```typescript
// In server.ts
import { PollingWorker } from './services/polling.js';
import { ChessPlatformPoller } from './services/game-poller.js';

const pollingStore = new PollingJobStore();
const poller = new ChessPlatformPoller();
const worker = new PollingWorker(pollingStore, poller, {
  pollingIntervalMs: Number(process.env.POLLING_INTERVAL_MS ?? 30_000),
  maxPollingAttempts: Number(process.env.MAX_POLLING_ATTEMPTS ?? 1440),
  backoffMultiplier: Number(process.env.POLLING_BACKOFF_MULTIPLIER ?? 1.0),
});

// Start worker
const cleanupWorker = worker.start();

// Cleanup on shutdown
process.on('SIGTERM', () => {
  cleanupWorker();
  process.exit(0);
});
```

### Step 3: Handle completed games

```typescript
// When game completes (in polling worker or event handler)
const status = await poller.poll(job);

if (status.status === 'completed' && status.result) {
  // Submit to oracle contract
  const response = await submitResult({
    matchId: job.matchId,
    gameId: job.gameId,
    result: status.result,
    contractId: process.env.CONTRACT_ORACLE!,
    network: (process.env.STELLAR_NETWORK as any) || 'testnet',
    rpcUrl: process.env.STELLAR_RPC_URL!,
    sourceSecret: process.env.ORACLE_SECRET_KEY!,
  });

  logResultSubmission(response);
  pollingStore.completeJob(job.id);
}
```

## Testing

### Run the test suite:
```bash
cd apps/backend
npm test -- polling.test.ts
```

### Expected output:
```
 ✓ Game Polling System (80 tests)
   ✓ calculateNextPollDelay (4 tests)
     ✓ returns base interval when no backoff (multiplier=1.0)
     ✓ applies linear backoff (multiplier=1.1)
     ✓ applies exponential backoff (multiplier=1.5)
     ✓ handles edge case: attempt=0 with any multiplier
   ✓ PollingJobStore (8 tests)
     ✓ creates a new polling job
     ✓ creates job with username for Chess.com
     ✓ throws when creating duplicate job for same matchId
     ...
   ✓ PollingWorker (6 tests)
     ...
   ✓ Edge Cases (5 tests)
     ...
```

## Logging

All polling activity is logged with structured JSON:

```json
{
  "level": "info",
  "timestamp": "2024-07-29T08:00:00.000Z",
  "service": "smile4money-backend",
  "match_id": 123,
  "game_id": "abc123",
  "platform": "lichess",
  "polling_attempts": 5,
  "msg": "polling_job_game_completed"
}
```

### Log Patterns

**Job Created**:
```
info: polling_job_created {match_id, game_id, platform}
```

**Game In Progress (Re-enqueuing)**:
```
info: polling_job_game_in_progress_re_enqueuing {match_id, game_id, attempt, next_poll_ms}
```

**Game Completed**:
```
info: polling_job_game_completed {match_id, game_id, result, polling_attempts}
```

**Max Attempts Exceeded**:
```
error: polling_job_max_attempts_exceeded_moving_to_dlq {match_id, attempt, max_attempts, reason}
```

**API Error**:
```
error: game_poll_api_error {match_id, game_id, platform, error}
```

## Monitoring & Alerts

### Key Metrics to Track

| Metric | Query | Alert Threshold |
|--------|-------|-----------------|
| Queue Depth | `metric="polling_queue_depth"` | > 1000 jobs |
| Polling Latency | `msg="polling_job_game_completed"` duration | > 12h |
| API Errors | `msg="game_poll_api_error"` count/min | > 10 errors/min |
| Max Attempts | `msg="polling_job_max_attempts_exceeded_moving_to_dlq"` | Any occurrence |

### Example Datadog Monitor

```python
# Alert if more than 100 jobs are polling after 6 hours
monitor.query = 'avg(last_6h): avg:smile4money.polling_queue_depth > 100'
```

## Migration Path

### Phase 1: Deploy (Week 1)
- [ ] Deploy polling service
- [ ] Start monitoring logs
- [ ] Verify no errors in first 24h

### Phase 2: Enable (Week 2)
- [ ] Enable polling for new matches
- [ ] Monitor queue depth and latency
- [ ] Adjust configuration if needed

### Phase 3: Backfill (Week 3)
- [ ] Re-enqueue existing pending matches
- [ ] Monitor for anomalies
- [ ] Verify all complete successfully

## Files Added/Modified

| File | Status | Purpose |
|------|--------|---------|
| `src/services/polling.ts` | ✅ NEW | Polling job store and worker |
| `src/services/game-poller.ts` | ✅ NEW | Chess platform API poller |
| `tests/polling.test.ts` | ✅ NEW | Test suite (80 tests) |
| `GAME_POLLING_IMPLEMENTATION.md` | ✅ NEW | This documentation |

## FAQ

**Q: What happens if a game is still in progress after 12 hours?**
A: The job is moved to the dead-letter queue for manual investigation. This could happen if:
- Players are playing a correspondence chess game (days/weeks long)
- The game was abandoned and API never returned a result
- Chess platform API is misconfigured

**Q: Can I use Redis instead of in-memory storage?**
A: Yes! The `PollingJobStore` is designed to be swappable. Implement the same interface:
```typescript
export interface PollingJobStore {
  createJob(...): PollJob;
  getJob(jobId: string): PollJob | null;
  // ... etc
}
```

**Q: What if the oracle contract is down while a game completes?**
A: The job completes polling but fails to submit to the oracle. It moves to the dead-letter queue. The retry worker can attempt submission again when the oracle is back.

**Q: Can I adjust polling interval per match?**
A: Currently, all matches poll at the same interval. To support per-match intervals, extend `PollJob` with `customIntervalMs` and update the worker to track individual timers per job.

## References

- [Game Fetchers](../src/fetchers/lichess.ts)
- [Oracle Service](../src/services/oracle.ts)
- [Structured Logging](./STRUCTURED_LOGGING_SUMMARY.md)
