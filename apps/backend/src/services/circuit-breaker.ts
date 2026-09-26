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
 */

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
      return true;
    }

    if (this.state === CircuitState.CLOSED) {
      this.failureCount += 1;

      if (this.failureCount >= this.config.failureThreshold) {
        this.transitionState(CircuitState.OPEN);
        this.openedAt = Date.now();
        this.attemptCount = 0;
        return true;
      }
    }

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

/**
 * Get or create the global circuit breaker instance
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
