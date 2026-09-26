import { Router } from 'express';
import { RateLimitStore, createRateLimitMiddleware } from '../middleware/rate-limit.js';
import { fetchLichessResult, GameNotFoundError } from '../fetchers/lichess.js';
import { fetchChessDotComResult } from '../fetchers/chessdotcom.js';
const router = Router();
// Rate limiter: 100 requests per 60 seconds per IP
const rateLimitStore = new RateLimitStore(100, 60 * 1000, 100);
router.use(createRateLimitMiddleware(rateLimitStore));
router.post('/', async (req, res) => {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Request body must be JSON' });
    }
    const { gameId, platform, username } = payload;
    if (!gameId || typeof gameId !== 'string' || gameId.length === 0) {
        return res.status(400).json({ error: 'gameId is required' });
    }
    if (gameId.length >= 512) {
        return res.status(400).json({ error: 'gameId is too long' });
    }
    if (!platform || (platform !== 'lichess' && platform !== 'chessdotcom')) {
        return res.status(400).json({ error: 'platform must be lichess or chessdotcom' });
    }
    try {
        let response;
        if (platform === 'lichess') {
            const result = await fetchLichessResult(gameId);
            response = {
                valid: true,
                platform: 'lichess',
                gameId: result.gameId,
                status: result.status,
                whitePlayer: result.whitePlayer,
                blackPlayer: result.blackPlayer,
                result: result.result,
            };
        }
        else {
            if (!username || typeof username !== 'string' || username.length === 0) {
                return res.status(400).json({
                    error: 'username is required for chessdotcom validation to look up game archives',
                });
            }
            const result = await fetchChessDotComResult(username, gameId);
            response = {
                valid: true,
                platform: 'chessdotcom',
                gameId: result.gameId,
                status: result.status,
                whitePlayer: result.whitePlayer,
                blackPlayer: result.blackPlayer,
                result: result.result,
            };
        }
        return res.status(200).json(response);
    }
    catch (error) {
        if (error instanceof GameNotFoundError) {
            return res.status(404).json({
                valid: false,
                platform,
                gameId,
                message: error.message,
            });
        }
        const message = error instanceof Error ? error.message : 'Unknown error';
        return res.status(500).json({
            valid: false,
            platform,
            gameId,
            message: `Validation failed: ${message}`,
        });
    }
});
export default router;
