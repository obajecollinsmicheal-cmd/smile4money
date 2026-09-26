import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitState,
  getCircuitBreaker,
  resetCircuitBreaker,
} from '../src/services/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    resetCircuitBreaker();
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 1000,
      backoffMultiplier: 2,
      maxCooldownMs: 10000,
      successThreshold: 2,
    });
    vi.useFakeTimers();
  });

  describe('Initial state', () => {
    it('starts in CLOSED state', () => {
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('has zero failures', () => {
      expect(breaker.getFailureCount()).toBe(0);
    });

    it('allows requests when closed', () => {
      expect(breaker.allowRequest()).toBe(true);
    });

    it('has zero remaining cooldown', () => {
      expect(breaker.getRemainingCooldown()).toBe(0);
    });
  });

  describe('Failure tracking (CLOSED state)', () => {
    it('increments failure count', () => {
      breaker.recordFailure();
      expect(breaker.getFailureCount()).toBe(1);
      breaker.recordFailure();
      expect(breaker.getFailureCount()).toBe(2);
    });

    it('opens circuit after threshold failures', () => {
      expect(breaker.recordFailure()).toBe(false); // 1st failure
      expect(breaker.getFailureCount()).toBe(1);
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      expect(breaker.recordFailure()).toBe(false); // 2nd failure
      expect(breaker.getFailureCount()).toBe(2);
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      expect(breaker.recordFailure()).toBe(true); // 3rd failure - opens circuit
      expect(breaker.getFailureCount()).toBe(3);
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('resets failure count on success', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getFailureCount()).toBe(2);

      breaker.recordSuccess();
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  describe('Circuit open state', () => {
    beforeEach(() => {
      // Open the circuit
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('rejects requests when open', () => {
      expect(breaker.allowRequest()).toBe(false);
    });

    it('reports remaining cooldown', () => {
      const remaining = breaker.getRemainingCooldown();
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(1000);
    });

    it('transitions to HALF_OPEN after cooldown expires', () => {
      expect(breaker.allowRequest()).toBe(false);
      vi.advanceTimersByTime(1000);
      expect(breaker.allowRequest()).toBe(true);
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('allows requests after transitioning to HALF_OPEN', () => {
      vi.advanceTimersByTime(1000);
      expect(breaker.allowRequest()).toBe(true);
    });
  });

  describe('Half-open state', () => {
    beforeEach(() => {
      // Open and transition to half-open
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      vi.advanceTimersByTime(1000);
      breaker.allowRequest(); // Transition to HALF_OPEN
    });

    it('is in HALF_OPEN state', () => {
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('closes circuit after threshold successes', () => {
      breaker.recordSuccess();
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
      expect(breaker.getSuccessCount()).toBe(1);

      breaker.recordSuccess();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(breaker.getSuccessCount()).toBe(0);
      expect(breaker.getFailureCount()).toBe(0);
    });

    it('reopens circuit on failure in HALF_OPEN', () => {
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
      expect(breaker.getSuccessCount()).toBe(0);
    });
  });

  describe('Exponential backoff', () => {
    it('increases cooldown on subsequent failures', () => {
      // First failure cycle
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure();
      }
      const cooldown1 = breaker.getRemainingCooldown();

      // Wait for cooldown to expire
      vi.advanceTimersByTime(cooldown1);
      breaker.allowRequest(); // Transition to HALF_OPEN

      // Fail again
      breaker.recordFailure();
      const cooldown2 = breaker.getRemainingCooldown();

      // Second cooldown should be longer (with backoff multiplier of 2)
      expect(cooldown2).toBeGreaterThan(cooldown1);
      expect(cooldown2).toBe(cooldown1 * 2);
    });

    it('caps cooldown at maximum', () => {
      // Trigger many failures to reach max cooldown
      for (let i = 0; i < 20; i++) {
        // Open circuit
        for (let j = 0; j < 3; j++) {
          breaker.recordFailure();
        }
        const cooldown = breaker.getRemainingCooldown();
        if (cooldown >= 10000) {
          // Reached max
          expect(cooldown).toBe(10000);
          break;
        }
        // Wait and transition to half-open
        vi.advanceTimersByTime(cooldown + 1);
        breaker.allowRequest();
      }
    });
  });

  describe('Reset', () => {
    it('resets all state', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getFailureCount()).toBe(2);
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      breaker.reset();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(breaker.getFailureCount()).toBe(0);
      expect(breaker.getSuccessCount()).toBe(0);
      expect(breaker.getRemainingCooldown()).toBe(0);
    });

    it('allows requests after reset', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.allowRequest()).toBe(false);

      breaker.reset();
      expect(breaker.allowRequest()).toBe(true);
    });
  });

  describe('Status reporting', () => {
    it('returns complete status', () => {
      breaker.recordFailure();
      const status = breaker.getStatus();

      expect(status).toEqual({
        state: CircuitState.CLOSED,
        failureCount: 1,
        successCount: 0,
        remainingCooldown: 0,
        attemptCount: 0,
      });
    });

    it('updates status after opening circuit', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      const status = breaker.getStatus();
      expect(status.state).toBe(CircuitState.OPEN);
      expect(status.failureCount).toBe(3);
      expect(status.remainingCooldown).toBeGreaterThan(0);
    });
  });

  describe('State change callbacks', () => {
    it('calls onStateChange callback on transition', () => {
      const onStateChange = vi.fn();
      const cb = new CircuitBreaker({
        failureThreshold: 2,
        onStateChange,
      });

      cb.recordFailure();
      expect(onStateChange).not.toHaveBeenCalled();

      cb.recordFailure();
      expect(onStateChange).toHaveBeenCalledWith(CircuitState.CLOSED, CircuitState.OPEN);
    });

    it('does not call callback on redundant state transitions', () => {
      const onStateChange = vi.fn();
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 1000,
        onStateChange,
      });

      cb.recordFailure();
      expect(onStateChange).toHaveBeenCalledTimes(1);

      // Advance time but not enough for cooldown
      vi.advanceTimersByTime(500);
      cb.allowRequest();
      expect(onStateChange).toHaveBeenCalledTimes(1); // No new call
    });
  });

  describe('Global circuit breaker', () => {
    it('returns same instance on multiple calls', () => {
      resetCircuitBreaker();
      const breaker1 = getCircuitBreaker();
      const breaker2 = getCircuitBreaker();
      expect(breaker1).toBe(breaker2);
    });

    it('allows configuration on first call', () => {
      resetCircuitBreaker();
      const breaker = getCircuitBreaker({ failureThreshold: 10 });
      expect(breaker.getStatus().failureCount).toBe(0);

      // Record 9 failures - should not open
      for (let i = 0; i < 9; i++) {
        breaker.recordFailure();
      }
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      // 10th failure opens circuit
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('resets properly', () => {
      resetCircuitBreaker();
      const breaker = getCircuitBreaker();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getFailureCount()).toBe(2);

      resetCircuitBreaker();
      const newBreaker = getCircuitBreaker();
      expect(newBreaker.getFailureCount()).toBe(0);
    });
  });

  describe('Realistic RPC failure scenario', () => {
    it('handles consecutive RPC failures correctly', () => {
      // Simulate RPC endpoint going down
      for (let i = 0; i < 3; i++) {
        const opened = breaker.recordFailure();
        if (i === 2) {
          expect(opened).toBe(true);
        }
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);
      expect(breaker.allowRequest()).toBe(false);

      // Wait for cooldown
      vi.advanceTimersByTime(1000);
      expect(breaker.allowRequest()).toBe(true);
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      // Test recovery
      breaker.recordSuccess();
      breaker.recordSuccess();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('handles transient failures', () => {
      // One failure, then recovery
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      breaker.recordSuccess();
      expect(breaker.getFailureCount()).toBe(0);
      expect(breaker.allowRequest()).toBe(true);
    });

    it('survives repeated outages', () => {
      for (let outage = 0; outage < 3; outage++) {
        // Trigger outage
        for (let i = 0; i < 3; i++) {
          breaker.recordFailure();
        }
        expect(breaker.getState()).toBe(CircuitState.OPEN);

        // Wait for recovery
        const cooldown = breaker.getRemainingCooldown();
        vi.advanceTimersByTime(cooldown + 1);
        breaker.allowRequest();

        // Recover
        breaker.recordSuccess();
        breaker.recordSuccess();
        expect(breaker.getState()).toBe(CircuitState.CLOSED);
      }
    });
  });
});
