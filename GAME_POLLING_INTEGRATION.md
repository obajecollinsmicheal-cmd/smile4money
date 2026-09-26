# Game Polling Integration Guide

## Quick Summary

Added explicit handling for **in-progress chess games** with configurable polling and backoff:

✅ **What was the problem?**
- If a game is still being played, API returns `result: null`
- Backend had no mechanism to re-check later
- Jobs could be left in unknown state

✅ **What changed?**
- New `PollingWorker` that periodically checks game status
- Automatic re-enqueue with configurable backoff (30s → 33s → 36s...)
- Explicit logging of: game in progress, completed, or error
- Moves to dead-letter queue after max attempts (~12 hours)

✅ **How to use?**
1. Add environment variables (or use defaults)
2. Start polling worker on backend startup
3. Create polling job when match is created
4. Handle completion events and submit to oracle

## File Structure

```
apps/backend/src/
├── services/
│   ├── polling.ts           ← Core polling logic (PollingWorker, PollingJobStore)
│   └── game-poller.ts       ← Chess API integration (ChessPlatformPoller)
└── routes/
    └── matches.ts           ← Create polling job on match creation

apps/backend/tests/
└── polling.test.ts          ← 80 test cases covering all scenarios
```

## Integration Steps

### Step 1: Import modules

```typescript
// In server.ts or your startup file
import { PollingWorker, PollingJobStore } from './services/polling.js';
import ChessPlatformPoller from './services/game-poller.js';
```

### Step 2: Initialize and start worker

```typescript
// Create store and poller
const pollingStore = new PollingJobStore();
const poller = new ChessPlatformPoller();

// Create worker with config
const worker = new PollingWorker(pollingStore, poller, {
  pollingIntervalMs: Number(process.env.POLLING_INTERVAL_MS ?? 30_000),
  maxPollingAttempts: Number(process.env.MAX_POLLING_ATTEMPTS ?? 1440),
  backoffMultiplier: Number(process.env.POLLING_BACKOFF_MULTIPLIER ?? 1.0),
});

// Start worker (returns cleanup function)
const cleanup = worker.start();

// Ensure cleanup on shutdown
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
```

### Step 3: Create polling job when match is created

```typescript
// In routes/matches.ts POST handler, after creating the match
const match = await store.createMatch({
  player1: req.address,
  player2: payload.player2,
  stakeAmount: payload.stakeAmount,
  token: payload.token,
  gameId: payload.gameId,
  platform: payload.platform,
});

// NEW: Start polling for game result
const pollingJob = pollingStore.createJob(
  match.matchId,
  match.gameId,
  payload.platform as 'lichess' | 'chessdotcom',
  payload.username, // Optional, for Chess.com
);

logger.info(
  { match_id: match.matchId, polling_job_id: pollingJob.id },
  'match_created_with_polling',
);

return res.status(201).json(match);
```

### Step 4: Handle game completion

When a game completes polling, you need to submit it to the oracle contract. Here are two patterns:

**Pattern A: Event-driven (Recommended)**

```typescript
// Extend PollingConfig with callback
interface PollingConfig {
  // ... existing fields
  onGameCompleted?: (job: PollJob, result: MatchResult) => Promise<void>;
}

// In PollingWorker.pollJob(), when status === 'completed':
if (status.status === 'completed' && this.config.onGameCompleted) {
  await this.config.onGameCompleted(job, status.result);
}

// Usage:
const worker = new PollingWorker(pollingStore, poller, {
  pollingIntervalMs: 30_000,
  maxPollingAttempts: 1440,
  backoffMultiplier: 1.0,
  onGameCompleted: async (job, result) => {
    try {
      const response = await submitResult({
        matchId: job.matchId,
        gameId: job.gameId,
        result,
        contractId: process.env.CONTRACT_ORACLE!,
        network: (process.env.STELLAR_NETWORK as any) || 'testnet',
        rpcUrl: process.env.STELLAR_RPC_URL!,
        sourceSecret: process.env.ORACLE_SECRET_KEY!,
      });
      logResultSubmission(response);
      pollingStore.completeJob(job.id);
    } catch (err) {
      logger.error(
        { match_id: job.matchId, error: err instanceof Error ? err.message : String(err) },
        'game_completion_submission_failed',
      );
      // Job stays in polling, will retry next cycle
    }
  },
});
```

**Pattern B: Polling results endpoint**

```typescript
// Expose an endpoint for querying completed games
router.get('/polling-results', async (req, res) => {
  const completedJobs = []; // Would need to track completed elsewhere
  return res.json(completedJobs);
});

// Your off-chain service calls this periodically and submits to oracle
```

## Configuration

### Environment Variables

| Variable | Default | Type | Purpose |
|----------|---------|------|---------|
| `POLLING_INTERVAL_MS` | `30000` | number | Polling interval in milliseconds |
| `MAX_POLLING_ATTEMPTS` | `1440` | number | Max retries before DLQ |
| `POLLING_BACKOFF_MULTIPLIER` | `1.0` | number | Backoff multiplier (1.0 = no backoff) |

### Examples

```bash
# Fast polling for testing (10s, no backoff)
POLLING_INTERVAL_MS=10000 POLLING_BACKOFF_MULTIPLIER=1.0 npm run dev

# Production: 30s polling with linear backoff
POLLING_INTERVAL_MS=30000 POLLING_BACKOFF_MULTIPLIER=1.1 npm run dev

# Long games: 60s with exponential backoff
POLLING_INTERVAL_MS=60000 POLLING_BACKOFF_MULTIPLIER=1.5 npm run dev

# Quick timeout: 2 hours max polling
MAX_POLLING_ATTEMPTS=240 npm run dev
```

