import { Router } from 'express';
import { checkStellarRpc } from '../services/stellar.js';
import { getAllLimiterStats } from '../services/bottleneck-limiters.js';
const router = Router();
const startTime = Date.now();
router.get('/', async (req, res) => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const version = process.env.BACKEND_VERSION ?? process.env.npm_package_version ?? 'unknown';
    const response = {
        status: 'ok',
        uptime,
        version,
    };
    // Include rate limiter stats if requested
    if (process.env.HEALTH_INCLUDE_LIMITERS === 'true') {
        response.limiters = getAllLimiterStats();
    }
    if (process.env.DEEP_HEALTH === 'true') {
        try {
            await checkStellarRpc();
        }
        catch (error) {
            return res.status(503).json({
                status: 'error',
                uptime,
                version: response.version,
                error: String(error instanceof Error ? error.message : 'rpc unreachable'),
            });
        }
    }
    res.status(200).json(response);
});
export default router;
