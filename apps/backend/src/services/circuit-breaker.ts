/**
 * Circuit Breaker for RPC Failures
 *
 * Prevents cascading failures when the Stellar RPC endpoint is degraded by:
 * 1. Counting consecutive RPC failures
 * 2. Opening the circuit after N failures (stopping job processing)
 * 3. Implementing an exponential backoff cooldown period
 * 4. Automatically recovering with exponential backoff recovery attempts
 *
 * States:
 * - CLOSED: Normal operation, accepting requests
 * - OPEN: Circuit open, rejecting requests, cooling down
 * - HALF_OPEN: Testing if service has recovered
 *
 * State persistence (#1716): see `initializeCircuitBreaker` below. Without
 * it, `getCircuitBreaker()`'s lazily-created instance is in-memory only and
 * resets to CLOSED on every restart, same as before this was added.
 */

import { SqliteCircuitBreakerStore } from '../store/sqlite-circuit-breaker-store.js';
import logger from '../logger.js';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening circuit */
  failureThreshold: number;
  
  /** Initial cooldown period in milliseconds */
  cooldownMs: number;
  
  /** Multiplier for exponential backoff (cooldown = cooldownMs * (backoffMultiplier ^ attemptCount)) */
  backoffMultiplier: number;
  
  /** Maximum cooldown period in milliseconds */
  maxCooldownMs: number;
  
  /** Number of successful half-open tests before closing circuit */
  successThreshold: number;
  
  /** Callback for state changes (for logging/monitoring) */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;

  /**
   * Callback invoked with a full snapshot after every state-affecting
   * mutation (recordSuccess, recordFailure, the OPEN->HALF_OPEN cooldown
   * transition, reset, and restoreState) so a caller can persist it (#1716).
   * Fire-and-forget: CircuitBreaker's own methods stay synchronous and never
   * await this, so a slow or failing persistence backend cannot block the
   * hot path that decides whether to allow a request.
   */
  onPersist?: (snapshot: PersistedCircuitBreakerState) => void | Promise<void>;
}

/**
 * The full state needed to restore a CircuitBreaker instance across a
 * process restart (#1716).
 */
export interface PersistedCircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  openedAt: number | null;
  attemptCount: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 30_000, // 30 seconds initial cooldown
  backoffMultiplier: 2,
  maxCooldownMs: 600_000, // 10 minutes max cooldown
  successThreshold: 2,
};

/**
 * Circuit breaker for protecting against cascading RPC failures.
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number | null = null;
  private openedAt: number | null = null;
  private attemptCount: number = 0;
  private config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get number of consecutive failures
   */
  getFailureCount(): number {
    return this.failureCount;
  }

  /**
   * Get number of consecutive successes in half-open state
   */
  getSuccessCount(): number {
    return this.successCount;
  }

  /**
   * Get remaining cooldown time in milliseconds (0 if not cooling down)
   */
  getRemainingCooldown(): number {
    if (this.state !== CircuitState.OPEN || this.openedAt === null) {
      return 0;
    }

    const cooldownDuration = this.calculateCooldown();
    const elapsed = Date.now() - this.openedAt;
    const remaining = Math.max(0, cooldownDuration - elapsed);

    return remaining;
  }

  /**
   * Get human-readable status for logging/monitoring
   */
  getStatus(): {
    state: CircuitState;
    failureCount: number;
    successCount: number;
    remainingCooldown: number;
    attemptCount: number;
  } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      remainingCooldown: this.getRemainingCooldown(),
      attemptCount: this.attemptCount,
    };
  }

  /**
   * Full snapshot of the fields needed to restore this breaker later
   * (#1716). Distinct from `getStatus()`, which is shaped for
   * logging/monitoring (includes a derived `remainingCooldown`) rather than
   * for exact reconstruction.
   */
  getSnapshot(): PersistedCircuitBreakerState {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      openedAt: this.openedAt,
      attemptCount: this.attemptCount,
    };
  }

  /**
   * Fire-and-forget persistence hook, called after every mutation (#1716).
   * Never throws or blocks the caller: a persistence failure is a durability
   * concern for the *next* restart, not a reason to fail the in-memory state
   * transition that is already correct for this process's lifetime.
   */
  private persist(): void {
    if (!this.config.onPersist) {
      return;
    }
    try {
      Promise.resolve(this.config.onPersist(this.getSnapshot())).catch(
        () => {
          // Swallowed deliberately: onPersist implementations are
          // responsible for their own error logging (see
          // initializeCircuitBreaker below). A rejected persist must not
          // become an unhandled rejection here.
        },
      );
    } catch {
      // Synchronous throw from onPersist itself — same reasoning as above.
    }
  }

  /**
   * Restore this breaker's state from a previously persisted snapshot
   * (#1716), applied once on startup before any request is processed.
   *
   * If the restored state is OPEN or HALF_OPEN and the cooldown ("half-open
   * timeout") for the persisted attempt count has already elapsed relative
   * to `now` -- e.g. the process was down for longer than the cooldown
   * period -- the stale state is discarded and the breaker resumes CLOSED
   * instead of staying stuck open or immediately re-testing. This mirrors
   * exactly the check `allowRequest()` already performs for a breaker that
   * stayed running the whole time; restoring from disk must not bypass it.
   */
  restoreState(persisted: PersistedCircuitBreakerState, now: number = Date.now()): void {
    this.state = persisted.state;
    this.failureCount = persisted.failureCount;
    this.successCount = persisted.successCount;
    this.lastFailureTime = persisted.lastFailureTime;
    this.openedAt = persisted.openedAt;
    this.attemptCount = persisted.attemptCount;

    if (this.state === CircuitState.OPEN || this.state === CircuitState.HALF_OPEN) {
      const referenceTime = this.openedAt ?? this.lastFailureTime;
      const cooldownDuration = this.calculateCooldown();
      const elapsed = referenceTime === null ? Infinity : now - referenceTime;

      if (elapsed >= cooldownDuration) {
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
        this.openedAt = null;
        this.attemptCount = 0;
      }
    }

    this.persist();
  }

  /**
   * Record a successful operation
   */
  recordSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount += 1;

      if (this.successCount >= this.config.successThreshold) {
        this.transitionState(CircuitState.CLOSED);
        this.failureCount = 0;
        this.successCount = 0;
        this.attemptCount = 0;
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Maintain success in closed state
      this.failureCount = 0;
    }
    this.persist();
  }

  /**
   * Record a failed operation
   * @returns true if circuit was opened, false otherwise
   */
  recordFailure(): boolean {
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      // Failure in half-open resets to open
      this.transitionState(CircuitState.OPEN);
      this.successCount = 0;
      this.attemptCount += 1;
      this.openedAt = Date.now();
      this.persist();
      return true;
    }

    if (this.state === CircuitState.CLOSED) {
      this.failureCount += 1;

      if (this.failureCount >= this.config.failureThreshold) {
        this.transitionState(CircuitState.OPEN);
        this.openedAt = Date.now();
        this.attemptCount = 0;
        this.persist();
        return true;
      }
    }

    this.persist();
    return false;
  }

  /**
   * Check if circuit allows requests (CLOSED or HALF_OPEN)
   */
  allowRequest(): boolean {
    if (this.state === CircuitState.CLOSED) {
      return true;
    }

    if (this.state === CircuitState.HALF_OPEN) {
      return true;
    }

    // Check if cooldown has expired
    if (this.state === CircuitState.OPEN && this.openedAt !== null) {
      const cooldownDuration = this.calculateCooldown();
      const elapsed = Date.now() - this.openedAt;

      if (elapsed >= cooldownDuration) {
        this.transitionState(CircuitState.HALF_OPEN);
        this.successCount = 0;
        this.failureCount = 0;
        this.persist();
        return true;
      }
    }

    return false;
  }

  /**
   * Reset circuit to closed state (useful for testing or manual intervention)
   */
  reset(): void {
    this.transitionState(CircuitState.CLOSED);
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.openedAt = null;
    this.attemptCount = 0;
    this.persist();
  }

  /**
   * Calculate current cooldown duration with exponential backoff
   */
  private calculateCooldown(): number {
    const exponentialCooldown = this.config.cooldownMs * Math.pow(this.config.backoffMultiplier, this.attemptCount);
    return Math.min(exponentialCooldown, this.config.maxCooldownMs);
  }

  /**
   * Transition between states
   */
  private transitionState(newState: CircuitState): void {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      this.config.onStateChange?.(oldState, newState);
    }
  }
}

