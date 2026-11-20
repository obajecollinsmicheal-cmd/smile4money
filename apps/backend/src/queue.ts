/**
 * Dead-letter queue (DLQ) for failed oracle submissions.
 *
 * Failed submissions are stored via a pluggable persistent store (in-memory by
 * default; swap to SQLite or MongoDB via the QUEUE_STORE env var). A retry
 * worker periodically attempts to reprocess each entry and emits
 * `oracle_dlq_depth` for monitoring.
 *
 * Circuit breaker pattern protects against cascading RPC failures:
 * - After N consecutive failures, job processing is paused
 * - Backoff cooldown prevents hammering a degraded endpoint
 * - Automatic recovery testing after cooldown expires
 */

/* Import already at the top level */
import { getCircuitBreaker, CircuitState } from "./services/circuit-breaker.js";
import { InMemoryQueueStore } from "./store/in-memory-queue-store.js";
import { SQLiteQueueStore } from "./store/sqlite-queue-store.js";
import type {
  DlqEntry,
  PersistentQueueStore,
} from "./store/persistent-queue-store.js";

export type { DlqEntry };

import logger from "./logger.js";

let queueStore: PersistentQueueStore | null = null;

export type QueueStoreType = "memory" | "sqlite";

/**
 * Decide which queue store implementation to use for a given QUEUE_STORE
 * value and NODE_ENV, without touching disk. Exported for unit testing.
 *
 *   'sqlite' / 'auto' / unset → sqlite (durable; the default)
 *   'mongodb'                 → sqlite (mongoose is not an installed dependency)
 *   'memory'                  → memory, EXCEPT in production, where it is
 *                                auto-corrected to sqlite so DLQ entries
 *                                cannot silently be lost on restart.
 */
export function resolveQueueStoreType(
  rawQueueStore: string | undefined,
  nodeEnv: string | undefined,
): QueueStoreType {
  const requested = (rawQueueStore || "auto").toLowerCase();

  if (requested === "memory" && nodeEnv !== "production") {
    return "memory";
  }

  return "sqlite";
}

/**
 * Initialise the queue store based on the QUEUE_STORE environment variable.
 * Must be called once on application startup before any other queue function.
 *
 * See resolveQueueStoreType() for how QUEUE_STORE is resolved. In-memory
 * mode is never durable across restarts, so it always logs a warning, and
 * NODE_ENV=production silently requesting it is auto-corrected to SQLite
 * (see docs/oracle.md#queue-store-persistence).
 */
// Maintenance gate for live restores (#108); see store/maintenance-gate.ts.
import { MaintainableQueueStore } from "./store/maintenance-gate.js";

/**
 * The active queue store's maintenance gate, or null before initializeQueue().
 * Used by the live-restore procedure (store/live-restore.ts) to hold queue
 * access while the database file is replaced.
 */
export function getMaintainableQueueStore(): MaintainableQueueStore | null {
  return queueStore instanceof MaintainableQueueStore ? queueStore : null;
}

export async function initializeQueue(): Promise<void> {
  const rawQueueStore = process.env.QUEUE_STORE;
  const nodeEnv = process.env.NODE_ENV;
  const requested = (rawQueueStore || "auto").toLowerCase();
  const resolved = resolveQueueStoreType(rawQueueStore, nodeEnv);

  if (requested === "mongodb") {
    logger.warn(
      { requested },
      "oracle_dlq: QUEUE_STORE=mongodb requested but the mongoose dependency is not installed; falling back to sqlite",
    );
  }

  if (requested === "memory" && resolved === "sqlite") {
    logger.warn(
      { requested, nodeEnv },
      "oracle_dlq: QUEUE_STORE=memory is not safe in production (DLQ entries are lost on restart); auto-falling back to sqlite. See docs/oracle.md#queue-store-persistence.",
    );
  }

  // Wrapped so a live restore can quiesce every queue read/write (#108).
  queueStore = new MaintainableQueueStore(
    resolved === "memory" ? new InMemoryQueueStore() : new SQLiteQueueStore(),
  );

  await queueStore.initialize();

  if (resolved === "memory") {
    logger.warn(
      {},
      "oracle_dlq: using in-memory queue store -- DLQ entries will NOT survive a process restart. Not recommended outside local development; see docs/oracle.md#queue-store-persistence.",
    );
  }

  logger.info({ store: resolved }, "oracle_dlq: queue store initialized");
}

/**
 * Return the active queue store.
 * @throws if initializeQueue() has not been called yet.
 */
function getQueueStore(): PersistentQueueStore {
  if (!queueStore) {
    throw new Error(
      "Queue store not initialized. Call initializeQueue() first.",
    );
  }
  return queueStore;
}

