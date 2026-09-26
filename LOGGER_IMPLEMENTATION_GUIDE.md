# Structured JSON Logger Implementation

## Overview

The backend now uses **pino** for structured JSON logging, compatible with production log aggregation platforms (Datadog, CloudWatch, Loki, Splunk).

## Changes Made

### 1. Added pino Dependency
- **File**: `apps/backend/package.json`
- **Change**: Added `"pino": "8.20.0"` to dependencies
- **Installation**: Run `npm install` in `apps/backend/` to install

### 2. Rewrote Logger Module
- **File**: `apps/backend/src/logger.ts`
- **Changes**:
  - Replaced text-based formatter with pino
  - Outputs JSON in production, pretty-printed in development
  - Supports LOG_LEVEL environment variable
  - Includes standard fields: `timestamp`, `level`, `message`, `service`
  - Supports context fields: `match_id`, `tx_hash`, `dlqId`, etc.

### 3. Replaced console.log
- **File**: `apps/backend/src/server.ts`
- **Change**: Replaced `console.log()` with `logger.info({ port }, 'smile4money-backend started')`

## Logger API

All logger calls follow the pattern: `logger.{level}(context, message)`

```typescript
// Info level — operational events
logger.info({ match_id: 123, status: 'active' }, 'match_activated');

// Warn level — potentially problematic events
logger.warn({ dlqId: 'dlq-1', attempt: 2 }, 'retry_failed');

// Error level — exceptional conditions
logger.error({ tx_hash: 'abc123', error: 'TIMEOUT' }, 'submission_failed');
```

## Example JSON Output

```json
{
  "level": 30,
  "time": 1690717200000,
  "timestamp": "2024-07-29T08:00:00.000Z",
  "service": "smile4money-backend",
  "match_id": 123,
  "port": 4000,
  "msg": "smile4money-backend started"
}
```

### Standard Fields

| Field | Type | Always Present | Example |
|-------|------|---|---|
| `timestamp` | ISO 8601 string | ✓ | `"2024-07-29T08:00:00.000Z"` |
| `level` | string | ✓ | `"info"`, `"warn"`, `"error"` |
| `message` | string | ✓ | `"match_activated"` |
| `service` | string | ✓ | `"smile4money-backend"` |
| Context fields | any | ✗ | `match_id`, `tx_hash`, `dlqId`, etc. |

## Usage in Backend

### Existing Code Using Logger

All existing logger calls already follow the correct pattern:

**queue.ts** (5 calls):
```typescript
logger.warn({ dlqId: id, failureReason }, "oracle_dlq: entry written");
logger.info({ metric: "oracle_dlq_depth", value: depth }, "oracle_dlq_depth");
logger.info({ count: entries.length }, "oracle_dlq: retry worker running");
logger.info({ dlqId: entry.id }, "oracle_dlq: entry resolved");
logger.warn({ dlqId: entry.id, attempt: entry.attempts, err }, "oracle_dlq: retry failed");
```

**services/oracle.ts** (1 call):
```typescript
logger.info(
  {
    match_id: submission.matchId,
    game_id: submission.gameId,
    result: submission.result,
    tx_hash: submission.txHash,
  },
  'oracle_result_submitted'
);
```

**server.ts** (1 call):
```typescript
logger.info({ port }, 'smile4money-backend started');
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOG_LEVEL` | `info` | Minimum log level to emit: `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | (unset) | If `production`, outputs JSON; otherwise pretty-prints for development |

### Examples

```bash
# Production mode — JSON output for log aggregation
NODE_ENV=production LOG_LEVEL=info npm run dev

# Development mode — pretty-printed text output
LOG_LEVEL=debug npm run dev
```

## Verification

### Method 1: Run Tests (After npm install)

```bash
cd apps/backend
npm install
npm test -- logger.test.ts
```

The test suite (`tests/logger.test.ts`) verifies:
- ✓ Logger outputs valid JSON
- ✓ All required fields present (timestamp, level, message, service)
- ✓ Context fields properly included
- ✓ All log levels (info, warn, error) work correctly

### Method 2: Manual Verification

```bash
cd apps/backend
npm install
npm run dev
```

You should see output like:
```
Development mode (pretty-printed):
  INFO smile4money-backend started (port 4000)

Production mode (JSON):
  {"timestamp":"2024-07-29T08:00:00.000Z","level":"info","message":"smile4money-backend started","service":"smile4money-backend","port":4000}
```

### Method 3: Check JSON Validity

```bash
# Redirect output to a file
NODE_ENV=production npm run dev 2>&1 | head -1 > log.json

# Validate JSON
jq . log.json && echo "Valid JSON" || echo "Invalid JSON"
```

## Log Aggregation Integration

### Datadog

```python
# datadog.yaml
logs:
  - type: file
    path: /var/log/smile4money-backend.log
    service: smile4money-backend
    source: nodejs
    parser_type: json
```

### CloudWatch

```json
{
  "logDriver": "awslogs",
  "options": {
    "awslogs-group": "/ecs/smile4money-backend",
    "awslogs-region": "us-east-1"
  }
}
```

Logs are automatically parsed as JSON and fields become searchable.

### Loki (Grafana)

```yaml
scrape_configs:
  - job_name: smile4money-backend
    static_configs:
      - targets:
          - localhost
        labels:
          job: smile4money-backend
          __path__: /var/log/smile4money-backend.log
```

## Migration Notes

### No Breaking Changes

The logger API is compatible with existing code:
- ✓ All existing `logger.info()`, `logger.warn()`, `logger.error()` calls work unchanged
- ✓ Context parameters are optional (pass `{}` if no context)
- ✓ Message parameter remains required

### What Changed

- **Output Format**: Text → JSON (in production)
- **Fields Added**: `service` field automatically included in all logs
- **Transport**: Stdout → Stdout (but structured format)
- **Dependencies**: Added `pino@8.20.0`

## Next Steps

1. **Install dependencies**: `npm install`
2. **Run tests**: `npm test` (all tests should pass)
3. **Deploy**: Logger is transparent to the application
4. **Monitor**: Use your log aggregation platform's search/filter features on `service=smile4money-backend`

## Example Queries (Log Aggregation Platforms)

### Datadog
```
service:smile4money-backend AND @match_id:123 AND @level:warn
```

### Loki
```
{service="smile4money-backend"} | json | match_id="123" | level="warn"
```

### CloudWatch
```
{ $.service = "smile4money-backend" && $.match_id = 123 && $.level = "warn" }
```

## References

- [Pino Documentation](https://getpino.io/)
- [JSON Logging Best Practices](https://www.kartar.net/2015/12/structured-logging/)
- [Log Aggregation Patterns](https://12factor.net/logs)
