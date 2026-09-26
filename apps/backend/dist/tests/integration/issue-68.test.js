/**
 * Issue #68 — Backend Integration Tests: Match Creation API
 *
 * Covers:
 *  - Authentication: requests without a valid JWT return 401
 *  - Schema validation: missing/wrong-type fields return 400
 *  - Successful creation: valid payload returns 201 and persists to DB
 *  - Edge cases: duplicate game_id, oversized strings, special characters
 *  - DB cleanup: beforeEach wipes the matches collection
 *  - External service mocks: Lichess / Chess.com API calls are intercepted
 *
 * Stack: Node.js · TypeScript · Vitest · supertest · mongodb-memory-server
 *
 * NOTE: Adjust the imports below to match your actual file paths:
 *   - '../../src/app'        → your Express app entry point
 *   - '../../src/models/Match' → your Mongoose Match model
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
// ── Adjust these imports to your actual paths ────────────────────────────────
import app from '../../src/app.ts';
import { Match } from '../../src/models/Match.ts';
// ─────────────────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------
// Mock external services so tests run fully offline
// ---------------------------------------------------------------------------
vi.mock('../../src/services/lichess', () => ({
    verifyGame: vi.fn().mockResolvedValue({ valid: true, platform: 'lichess' }),
}));
vi.mock('../../src/services/chessdotcom', () => ({
    verifyGame: vi.fn().mockResolvedValue({ valid: true, platform: 'chessdotcom' }),
}));
vi.mock('../../src/services/email', () => ({
    sendMatchNotification: vi.fn().mockResolvedValue(undefined),
}));
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Generates a signed JWT for a test player address. */
function makeToken(address = 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') {
    // Replace with your actual JWT signing helper if available.
    // This stub returns a Bearer token your auth middleware should accept.
    const jwt = require('jsonwebtoken');
    return jwt.sign({ address }, process.env.JWT_SECRET ?? 'test-secret', { expiresIn: '1h' });
}
const VALID_PAYLOAD = {
    player2: 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    stakeAmount: 100,
    token: 'XLM',
    gameId: 'lichess-game-abc123',
    platform: 'lichess',
};
// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------
let mongod;
beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});
beforeEach(async () => {
    // Wipe all collections before each test to prevent state bleed
    await Match.deleteMany({});
});
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/matches — create match', () => {
    // ── 1. Authentication ────────────────────────────────────────────────────
    describe('authentication', () => {
        it('returns 401 when no Authorization header is provided', async () => {
            // Arrange — no token
            // Act
            const res = await request(app)
                .post('/api/matches')
                .send(VALID_PAYLOAD);
            // Assert
            expect(res.status).toBe(401);
            expect(res.body).toMatchObject({ error: expect.stringMatching(/unauthorized|token/i) });
        });
        it('returns 401 when the JWT is malformed', async () => {
            // Arrange
            const badToken = 'Bearer this.is.not.valid';
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', badToken)
                .send(VALID_PAYLOAD);
            // Assert
            expect(res.status).toBe(401);
        });
        it('returns 401 when the JWT is expired', async () => {
            // Arrange
            const jwt = require('jsonwebtoken');
            const expiredToken = jwt.sign({ address: 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, process.env.JWT_SECRET ?? 'test-secret', { expiresIn: -1 } // already expired
            );
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${expiredToken}`)
                .send(VALID_PAYLOAD);
            // Assert
            expect(res.status).toBe(401);
        });
    });
    // ── 2. Schema validation ─────────────────────────────────────────────────
    describe('schema validation', () => {
        it('returns 400 when player2 address is missing', async () => {
            // Arrange
            const { player2, ...payload } = VALID_PAYLOAD;
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${makeToken()}`)
                .send(payload);
            // Assert
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ error: expect.stringMatching(/player2/i) });
        });
        it('returns 400 when stakeAmount is missing', async () => {
            // Arrange
            const { stakeAmount, ...payload } = VALID_PAYLOAD;
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${makeToken()}`)
                .send(payload);
            // Assert
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ error: expect.stringMatching(/stakeAmount/i) });
        });
        it('returns 400 when stakeAmount is a string instead of a number', async () => {
            // Arrange
            const payload = { ...VALID_PAYLOAD, stakeAmount: 'one-hundred' };
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${makeToken()}`)
                .send(payload);
            // Assert
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ error: expect.stringMatching(/stakeAmount|number/i) });
        });
        it('returns 400 when stakeAmount is zero', async () => {
            // Arrange — mirrors Issue #3 (zero stake guard)
            const payload = { ...VALID_PAYLOAD, stakeAmount: 0 };
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${makeToken()}`)
                .send(payload);
            // Assert
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ error: expect.stringMatching(/stakeAmount|invalid/i) });
        });
        it('returns 400 when stakeAmount is negative', async () => {
            // Arrange
            const payload = { ...VALID_PAYLOAD, stakeAmount: -50 };
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${makeToken()}`)
                .send(payload);
            // Assert
            expect(res.status).toBe(400);
        });
        it('returns 400 when gameId is missing', async () => {
            // Arrange
            const { gameId, ...payload } = VALID_PAYLOAD;
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${makeToken()}`)
                .send(payload);
            // Assert
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ error: expect.stringMatching(/gameId/i) });
        });
        it('returns 400 when platform is not one of the allowed values', async () => {
            // Arrange
            const payload = { ...VALID_PAYLOAD, platform: 'unknown-platform' };
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${makeToken()}`)
                .send(payload);
            // Assert
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ error: expect.stringMatching(/platform/i) });
        });
        it('returns 400 when player1 and player2 are the same address (self-match)', async () => {
            // Arrange — mirrors Issue #19
            const sameAddress = 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
            const payload = { ...VALID_PAYLOAD, player2: sameAddress };
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${makeToken(sameAddress)}`)
                .send(payload);
            // Assert
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ error: expect.stringMatching(/self|same|player/i) });
        });
    });
    // ── 3. Successful creation ───────────────────────────────────────────────
    describe('successful creation', () => {
        it('returns 201 and the created match when the payload is valid', async () => {
            // Arrange
            const token = makeToken();
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${token}`)
                .send(VALID_PAYLOAD);
            // Assert — HTTP response
            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({
                matchId: expect.any(Number),
                stakeAmount: VALID_PAYLOAD.stakeAmount,
                gameId: VALID_PAYLOAD.gameId,
                platform: VALID_PAYLOAD.platform,
                state: 'Pending',
            });
        });
        it('persists the match to the database after creation', async () => {
            // Arrange
            const token = makeToken();
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${token}`)
                .send(VALID_PAYLOAD);
            // Assert — DB record exists
            const saved = await Match.findOne({ gameId: VALID_PAYLOAD.gameId });
            expect(saved).not.toBeNull();
            expect(saved?.stakeAmount).toBe(VALID_PAYLOAD.stakeAmount);
            expect(saved?.state).toBe('Pending');
        });
        it('returns the correct Content-Type header', async () => {
            // Arrange
            const token = makeToken();
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${token}`)
                .send(VALID_PAYLOAD);
            // Assert
            expect(res.headers['content-type']).toMatch(/application\/json/);
        });
    });
    // ── 4. Edge cases ────────────────────────────────────────────────────────
    describe('edge cases', () => {
        it('returns 409 when the same gameId is used to create a second match', async () => {
            // Arrange — mirrors Issue #20 (duplicate game_id)
            const token = makeToken();
            await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${token}`)
                .send(VALID_PAYLOAD);
            // Act — same gameId again
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${token}`)
                .send(VALID_PAYLOAD);
            // Assert
            expect(res.status).toBe(409);
            expect(res.body).toMatchObject({ error: expect.stringMatching(/duplicate|already exists/i) });
        });
        it('returns 400 when gameId exceeds the maximum allowed length', async () => {
            // Arrange — 512-character gameId
            const payload = { ...VALID_PAYLOAD, gameId: 'x'.repeat(512) };
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${makeToken()}`)
                .send(payload);
            // Assert
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ error: expect.stringMatching(/gameId|length|too long/i) });
        });
        it('handles special characters in gameId without crashing', async () => {
            // Arrange — SQL/NoSQL injection-style input
            const payload = { ...VALID_PAYLOAD, gameId: `'; DROP TABLE matches; --` };
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${makeToken()}`)
                .send(payload);
            // Assert — either 400 (rejected) or 201 (sanitised and stored) — never 500
            expect([400, 201]).toContain(res.status);
            expect(res.status).not.toBe(500);
        });
        it('returns 400 for an extremely large stakeAmount (overflow guard)', async () => {
            // Arrange — mirrors Issue #9 (overflow)
            const payload = { ...VALID_PAYLOAD, stakeAmount: Number.MAX_SAFE_INTEGER + 1 };
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${makeToken()}`)
                .send(payload);
            // Assert
            expect(res.status).toBe(400);
        });
        it('returns 400 when the request body is empty', async () => {
            // Arrange — no body at all
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${makeToken()}`)
                .send({});
            // Assert
            expect(res.status).toBe(400);
        });
        it('returns 400 when Content-Type is not application/json', async () => {
            // Arrange
            // Act
            const res = await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${makeToken()}`)
                .set('Content-Type', 'text/plain')
                .send('stakeAmount=100');
            // Assert
            expect(res.status).toBe(400);
        });
    });
    // ── 5. Database isolation ────────────────────────────────────────────────
    describe('database isolation', () => {
        it('does not see matches created in a previous test (beforeEach cleanup works)', async () => {
            // Arrange — DB should be empty at the start of every test
            const count = await Match.countDocuments();
            // Assert
            expect(count).toBe(0);
        });
        it('only one match exists after a single successful creation', async () => {
            // Arrange
            const token = makeToken();
            // Act
            await request(app)
                .post('/api/matches')
                .set('Authorization', `Bearer ${token}`)
                .send(VALID_PAYLOAD);
            // Assert
            const count = await Match.countDocuments();
            expect(count).toBe(1);
        });
    });
});