/** Write a failed submission to the DLQ. */
export async function writeToDlq(
  payload: unknown,
  failureReason: string,
): Promise<DlqEntry> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: DlqEntry = {
    id,
    payload,
    failureReason,
    attempts: 0,
    createdAt: Date.now(),
    lastAttemptAt: null,
  };

  await getQueueStore().add(entry);
  logger.warn({ dlqId: id, failureReason }, "oracle_dlq: entry written");
  await emitDlqDepth();
  return entry;
}

/** Return all pending DLQ entries (shallow copy). */
export async function listDlqEntries(): Promise<DlqEntry[]> {
  return await getQueueStore().getAll();
}

/** Remove a successfully processed entry. */
export async function removeDlqEntry(id: string): Promise<void> {
  await getQueueStore().remove(id);
  await emitDlqDepth();
}

/** Update an entry's retry state. */
export async function updateDlqEntry(
  id: string,
  updates: Partial<DlqEntry>,
): Promise<void> {
  await getQueueStore().update(id, updates);
}

/** Emit the oracle_dlq_depth metric. */
async function emitDlqDepth(): Promise<void> {
  const depth = await getQueueStore().count();
  logger.info({ metric: "oracle_dlq_depth", value: depth }, "oracle_dlq_depth");
}

export type RetryHandler = (entry: DlqEntry) => Promise<void>;

/** Exponential backoff parameters for a job type. */
export interface BackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
}

/** Default backoff configuration used when no per-type override applies. */
export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  multiplier: 2,
};

function parsePositiveNumber(
  rawValue: string | undefined,
  fallback: number,
  label: string,
): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      { rawValue, label },
      "oracle_dlq: invalid backoff value, falling back to default",
    );
    return fallback;
  }

  return parsed;
}

/**
 * Resolve the exponential backoff configuration for a job type.
 *
 * Per-type overrides are read from the environment using the job type
 * uppercased with non-alphanumerics replaced by underscores, e.g. for
 * jobType "oracle-submit":
 *
 *   BACKOFF_ORACLE_SUBMIT_BASE_DELAY_MS
 *   BACKOFF_ORACLE_SUBMIT_MAX_DELAY_MS
 *   BACKOFF_ORACLE_SUBMIT_MULTIPLIER
 *
 * Global overrides (BACKOFF_BASE_DELAY_MS, BACKOFF_MAX_DELAY_MS,
 * BACKOFF_MULTIPLIER) apply to all job types; per-type values win.
 */
export function resolveBackoffConfig(
  jobType: string,
  env: NodeJS.ProcessEnv = process.env,
): BackoffConfig {
  const prefix = `BACKOFF_${jobType
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")}`;

  const baseDelayMs = parsePositiveNumber(
    env[`${prefix}_BASE_DELAY_MS`] ?? env.BACKOFF_BASE_DELAY_MS,
    DEFAULT_BACKOFF_CONFIG.baseDelayMs,
    "baseDelayMs",
  );
  const maxDelayMs = parsePositiveNumber(
    env[`${prefix}_MAX_DELAY_MS`] ?? env.BACKOFF_MAX_DELAY_MS,
    DEFAULT_BACKOFF_CONFIG.maxDelayMs,
    "maxDelayMs",
  );
  const multiplier = parsePositiveNumber(
    env[`${prefix}_MULTIPLIER`] ?? env.BACKOFF_MULTIPLIER,
    DEFAULT_BACKOFF_CONFIG.multiplier,
    "multiplier",
  );

  return { baseDelayMs, maxDelayMs, multiplier };
}

/**
 * Compute the exponential backoff delay for the given (1-based) attempt
 * number and job type: min(baseDelayMs * multiplier^(attempt-1), maxDelayMs).
 */
export function computeBackoffDelay(
  attempt: number,
  jobType: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const { baseDelayMs, maxDelayMs, multiplier } = resolveBackoffConfig(
    jobType,
    env,
  );
  const exponent = Math.max(0, attempt - 1);
  const delay = baseDelayMs * Math.pow(multiplier, exponent);
  return Math.min(delay, maxDelayMs);
}

/**
 * Start the DLQ retry worker. Call once on startup.
 * Returns a cleanup function that stops the worker.
 *
 * Implements a circuit breaker to prevent cascading failures:
 * - Circuit opens after N consecutive RPC failures
 * - Job processing pauses during cooldown
 * - Exponential backoff for recovery attempts
 */
