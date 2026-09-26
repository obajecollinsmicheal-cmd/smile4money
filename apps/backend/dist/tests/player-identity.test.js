import { describe, it, expect } from 'vitest';
import { verifyPlayerIdentities, createIdentityMap, normalizePlayerOrder, } from '../src/services/player-identity.js';
describe('Player Identity Verification', () => {
    const mockMatch = {
        matchId: 1,
        player1: 'GPLAYER1AAAA',
        player2: 'GPLAYER2BBBB',
        player1Username: 'alice',
        player2Username: 'bob',
        stakeAmount: 100,
        token: 'XLM',
        gameId: 'abc123',
        platform: 'lichess',
        state: 'Pending',
    };
    describe('verifyPlayerIdentities', () => {
        it('returns valid when players match exactly', () => {
            const gameResult = {
                gameId: 'abc123',
                status: 'mate',
                whitePlayer: 'alice',
                blackPlayer: 'bob',
                result: 'Player1Wins',
            };
            const identityMap = {
                player1Address: 'GPLAYER1AAAA',
                player1Username: 'alice',
                player2Address: 'GPLAYER2BBBB',
                player2Username: 'bob',
                platform: 'lichess',
            };
            const result = verifyPlayerIdentities(mockMatch, gameResult, identityMap);
            expect(result.valid).toBe(true);
            expect(result.error).toBeUndefined();
        });
        it('returns valid when players are swapped', () => {
            const gameResult = {
                gameId: 'abc123',
                status: 'mate',
                whitePlayer: 'bob',
                blackPlayer: 'alice',
                result: 'Player2Wins',
            };
            const identityMap = {
                player1Address: 'GPLAYER1AAAA',
                player1Username: 'alice',
                player2Address: 'GPLAYER2BBBB',
                player2Username: 'bob',
                platform: 'lichess',
            };
            const result = verifyPlayerIdentities(mockMatch, gameResult, identityMap);
            expect(result.valid).toBe(true);
            expect(result.error).toBeUndefined();
        });
        it('returns invalid when white player does not match', () => {
            const gameResult = {
                gameId: 'abc123',
                status: 'mate',
                whitePlayer: 'charlie',
                blackPlayer: 'bob',
                result: 'Player1Wins',
            };
            const identityMap = {
                player1Address: 'GPLAYER1AAAA',
                player1Username: 'alice',
                player2Address: 'GPLAYER2BBBB',
                player2Username: 'bob',
                platform: 'lichess',
            };
            const result = verifyPlayerIdentities(mockMatch, gameResult, identityMap);
            expect(result.valid).toBe(false);
            expect(result.error).toContain('Player identity mismatch');
        });
        it('returns invalid when black player does not match', () => {
            const gameResult = {
                gameId: 'abc123',
                status: 'mate',
                whitePlayer: 'alice',
                blackPlayer: 'charlie',
                result: 'Player1Wins',
            };
            const identityMap = {
                player1Address: 'GPLAYER1AAAA',
                player1Username: 'alice',
                player2Address: 'GPLAYER2BBBB',
                player2Username: 'bob',
                platform: 'lichess',
            };
            const result = verifyPlayerIdentities(mockMatch, gameResult, identityMap);
            expect(result.valid).toBe(false);
            expect(result.error).toContain('Player identity mismatch');
        });
        it('returns invalid when both players do not match', () => {
            const gameResult = {
                gameId: 'abc123',
                status: 'mate',
                whitePlayer: 'charlie',
                blackPlayer: 'david',
                result: 'Player1Wins',
            };
            const identityMap = {
                player1Address: 'GPLAYER1AAAA',
                player1Username: 'alice',
                player2Address: 'GPLAYER2BBBB',
                player2Username: 'bob',
                platform: 'lichess',
            };
            const result = verifyPlayerIdentities(mockMatch, gameResult, identityMap);
            expect(result.valid).toBe(false);
            expect(result.error).toContain('Player identity mismatch');
        });
        it('handles case-insensitive comparison', () => {
            const gameResult = {
                gameId: 'abc123',
                status: 'mate',
                whitePlayer: 'ALICE',
                blackPlayer: 'BOB',
                result: 'Player1Wins',
            };
            const identityMap = {
                player1Address: 'GPLAYER1AAAA',
                player1Username: 'alice',
                player2Address: 'GPLAYER2BBBB',
                player2Username: 'bob',
                platform: 'lichess',
            };
            const result = verifyPlayerIdentities(mockMatch, gameResult, identityMap);
            expect(result.valid).toBe(true);
        });
        it('handles usernames with whitespace', () => {
            const gameResult = {
                gameId: 'abc123',
                status: 'mate',
                whitePlayer: '  alice  ',
                blackPlayer: '  bob  ',
                result: 'Player1Wins',
            };
            const identityMap = {
                player1Address: 'GPLAYER1AAAA',
                player1Username: 'alice',
                player2Address: 'GPLAYER2BBBB',
                player2Username: 'bob',
                platform: 'lichess',
            };
            const result = verifyPlayerIdentities(mockMatch, gameResult, identityMap);
            expect(result.valid).toBe(true);
        });
        it('handles empty player names', () => {
            const gameResult = {
                gameId: 'abc123',
                status: 'mate',
                whitePlayer: '',
                blackPlayer: '',
                result: null,
            };
            const identityMap = {
                player1Address: 'GPLAYER1AAAA',
                player1Username: 'alice',
                player2Address: 'GPLAYER2BBBB',
                player2Username: 'bob',
                platform: 'lichess',
            };
            const result = verifyPlayerIdentities(mockMatch, gameResult, identityMap);
            expect(result.valid).toBe(false);
        });
    });
    describe('createIdentityMap', () => {
        it('creates identity map with player1 as white', () => {
            const gameResult = {
                gameId: 'abc123',
                status: 'mate',
                whitePlayer: 'alice',
                blackPlayer: 'bob',
                result: 'Player1Wins',
            };
            const identityMap = createIdentityMap('GPLAYER1AAAA', 'GPLAYER2BBBB', gameResult, 'lichess', true);
            expect(identityMap.player1Address).toBe('GPLAYER1AAAA');
            expect(identityMap.player1Username).toBe('alice');
            expect(identityMap.player2Address).toBe('GPLAYER2BBBB');
            expect(identityMap.player2Username).toBe('bob');
            expect(identityMap.platform).toBe('lichess');
        });
        it('creates identity map with player1 as black', () => {
            const gameResult = {
                gameId: 'abc123',
                status: 'mate',
                whitePlayer: 'alice',
                blackPlayer: 'bob',
                result: 'Player1Wins',
            };
            const identityMap = createIdentityMap('GPLAYER1AAAA', 'GPLAYER2BBBB', gameResult, 'lichess', false);
            expect(identityMap.player1Address).toBe('GPLAYER1AAAA');
            expect(identityMap.player1Username).toBe('bob');
            expect(identityMap.player2Address).toBe('GPLAYER2BBBB');
            expect(identityMap.player2Username).toBe('alice');
            expect(identityMap.platform).toBe('lichess');
        });
        it('defaults to player1 as white', () => {
            const gameResult = {
                gameId: 'abc123',
                status: 'mate',
                whitePlayer: 'alice',
                blackPlayer: 'bob',
                result: 'Player1Wins',
            };
            const identityMap = createIdentityMap('GPLAYER1AAAA', 'GPLAYER2BBBB', gameResult, 'lichess');
            expect(identityMap.player1Username).toBe('alice');
            expect(identityMap.player2Username).toBe('bob');
        });
    });
    describe('normalizePlayerOrder', () => {
        it('returns original map when players match exactly', () => {
            const gameResult = {
                gameId: 'abc123',
                status: 'mate',
                whitePlayer: 'alice',
                blackPlayer: 'bob',
                result: 'Player1Wins',
            };
            const identityMap = {
                player1Address: 'GPLAYER1AAAA',
                player1Username: 'alice',
                player2Address: 'GPLAYER2BBBB',
                player2Username: 'bob',
                platform: 'lichess',
            };
            const normalized = normalizePlayerOrder(mockMatch, gameResult, identityMap);
            expect(normalized.player1Username).toBe('alice');
            expect(normalized.player2Username).toBe('bob');
            expect(normalized.player1Address).toBe('GPLAYER1AAAA');
            expect(normalized.player2Address).toBe('GPLAYER2BBBB');
        });
        it('swaps identities when players are reversed in API', () => {
            const gameResult = {
                gameId: 'abc123',
                status: 'mate',
                whitePlayer: 'bob',
                blackPlayer: 'alice',
                result: 'Player2Wins',
            };
            const identityMap = {
                player1Address: 'GPLAYER1AAAA',
                player1Username: 'alice',
                player2Address: 'GPLAYER2BBBB',
                player2Username: 'bob',
                platform: 'lichess',
            };
            const normalized = normalizePlayerOrder(mockMatch, gameResult, identityMap);
            expect(normalized.player1Username).toBe('bob');
            expect(normalized.player2Username).toBe('alice');
            expect(normalized.player1Address).toBe('GPLAYER2BBBB');
            expect(normalized.player2Address).toBe('GPLAYER1AAAA');
        });
        it('handles case-insensitive normalization', () => {
            const gameResult = {
                gameId: 'abc123',
                status: 'mate',
                whitePlayer: 'BOB',
                blackPlayer: 'ALICE',
                result: 'Player2Wins',
            };
            const identityMap = {
                player1Address: 'GPLAYER1AAAA',
                player1Username: 'alice',
                player2Address: 'GPLAYER2BBBB',
                player2Username: 'bob',
                platform: 'lichess',
            };
            const normalized = normalizePlayerOrder(mockMatch, gameResult, identityMap);
            expect(normalized.player1Username).toBe('bob');
            expect(normalized.player2Username).toBe('alice');
        });
    });
    describe('Attack Prevention Scenarios', () => {
        it('prevents result injection from different game', () => {
            // Scenario: Attacker tries to submit result of game XYZ where
            // Charlie (white) beat David (black), but match is for Alice vs Bob
            const gameResult = {
                gameId: 'xyz789', // Different game!
                status: 'mate',
                whitePlayer: 'charlie',
                blackPlayer: 'david',
                result: 'Player1Wins',
            };
            const identityMap = {
                player1Address: 'GPLAYER1AAAA',
                player1Username: 'alice',
                player2Address: 'GPLAYER2BBBB',
                player2Username: 'bob',
                platform: 'lichess',
            };
            const result = verifyPlayerIdentities(mockMatch, gameResult, identityMap);
            expect(result.valid).toBe(false);
            expect(result.error).toContain('Player identity mismatch');
        });
        it('prevents swapping player stakes through identity mismatch', () => {
            // Scenario: Attacker tries to submit result of game where
            // different players won, hoping to redirect the payout
            const gameResult = {
                gameId: 'abc123',
                status: 'mate',
                whitePlayer: 'alice',
                blackPlayer: 'eve', // Wrong opponent
                result: 'Player1Wins',
            };
            const identityMap = {
                player1Address: 'GPLAYER1AAAA',
                player1Username: 'alice',
                player2Address: 'GPLAYER2BBBB',
                player2Username: 'bob',
                platform: 'lichess',
            };
            const result = verifyPlayerIdentities(mockMatch, gameResult, identityMap);
            expect(result.valid).toBe(false);
            expect(result.error).toContain('eve');
        });
        it('allows correct matches regardless of player color assignment', () => {
            // Alice and Bob can play in either color order; as long as it's Alice vs Bob,
            // the result is valid (though interpretation may differ)
            const colorVariations = [
                { white: 'alice', black: 'bob', valid: true },
                { white: 'bob', black: 'alice', valid: true },
                { white: 'ALICE', black: 'BOB', valid: true },
                { white: 'alice', black: 'eve', valid: false },
                { white: 'charlie', black: 'bob', valid: false },
            ];
            const identityMap = {
                player1Address: 'GPLAYER1AAAA',
                player1Username: 'alice',
                player2Address: 'GPLAYER2BBBB',
                player2Username: 'bob',
                platform: 'lichess',
            };
            colorVariations.forEach(({ white, black, valid }) => {
                const gameResult = {
                    gameId: 'abc123',
                    status: 'mate',
                    whitePlayer: white,
                    blackPlayer: black,
                    result: 'Player1Wins',
                };
                const result = verifyPlayerIdentities(mockMatch, gameResult, identityMap);
                expect(result.valid).toBe(valid);
            });
        });
    });
});
