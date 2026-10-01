import { Request, Response, NextFunction } from 'express';
import { ErrorCode, errorEnvelope } from '../errors/errorResponse.js';
import { SqliteRateLimitStore } from '../store/sqlite-rate-limit-store.js';
import logger from '../logger.js';

/**
 * Result of a rate-limit check: whether the request is allowed, and — when
 * not — how long the caller should wait before retrying.
 */
export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

/**
 * A pluggable rate-limit counter backend (#1723).
 *
 * `RateLimitStore` (in-memory, below) and `SqliteRateLimitStore`
 * (`store/sqlite-rate-limit-store.ts`) both implement this. The middleware
 * only ever depends on this interface, never on a concrete backend, so
 * swapping backends via `RATE_LIMIT_STORE` requires no change to
 * `createRateLimitMiddleware` or the routes that use it.
 */
export interface RateLimitBackend {
  isAllowed(clientId: string): Promise<RateLimitResult>;
  getRemainingTokens(clientId: string): Promise<number>;
  destroy(): Promise<void> | void;
}

/**
 * In-memory token-bucket rate limiter. Tracks requests per IP address.
 *
 * Each process keeps its own counters — in a horizontally scaled deployment
 * with multiple backend instances behind a load balancer, each instance
 * enforces the configured limit independently, effectively multiplying the
 * real allowed rate by the instance count (#1723). Use
 * `SqliteRateLimitStore` (via `RATE_LIMIT_STORE=sqlite`) for a limit that
 * holds across instances; this remains the default for local development
 * and single-instance deployments, where the shared-storage overhead buys
 * nothing.
 */
interface ClientBucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimitStore implements RateLimitBackend {
  private buckets: Map<string, ClientBucket> = new Map();
  private readonly capacity: number;
  private readonly refillIntervalMs: number;
  private readonly refillAmount: number;
  private cleanupInterval: NodeJS.Timeout;

  /**
   * @param capacity - Maximum tokens per bucket (e.g., 100 requests)
   * @param refillIntervalMs - Interval to add tokens (e.g., 60000ms = 1 minute)
   * @param refillAmount - Tokens to add per interval (e.g., 100 requests per minute)
   */
  constructor(capacity: number, refillIntervalMs: number, refillAmount: number) {
    this.capacity = capacity;
    this.refillIntervalMs = refillIntervalMs;
    this.refillAmount = refillAmount;

    // Clean up old buckets every 10 minutes to prevent memory leaks
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 10 * 60 * 1000);
  }

  /**
   * Check if a client has exceeded the rate limit.
   * Returns true if the request is allowed, false if rate limited.
   * When rate limited, also returns the time in seconds until the next token is available.
   */
  async isAllowed(clientId: string): Promise<RateLimitResult> {
    const now = Date.now();
    let bucket = this.buckets.get(clientId);

    if (!bucket) {
      // First request from this client
      bucket = { tokens: this.capacity - 1, lastRefill: now };
      this.buckets.set(clientId, bucket);
      return { allowed: true };
    }

    // Refill tokens based on elapsed time
    const elapsedMs = now - bucket.lastRefill;
    const refills = Math.floor(elapsedMs / this.refillIntervalMs);

    if (refills > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refills * this.refillAmount);
      bucket.lastRefill = now;
    }

    // Check if request is allowed
    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    // Rate limited — calculate time until next refill
    const timeSinceLastRefill = now - bucket.lastRefill;
    const timeUntilNextRefillMs = this.refillIntervalMs - timeSinceLastRefill;
    const retryAfterSeconds = Math.ceil(timeUntilNextRefillMs / 1000);

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
    };
  }

  /**
   * Get the number of remaining tokens for a client (for diagnostics).
   */
  async getRemainingTokens(clientId: string): Promise<number> {
    const bucket = this.buckets.get(clientId);
    if (!bucket) {
      return this.capacity;
    }

    const now = Date.now();
    const elapsedMs = now - bucket.lastRefill;
    const refills = Math.floor(elapsedMs / this.refillIntervalMs);

    return Math.min(this.capacity, bucket.tokens + refills * this.refillAmount);
  }

  /**
   * Remove old buckets that haven't been used recently.
   * A bucket is considered stale if no requests in 30 minutes.
   */
  private cleanup(): void {
    const now = Date.now();
    const staleThresholdMs = 30 * 60 * 1000;

    for (const [clientId, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > staleThresholdMs) {
        this.buckets.delete(clientId);
      }
    }
  }

  /**
   * Stop the cleanup interval. Call this during server shutdown.
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}

interface RateLimitMiddlewareOptions {
  keyExtractor?: (req: Request) => string;
  statusCode?: number;
  message?: string;
  /**
   * IP addresses of proxies that this server trusts to set the X-Forwarded-For
   * header (e.g. a reverse proxy like nginx or a load balancer).
   *
   * The X-Forwarded-For header is only honored when the request's direct
   * connection peer (req.socket.remoteAddress) is in this list. Defaults to an
   * empty list, meaning the header is never trusted and the direct connection
   * IP is used for rate limiting.
   */
  trustedProxies?: string[];
}