export function startRetryWorker(
  handler: RetryHandler,
  intervalMs = 60_000,
  jobType = "default",
): () => void {
  const breaker = getCircuitBreaker();

  // Wrap the circuit breaker's state-change callback so we can log transitions
  const originalOnStateChange = breaker["config"].onStateChange;
  breaker["config"].onStateChange = (from: CircuitState, to: CircuitState) => {
    if (from !== to) {
      logger.warn(
        { from, to, ...breaker.getStatus() },
        "circuit_breaker: state changed",
      );
    }
    originalOnStateChange?.(from, to);
  };

  const timer = setInterval(async () => {
    const entries = await listDlqEntries();
    if (entries.length === 0) return;

    // Respect circuit breaker state
    if (!breaker.allowRequest()) {
      const remaining = breaker.getRemainingCooldown();
      logger.warn(
        { remaining, state: breaker.getState(), count: entries.length },
        "circuit_breaker: job processing paused",
      );
      return;
    }

    logger.info(
      { count: entries.length, state: breaker.getState() },
      "oracle_dlq: retry worker running",
    );

    try {
      for (const entry of entries) {
        // Record the attempt before calling the handler
        entry.attempts += 1;
        entry.lastAttemptAt = Date.now();
        await updateDlqEntry(entry.id, {
          attempts: entry.attempts,
          lastAttemptAt: entry.lastAttemptAt,
        });

        try {
          await handler(entry);
          await removeDlqEntry(entry.id);
          breaker.recordSuccess();
          logger.info({ dlqId: entry.id }, "oracle_dlq: entry resolved");
        } catch (err) {
          const isRpcError =
            String(err).includes("RPC") || String(err).includes("Network");

          if (isRpcError) {
            const circuitOpened = breaker.recordFailure();
            if (circuitOpened) {
              logger.error(
                {
                  dlqId: entry.id,
                  attempt: entry.attempts,
                  failureCount: breaker.getFailureCount(),
                  cooldown: breaker.getRemainingCooldown(),
                },
                "circuit_breaker: RPC circuit opened, pausing job processing",
              );
              // Stop processing remaining entries this cycle
              break;
            }
          }

          const nextDelayMs = computeBackoffDelay(entry.attempts, jobType);

          logger.warn(
            {
              dlqId: entry.id,
              attempt: entry.attempts,
              isRpcError,
              nextDelayMs,
              err: String(err).substring(0, 100),
            },
            "oracle_dlq: retry failed",
          );
        }

        await emitDlqDepth();
      }
    } catch (err) {
      logger.error({ err: String(err) }, "oracle_dlq: retry worker error");
    }
  }, intervalMs);

  return () => {
    clearInterval(timer);
  };
}

/**
 * Shut down the queue store cleanly on application exit.
 */
export async function closeQueue(): Promise<void> {
  if (queueStore) {
    await queueStore.close();
    queueStore = null;
  }
}

const DEFAULT_DLQ_TTL_DAYS = 7;
const DEFAULT_DLQ_EVICTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Parse the DLQ_TTL_DAYS environment variable, falling back to the default
 * (7 days) when unset or invalid (non-numeric, zero, or negative).
 */
export function parseDlqTtlDays(rawValue: string | undefined): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return DEFAULT_DLQ_TTL_DAYS;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      { rawValue },
      "oracle_dlq: invalid DLQ_TTL_DAYS, falling back to default of 7 days",
    );
    return DEFAULT_DLQ_TTL_DAYS;
  }

  return parsed;
}

/**
 * Delete DLQ entries older than the configured TTL (DLQ_TTL_DAYS, default 7
 * days). Logs the number of entries deleted. Returns that count.
 */
export async function evictExpiredDlqEntries(
  ttlDays: number = parseDlqTtlDays(process.env.DLQ_TTL_DAYS),
): Promise<number> {
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;

  try {
    const deleted = await getQueueStore().deleteExpired(cutoff);

    logger.info(
      { deleted, ttlDays },
      "oracle_dlq: TTL eviction run complete",
    );

    await emitDlqDepth();
    return deleted;
  } catch (err) {
    logger.error(
      { err: String(err), ttlDays },
      "oracle_dlq: TTL eviction run failed",
    );
    throw err;
  }
}

/**
 * Start the periodic DLQ TTL eviction task. Call once on startup.
 * Returns a cleanup function that stops the task.
 */
export function startDlqEvictionTask(
  intervalMs = DEFAULT_DLQ_EVICTION_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    evictExpiredDlqEntries().catch((err) => {
      logger.error({ err: String(err) }, "oracle_dlq: TTL eviction run failed");
    });
  }, intervalMs);

  return () => clearInterval(timer);
}
