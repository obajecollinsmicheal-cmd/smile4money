import axios from 'axios';
export class GameNotFoundError extends Error {
    constructor(gameId) {
        super(`Lichess game not found: ${gameId}`);
        this.name = 'GameNotFoundError';
    }
}
const TERMINAL_STATUSES = new Set([
    'mate', 'resign', 'stalemate', 'timeout', 'draw', 'outoftime',
    'cheat', 'noStart', 'unknownFinish', 'variantEnd',
]);
/**
 * Fetches a Lichess game result and returns a normalised GameResult.
 *
 * - Throws GameNotFoundError on HTTP 404.
 * - Returns result: null when the game is still in progress.
 * - Maps winner field to MatchResult (Player1 = white, Player2 = black).
 */
export async function fetchLichessResult(gameId) {
    const token = process.env.LICHESS_API_TOKEN;
    const url = `https://lichess.org/api/game/${encodeURIComponent(gameId)}`;
    const response = await axios.get(url, {
        headers: {
            Accept: 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeout: 10000,
        validateStatus: (s) => s < 500,
    });
    if (response.status === 404) {
        throw new GameNotFoundError(gameId);
    }
    if (response.status !== 200) {
        throw new Error(`Lichess API error: ${response.status}`);
    }
    const data = response.data;
    const isTerminal = TERMINAL_STATUSES.has(data.status);
    let result = null;
    if (isTerminal) {
        if (data.winner === 'white')
            result = 'Player1Wins';
        else if (data.winner === 'black')
            result = 'Player2Wins';
        else
            result = 'Draw';
    }
    return {
        gameId: data.id,
        status: data.status,
        whitePlayer: data.players.white.user?.name ?? 'unknown',
        blackPlayer: data.players.black.user?.name ?? 'unknown',
        result,
    };
}
