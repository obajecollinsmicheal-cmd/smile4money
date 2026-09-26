/**
 * Bottleneck Rate Limiter Configuration
 *
 * Manages rate limiters for external APIs using Bottleneck.
 * Each API service (Lichess, Chess.com) has its own rate limiter instance.
 */
import Bottleneck from 'bottleneck';
import logger from '../logger.js';
/**
 * Create a Bottleneck limiter instance with the specified configuration.
 * Uses a reservoir-based approach: maxRequests per periodMs.
 */
function createLimiter(options) {
    const config = {
        minTime: 0,
        maxConcurrent: options.maxConcurrent || 1,
        reservoir: options.maxRequests,
        reservoirRefreshAmount: options.maxRequests,
        reservoirRefreshInterval: options.periodMs,
    };
    const limiter = new Bottleneck(config);
    // Log rate limit events
    limiter.on('debug', (eventInfo, param) => {
        if (eventInfo.message === 'Dropping due to time limit') {
            const counts = limiter.counts();
            logger.debug({ service: options.name, queued: counts.QUEUED }, `${options.name}: request queued (${counts.QUEUED} waiting)`);
        }
    });
    // Track errors
    limiter.on('error', (error) => {
        logger.error({ service: options.name, error }, `${options.name}: limiter error`);
    });
    logger.info({
        service: options.name,
        maxRequests: options.maxRequests,
        periodSeconds: options.periodMs / 1000,
        maxConcurrent: config.maxConcurrent,
    }, `${options.name} rate limiter configured`);
    return limiter;
}
/**
 * Get Lichess API rate limiter.
 * Default: 30 requests per 60 seconds (safe margin below 60 req/min limit).
 */
export function getLichessLimiter() {
    const maxRequests = parseInt(process.env.LICHESS_RATE_LIMIT || '30', 10);
    const periodMs = parseInt(process.env.LICHESS_RATE_PERIOD_MS || String(60000), 10);
    return createLimiter({
        name: 'Lichess',
        maxRequests,
        periodMs,
        maxConcurrent: 1, // Lichess prefers sequential requests
    });
}
/**
 * Get Chess.com API rate limiter.
 * Default: 20 requests per 60 seconds (conservative, as limits are undocumented).
 */
export function getChessDotComLimiter() {
    const maxRequests = parseInt(process.env.CHESSDOTCOM_RATE_LIMIT || '20', 10);
    const periodMs = parseInt(process.env.CHESSDOTCOM_RATE_PERIOD_MS || String(60000), 10);
    return createLimiter({
        name: 'Chess.com',
        maxRequests,
        periodMs,
        maxConcurrent: 1, // Chess.com also prefers sequential requests
    });
}
/**
 * Singleton instances (created on first access).
 */
let lichessLimiter = null;
let chessDotComLimiter = null;
/**
 * Get or create the Lichess limiter singleton.
 */
export function getLichessLimiterSingleton() {
    if (!lichessLimiter) {
        lichessLimiter = getLichessLimiter();
    }
    return lichessLimiter;
}
/**
 * Get or create the Chess.com limiter singleton.
 */
export function getChessDotComLimiterSingleton() {
    if (!chessDotComLimiter) {
        chessDotComLimiter = getChessDotComLimiter();
    }
    return chessDotComLimiter;
}
/**
 * Get current stats for all limiters.
 */
export function getAllLimiterStats() {
    const stats = {};
    if (lichessLimiter) {
        const counts = lichessLimiter.counts();
        stats.lichess = {
            queued: counts.QUEUED,
            executing: counts.EXECUTING,
        };
    }
    if (chessDotComLimiter) {
        const counts = chessDotComLimiter.counts();
        stats.chessdotcom = {
            queued: counts.QUEUED,
            executing: counts.EXECUTING,
        };
    }
    return stats;
}
