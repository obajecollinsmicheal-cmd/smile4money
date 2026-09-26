import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { fetchLichessResult, GameNotFoundError } from '../../src/fetchers/lichess.js';
vi.mock('axios');
const mockedAxios = vi.mocked(axios);
const BASE_GAME = {
    id: 'abc123',
    status: 'mate',
    players: {
        white: { user: { name: 'alice' } },
        black: { user: { name: 'bob' } },
    },
};
beforeEach(() => vi.clearAllMocks());
describe('fetchLichessResult', () => {
    it('returns Player1Wins when white wins', async () => {
        mockedAxios.get = vi.fn().mockResolvedValue({
            status: 200,
            data: { ...BASE_GAME, winner: 'white' },
        });
        const result = await fetchLichessResult('abc123');
        expect(result.result).toBe('Player1Wins');
        expect(result.whitePlayer).toBe('alice');
        expect(result.blackPlayer).toBe('bob');
    });
    it('returns Player2Wins when black wins', async () => {
        mockedAxios.get = vi.fn().mockResolvedValue({
            status: 200,
            data: { ...BASE_GAME, winner: 'black' },
        });
        const result = await fetchLichessResult('abc123');
        expect(result.result).toBe('Player2Wins');
    });
    it('returns Draw when no winner on terminal status', async () => {
        mockedAxios.get = vi.fn().mockResolvedValue({
            status: 200,
            data: { ...BASE_GAME, status: 'draw' },
        });
        const result = await fetchLichessResult('abc123');
        expect(result.result).toBe('Draw');
    });
    it('returns null result for in-progress game', async () => {
        mockedAxios.get = vi.fn().mockResolvedValue({
            status: 200,
            data: { ...BASE_GAME, status: 'started', winner: undefined },
        });
        const result = await fetchLichessResult('abc123');
        expect(result.result).toBeNull();
    });
    it('throws GameNotFoundError on 404', async () => {
        mockedAxios.get = vi.fn().mockResolvedValue({ status: 404, data: {} });
        await expect(fetchLichessResult('missing')).rejects.toThrow(GameNotFoundError);
    });
    it('throws on unexpected HTTP error status', async () => {
        mockedAxios.get = vi.fn().mockResolvedValue({ status: 429, data: {} });
        await expect(fetchLichessResult('abc123')).rejects.toThrow('Lichess API error: 429');
    });
});