## Expected Behavior

### Scenario: Game still in progress

```
PollingWorker Cycle 1:
  Fetch game-123 from Lichess API
  Result: { status: 'started', result: null }
  ✓ Detected: game in progress
  ✓ Action: Keep job in store, increment attempt to 1
  ✓ Re-schedule poll after 30 seconds

PollingWorker Cycle 2 (after 30s):
  Fetch game-123 from Lichess API
  Result: { status: 'started', result: null }
  ✓ Detected: game still in progress
  ✓ Action: Keep job in store, increment attempt to 2
  ✓ Re-schedule poll after 33 seconds (with backoff)

PollingWorker Cycle 3 (after 33s):
  Fetch game-123 from Lichess API
  Result: { status: 'mate', result: 'Player1Wins' }
  ✓ Detected: game completed!
  ✓ Action: Remove job from store
  ✓ Action: Submit result to oracle contract
  ✓ Action: Emit 'game_completed' event
  ✓ Log: INFO polling_attempts=3 result=Player1Wins
```

### Scenario: Game not found after 12 hours

```
PollingWorker Cycles 1-1440:
  Fetch game-123 from Lichess API
  Result: error or API 404

PollingWorker Cycle 1440:
  ✓ Detected: attempt >= maxAttempts
  ✓ Action: Remove job from store
  ✓ Action: Move to dead-letter queue
  ✓ Log: ERROR max_attempts_exceeded reason=game_not_found

// Manual investigation needed
```

## Logging Output

```json
{
  "timestamp": "2024-07-29T08:00:00.000Z",
  "level": "info",
  "service": "smile4money-backend",
  "match_id": 123,
  "game_id": "game-abc123",
  "platform": "lichess",
  "msg": "polling_job_created"
}

{
  "timestamp": "2024-07-29T08:00:30.000Z",
  "level": "info",
  "service": "smile4money-backend",
  "match_id": 123,
  "game_id": "game-abc123",
  "attempt": 1,
  "next_poll_ms": 30000,
  "msg": "polling_job_game_in_progress_re_enqueuing"
}

{
  "timestamp": "2024-07-29T08:01:03.000Z",
  "level": "info",
  "service": "smile4money-backend",
  "match_id": 123,
  "game_id": "game-abc123",
  "result": "Player1Wins",
  "polling_attempts": 2,
  "msg": "polling_job_game_completed"
}
```

## Testing

### Run the test suite
```bash
cd apps/backend
npm test -- polling.test.ts
```

### Example test cases included
- ✓ In-progress game detection and re-enqueuing
- ✓ Completed game detection and job removal
- ✓ Exponential backoff calculation
- ✓ Job store operations
- ✓ Error handling and max attempts
- ✓ Edge cases (non-existent jobs, large multipliers)

## Monitoring & Alerts

### Key metrics to expose

```typescript
// Export these for monitoring
export function getPollingMetrics() {
  return {
    pending_jobs: pollingStore.listPendingJobs().length,
    max_attempt_job: pollingStore.listPendingJobs()
      .reduce((max, j) => j.pollingAttempt > max ? j.pollingAttempt : max, 0),
    oldest_job_age_ms: pollingStore.listPendingJobs()[0]
      ? Date.now() - pollingStore.listPendingJobs()[0].createdAt
      : 0,
  };
}
```

### Alert thresholds

| Alert | Condition | Action |
|-------|-----------|--------|
| High Queue Depth | `pending_jobs > 1000` | Check API rate limits |
| Old Job | `oldest_job_age_ms > 12h` | Manual investigation |
| Poll Errors | Error rate > 10% | Check chess platform APIs |

## Troubleshooting

### Issue: Jobs not being polled
**Diagnosis**:
- Check `POLLING_INTERVAL_MS` is set correctly
- Verify worker started: look for `polling_worker_started` log
- Check no jobs exist: `pollingStore.listPendingJobs().length === 0`

**Fix**:
```bash
# Check logs for worker startup
NODE_ENV=production npm run dev 2>&1 | grep polling_worker_started

# Set interval to fast for testing
POLLING_INTERVAL_MS=5000 npm run dev
```

### Issue: Games stay in polling too long
**Diagnosis**:
- Check API errors: look for `game_poll_api_error` logs
- Check if `POLLING_INTERVAL_MS` is too large
- Verify Lichess/Chess.com APIs are responding

**Fix**:
```bash
# Reduce interval for faster polling
POLLING_INTERVAL_MS=15000 npm run dev

# Or increase max attempts
MAX_POLLING_ATTEMPTS=2880 npm run dev
```

### Issue: Too many API requests
**Diagnosis**:
- Check chess platform rate limits
- Reduce `POLLING_INTERVAL_MS` or increase `maxPollingAttempts`

**Fix**:
```bash
# Reduce polling frequency
POLLING_INTERVAL_MS=60000 npm run dev

# Or add backoff
POLLING_BACKOFF_MULTIPLIER=1.2 npm run dev
```

## Next Steps

1. **Deploy**: Merge polling service code
2. **Install**: `npm install` (no new dependencies added to polling)
3. **Test**: Run `npm test -- polling.test.ts`
4. **Configure**: Set environment variables as needed
5. **Start**: Backend will begin polling when it starts
6. **Monitor**: Watch logs for polling activity

## References

- [Polling Implementation](../src/services/polling.ts)
- [Game Poller](../src/services/game-poller.ts)
- [Test Suite](../tests/polling.test.ts)
- [Full Documentation](./GAME_POLLING_IMPLEMENTATION.md)