/**
 * Express middleware factory for rate limiting by IP address.
 *
 * @param store - Any RateLimitBackend (in-memory or SQLite-backed; #1723)
 * @param options - Configuration options
 * @returns Express middleware function
 *
 * Example usage:
 * ```
 * const limiter = await createRateLimitStore(100, 60000, 100); // 100 req/min
 * router.use(createRateLimitMiddleware(limiter, { trustedProxies: ['127.0.0.1'] }));
 * ```
 */
export function createRateLimitMiddleware(
  store: RateLimitBackend,
  options?: RateLimitMiddlewareOptions,
) {
  const trustedProxies = options?.trustedProxies || [];
  const keyExtractor = options?.keyExtractor || ((req: Request) => getClientIp(req, trustedProxies));
  const statusCode = options?.statusCode || 429;
  const message = options?.message || 'Too many requests, please try again later';

  return (req: Request, res: Response, next: NextFunction) => {
    const clientId = keyExtractor(req);

    store
      .isAllowed(clientId)
      .then(async (result) => {
        // Set rate limit headers for all responses
        const remainingTokens = await store.getRemainingTokens(clientId);
        res.setHeader('X-RateLimit-Limit', '100'); // capacity
        res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remainingTokens)));

        if (!result.allowed) {
          // Set Retry-After header per RFC 6585
          if (result.retryAfterSeconds) {
            res.setHeader('Retry-After', String(result.retryAfterSeconds));
          }

          res.status(statusCode).json(errorEnvelope(ErrorCode.RATE_LIMITED, message));
          return;
        }

        next();
      })
      .catch((error) => {
        // A rate-limit backend failure (e.g. the shared SQLite file is
        // temporarily locked) must not take the whole route down with it —
        // log and fail open, since a brief lapse in rate limiting is a much
        // smaller problem than refusing all traffic because the limiter
        // itself errored.
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          'rate_limit_backend_error_failing_open',
        );
        next();
      });
  };
}

export type RateLimitStoreType = 'memory' | 'sqlite';

/**
 * Decide which rate-limit backend to use for a given `RATE_LIMIT_STORE`
 * value, without touching disk (#1723). Exported for unit testing, mirroring
 * `queue.ts`'s `resolveQueueStoreType`.
 *
 *   'sqlite' / 'redis' (not yet implemented, falls back to sqlite) → sqlite
 *   'memory' / unset                                               → memory
 *
 * Unlike the queue store, memory stays the default here even in production:
 * a single-instance deployment gains nothing from the SQLite backend's extra
 * I/O, and this is only a real correctness issue once an operator actually
 * runs more than one backend instance — at which point they are expected to
 * set `RATE_LIMIT_STORE=sqlite` explicitly, which also makes the choice to
 * accept the shared-file write contention a deliberate one rather than an
 * invisible default.
 */
export function resolveRateLimitStoreType(rawValue: string | undefined): RateLimitStoreType {
  const requested = (rawValue || 'memory').toLowerCase();
  if (requested === 'sqlite' || requested === 'redis') {
    if (requested === 'redis') {
      logger.warn(
        { requested },
        'rate_limit: RATE_LIMIT_STORE=redis requested but no Redis client is installed; falling back to sqlite',
      );
    }
    return 'sqlite';
  }
  return 'memory';
}

/**
 * Build and initialize a `RateLimitBackend` per the `RATE_LIMIT_STORE`
 * environment variable (#1723). This is the entry point routes should use
 * instead of constructing `RateLimitStore` directly, so the backend they get
 * is configurable without the route itself knowing which one is active.
 */
export async function createRateLimitStore(
  capacity: number,
  refillIntervalMs: number,
  refillAmount: number,
  dbPath?: string,
): Promise<RateLimitBackend> {
  const resolved = resolveRateLimitStoreType(process.env.RATE_LIMIT_STORE);

  if (resolved === 'memory') {
    return new RateLimitStore(capacity, refillIntervalMs, refillAmount);
  }

  const store = new SqliteRateLimitStore(capacity, refillIntervalMs, refillAmount, dbPath);
  await store.initialize();
  logger.info({ store: resolved }, 'rate_limit: store initialized');
  return store;
}

/**
 * Extract the client's IP address from the request.
 *
 * The X-Forwarded-For header is only honored when the request arrives directly
 * from a trusted proxy; otherwise a client could spoof the header to cycle
 * through fake IPs and bypass per-IP rate limiting.
 */
function getClientIp(req: Request, trustedProxies: string[]): string {
  const remoteAddress = req.socket.remoteAddress || 'unknown';

  if (trustedProxies.includes(remoteAddress)) {
    const forwarded = req.header('X-Forwarded-For');
    if (forwarded) {
      // X-Forwarded-For can be a comma-separated list; take the first IP (the original client)
      return forwarded.split(',')[0].trim();
    }
  }

  return remoteAddress;
}