/**
 * Global circuit breaker instance for RPC
 */
let globalCircuitBreaker: CircuitBreaker | null = null;
let circuitBreakerStore: SqliteCircuitBreakerStore | null = null;

/**
 * Get or create the global circuit breaker instance.
 *
 * If `initializeCircuitBreaker()` has not been called yet, this lazily
 * creates a purely in-memory breaker (no persistence) -- the same behaviour
 * as before #1716 existed, so tests and any code path that never calls
 * `initializeCircuitBreaker()` are unaffected.
 */
export function getCircuitBreaker(config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
  if (!globalCircuitBreaker) {
    globalCircuitBreaker = new CircuitBreaker(config);
  }
  return globalCircuitBreaker;
}

/**
 * Reset the global circuit breaker (mainly for testing)
 */
export function resetCircuitBreaker(): void {
  if (globalCircuitBreaker) {
    globalCircuitBreaker.reset();
  }
  globalCircuitBreaker = null;
}

/**
 * Initialise the global circuit breaker with SQLite-backed persistence
 * (#1716). Call once on application startup, before the breaker is used
 * (i.e. before `startRetryWorker`). Loads any previously persisted state —
 * discarding it in favour of CLOSED if it is stale, per
 * `CircuitBreaker.restoreState` — and wires every subsequent state change to
 * be saved back to the same store.
 */
export async function initializeCircuitBreaker(
  config?: Partial<CircuitBreakerConfig>,
  store: SqliteCircuitBreakerStore = new SqliteCircuitBreakerStore(),
): Promise<CircuitBreaker> {
  await store.initialize();
  circuitBreakerStore = store;

  const breaker = new CircuitBreaker({
    ...config,
    onPersist: async (snapshot) => {
      try {
        await store.save(snapshot);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'circuit_breaker: failed to persist state',
        );
      }
      await config?.onPersist?.(snapshot);
    },
  });

  const persisted = await store.load();
  if (persisted) {
    breaker.restoreState(persisted);
    logger.info(
      { ...breaker.getStatus() },
      'circuit_breaker: restored persisted state on startup',
    );
  } else {
    logger.info({}, 'circuit_breaker: no persisted state found, starting CLOSED');
  }

  globalCircuitBreaker = breaker;
  return breaker;
}

/**
 * Close the circuit breaker's persistence store cleanly on application exit.
 */
export async function closeCircuitBreakerStore(): Promise<void> {
  if (circuitBreakerStore) {
    await circuitBreakerStore.close();
    circuitBreakerStore = null;
  }
}
