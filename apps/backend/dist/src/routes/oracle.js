import { Router } from 'express';
import { matchStore } from '../store/index.js';
import { authenticate } from '../middleware/auth.js';
import { fetchLichessResult, GameNotFoundError } from '../fetchers/lichess.js';
import { fetchChessDotComResult } from '../fetchers/chessdotcom.js';
import { verifyPlayerIdentities } from '../services/player-identity.js';
const router = Router();
const store = matchStore;
// Oracle endpoints require authentication
router.use(authenticate);
/**
 * POST /api/oracle/submit-result
 *
 * Submit a verified game result to the oracle.
 *
 * Request body:
 * ```json
 * {
 *   "matchId": 1,
 *   "gameId": "abc123",
 *   "platform": "lichess",
 *   "username": "alice"  // Optional, required for Chess.com
 * }
 * ```
 *
 * This endpoint:
 * 1. Fetches the game result from the chess platform API
 * 2. Verifies that the players in the API response match the registered players
 * 3. Returns the verified result for the oracle to submit on-chain
 *
 * The oracle (a privileged service) must then sign the result and call the
 * escrow contract's `submit_result` method on Stellar Soroban.
 */
router.post('/submit-result', async (req, res) => {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Request body must be JSON' });
    }
    const { matchId, gameId, platform, username } = payload;
    // Validate input
    if (typeof matchId !== 'number' || !Number.isFinite(matchId)) {
        return res.status(400).json({ error: 'matchId must be a number' });
    }
    if (!gameId || typeof gameId !== 'string' || gameId.length === 0) {
        return res.status(400).json({ error: 'gameId is required' });
    }
    if (!platform || (platform !== 'lichess' && platform !== 'chessdotcom')) {
        return res.status(400).json({ error: 'platform must be lichess or chessdotcom' });
    }
    if (platform === 'chessdotcom' && (!username || typeof username !== 'string')) {
        return res.status(400).json({ error: 'username is required for chessdotcom' });
    }
    try {
        // Fetch the match record
        const match = await store.findByGameId(gameId);
        if (!match) {
            return res.status(404).json({
                error: 'Match not found',
                details: `No match found for gameId: ${gameId}`,
            });
        }
        // Ensure player identities were captured at match creation
        if (!match.player1Username || !match.player2Username) {
            return res.status(400).json({
                error: 'Player identities not recorded',
                details: 'Match was created without capturing player identities from the API',
            });
        }
        // Fetch the game result from the chess platform API
        let apiResult;
        try {
            if (platform === 'lichess') {
                apiResult = await fetchLichessResult(gameId);
            }
            else {
                apiResult = await fetchChessDotComResult(username, gameId);
            }
        }
        catch (error) {
            if (error instanceof GameNotFoundError) {
                return res.status(404).json({
                    error: 'Game not found on platform',
                    details: error.message,
                });
            }
            throw error;
        }
        // Create the identity map from the match record
        const identityMap = {
            player1Address: match.player1,
            player1Username: match.player1Username,
            player2Address: match.player2,
            player2Username: match.player2Username,
            platform,
        };
        // Verify that the API players match the registered players
        const verification = verifyPlayerIdentities(match, apiResult, identityMap);
        if (!verification.valid) {
            return res.status(400).json({
                error: 'Player identity verification failed',
                details: verification.error,
            });
        }
        // If verification passes, return the result that can be submitted on-chain
        return res.status(200).json({
            verified: true,
            matchId: match.matchId,
            gameId: apiResult.gameId,
            result: apiResult.result,
            whitePlayer: apiResult.whitePlayer,
            blackPlayer: apiResult.blackPlayer,
            status: apiResult.status,
            message: 'Game result verified. Players match registered identities.',
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return res.status(500).json({
            error: 'Result verification failed',
            details: message,
        });
    }
});
export default router;
