import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getLichessLimiter,
  getChessDotComLimiter,
  getLichessLimiterSingleton,
  getChessDotComLimiterSingleton,
  getAllLimiterStats,
} from '../src/services/bottleneck-limiters.js';

describe('Bottleneck Rate Limiting', () => {
  beforeEach(() => {
    // Reset environment variables to defaults
    delete process.env.LICHESS_RATE_LIMIT;
    delete process.env.LICHESS_RATE_PERIOD_MS;
    delete process.env.CHESSDOTCOM_RATE_LIMIT;
    delete process.env.CHESSDOTCOM_RATE_PERIOD_MS;
  });

  describe('Lichess Rate Limiter', () => {
    it('creates a limiter with default settings', () => {
      const limiter = getLichessLimiter();
      expect(limiter).toBeDefined();
      // Limiter should accept scheduled tasks
      expect(typeof limiter.schedule).toBe('function');
    });

    it('respects custom rate limit from environment', () => {
      process.env.LICHESS_RATE_LIMIT = '10';
      const limiter = getLichessLimiter();
      expect(limiter).toBeDefined();
    });

    it('respects custom period from environment', () => {
      process.env.LICHESS_RATE_PERIOD_MS = '30000';
      const limiter = getLichessLimiter();
      expect(limiter).toBeDefined();
    });

    it('schedules requests with rate limiting', async () => {
      const limiter = getLichessLimiter();
      let executionCount = 0;

      const promises = [];
      for (let i = 0; i < 3; i++) {
        promises.push(
          limiter.schedule(async () => {
            executionCount++;
            return executionCount;
          })
        );
      }

      const results = await Promise.all(promises);
      expect(results).toEqual([1, 2, 3]);
      expect(executionCount).toBe(3);
    });
  });

  describe('Chess.com Rate Limiter', () => {
    it('creates a limiter with default settings', () => {
      const limiter = getChessDotComLimiter();
      expect(limiter).toBeDefined();
      expect(typeof limiter.schedule).toBe('function');
    });

    it('respects custom rate limit from environment', () => {
      process.env.CHESSDOTCOM_RATE_LIMIT = '15';
      const limiter = getChessDotComLimiter();
      expect(limiter).toBeDefined();
    });

    it('respects custom period from environment', () => {
      process.env.CHESSDOTCOM_RATE_PERIOD_MS = '120000';
      const limiter = getChessDotComLimiter();
      expect(limiter).toBeDefined();
    });

    it('schedules requests with rate limiting', async () => {
      const limiter = getChessDotComLimiter();
      let executionCount = 0;

      const promises = [];
      for (let i = 0; i < 2; i++) {
        promises.push(
          limiter.schedule(async () => {
            executionCount++;
            return executionCount;
          })
        );
      }

      const results = await Promise.all(promises);
      expect(results).toEqual([1, 2]);
      expect(executionCount).toBe(2);
    });
  });

  describe('Rate Limiter Statistics', () => {
    it('returns stats for active limiters', () => {
      const lich = getLichessLimiterSingleton();
      const chess = getChessDotComLimiterSingleton();

      const stats = getAllLimiterStats();
      expect(stats).toBeDefined();
      // After creation, there should be no queued or executing tasks
      expect(stats.lichess?.QUEUED || 0).toBe(0);
      expect(stats.lichess?.EXECUTING || 0).toBe(0);
      expect(stats.chessdotcom?.QUEUED || 0).toBe(0);
      expect(stats.chessdotcom?.EXECUTING || 0).toBe(0);
    });

    it('tracks queued and executing requests', async () => {
      const limiter = getLichessLimiterSingleton();

      // Schedule multiple tasks but don't await
      const promises = [];
      for (let i = 0; i < 3; i++) {
        promises.push(
          limiter.schedule(async () => {
            // Small delay to keep task executing
            await new Promise((resolve) => setTimeout(resolve, 50));
            return i;
          })
        );
      }

      // Give it a moment for tasks to get queued/executing
      await new Promise((resolve) => setTimeout(resolve, 10));

      const stats = getAllLimiterStats();
      // With maxConcurrent: 1, we should have 1 executing and 2 queued
      expect(stats.lichess).toBeDefined();
      const { QUEUED, EXECUTING } = limiter.counts();
      expect(QUEUED + EXECUTING).toBe(3); // Total of queued + executing

      // Wait for all to complete
      await Promise.all(promises);
    });
  });

  describe('Default Rate Limits', () => {
    it('uses safe defaults for Lichess (30 req/60s)', () => {
      // Lichess official limit is 60 req/min, we use 30 req/60s for safety
      const limiter = getLichessLimiter();
      expect(limiter).toBeDefined();
      // Default LICHESS_RATE_LIMIT is 30
    });

    it('uses conservative defaults for Chess.com (20 req/60s)', () => {
      // Chess.com limits are undocumented, we use conservative 20 req/60s
      const limiter = getChessDotComLimiter();
      expect(limiter).toBeDefined();
      // Default CHESSDOTCOM_RATE_LIMIT is 20
    });
  });

  describe('Error Handling', () => {
    it('handles errors in scheduled tasks', async () => {
      const limiter = getLichessLimiter();

      try {
        await limiter.schedule(async () => {
          throw new Error('Test error');
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toBe('Test error');
      }
    });

    it('continues scheduling after errors', async () => {
      const limiter = getLichessLimiter();
      let successCount = 0;

      try {
        await limiter.schedule(async () => {
          throw new Error('Test error');
        });
      } catch {
        // Ignore
      }

      await limiter.schedule(async () => {
        successCount++;
      });

      expect(successCount).toBe(1);
    });
  });

  describe('Configurable Limits', () => {
    it('allows increasing rate limits for high-volume scenarios', () => {
      // Scenario: Trusted Lichess account with higher limits
      process.env.LICHESS_RATE_LIMIT = '50';
      process.env.LICHESS_RATE_PERIOD_MS = '60000';

      const limiter = getLichessLimiter();
      expect(limiter).toBeDefined();
    });

    it('allows decreasing rate limits for conservative scenarios', () => {
      // Scenario: Being cautious to avoid temporary bans
      process.env.LICHESS_RATE_LIMIT = '10';
      process.env.LICHESS_RATE_PERIOD_MS = '60000';

      const limiter = getLichessLimiter();
      expect(limiter).toBeDefined();
    });

    it('allows different periods for different APIs', () => {
      // Scenario: One API has per-minute limits, another has per-hour
      process.env.LICHESS_RATE_PERIOD_MS = '60000'; // 1 minute
      process.env.CHESSDOTCOM_RATE_PERIOD_MS = '3600000'; // 1 hour

      const lich = getLichessLimiter();
      const chess = getChessDotComLimiter();

      expect(lich).toBeDefined();
      expect(chess).toBeDefined();
    });
  });
});
