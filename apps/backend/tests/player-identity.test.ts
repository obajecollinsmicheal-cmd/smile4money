import { describe, it, expect } from 'vitest';
import {
  verifyPlayerIdentities,
  computeIdentityHash,
  verifyIdentityHash,
} from '../src/services/player-identity.js';
import type { MatchRecord } from '../src/store/match-store.js';
import type { GameResult } from '../src/fetchers/lichess.js';

describe('Player Identity Verification', () => {
  const mockMatch: MatchRecord = {
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
      const gameResult: GameResult = {
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
      const gameResult: GameResult = {
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
      const gameResult: GameResult = {
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
      const gameResult: GameResult = {
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
      const gameResult: GameResult = {
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
      const gameResult: GameResult = {
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
      const gameResult: GameResult = {
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
      const gameResult: GameResult = {
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

    it('returns invalid when the registered player1 username is empty', () => {
      // The API reports a real player, but the on-chain record registered an
      // empty username for player1. An empty registered name must not match.
      const gameResult: GameResult = {
        gameId: 'abc123',
        status: 'mate',
        whitePlayer: 'alice',
        blackPlayer: 'bob',
        result: 'Player1Wins',
      };

      const identityMap = {
        player1Address: 'GPLAYER1AAAA',
        player1Username: '',
        player2Address: 'GPLAYER2BBBB',
        player2Username: 'bob',
        platform: 'lichess',
      };

      const result = verifyPlayerIdentities(mockMatch, gameResult, identityMap);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty username');
    });

    it('returns invalid when the registered player2 username is empty', () => {
      const gameResult: GameResult = {
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
        player2Username: '',
        platform: 'lichess',
      };

      const result = verifyPlayerIdentities(mockMatch, gameResult, identityMap);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty username');
    });

    it('returns invalid when both API and registered usernames are empty (no false positive)', () => {
      // Edge case from the issue: empty API names matching empty registered
      // names must NOT be treated as a valid identity match.
      const gameResult: GameResult = {
        gameId: 'abc123',
        status: 'mate',
        whitePlayer: '',
        blackPlayer: '',
        result: null,
      };

      const identityMap = {
        player1Address: 'GPLAYER1AAAA',
        player1Username: '',
        player2Address: 'GPLAYER2BBBB',
        player2Username: '',
        platform: 'lichess',
      };

      const result = verifyPlayerIdentities(mockMatch, gameResult, identityMap);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty username');
    });

    it('returns invalid when only one of the API usernames is empty', () => {
      const gameResult: GameResult = {
        gameId: 'abc123',
        status: 'mate',
        whitePlayer: 'alice',
        blackPlayer: '',
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
    });
  });

  // #1720 — identity hash binding
  describe('computeIdentityHash', () => {
    it('is deterministic for the same inputs', () => {
      const h1 = computeIdentityHash('alice', 'GPLAYER1AAAA', 'bob', 'GPLAYER2BBBB');
      const h2 = computeIdentityHash('alice', 'GPLAYER1AAAA', 'bob', 'GPLAYER2BBBB');
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex digest
    });

    it('is insensitive to username casing/whitespace and address casing', () => {
      const h1 = computeIdentityHash('alice', 'gplayer1aaaa', 'bob', 'gplayer2bbbb');
      const h2 = computeIdentityHash('  Alice ', 'GPLAYER1AAAA', ' BOB ', 'GPLAYER2BBBB');
      expect(h1).toBe(h2);
    });

    it('differs when any one of the four inputs differs', () => {
      const base = computeIdentityHash('alice', 'GPLAYER1AAAA', 'bob', 'GPLAYER2BBBB');
      expect(computeIdentityHash('charlie', 'GPLAYER1AAAA', 'bob', 'GPLAYER2BBBB')).not.toBe(base);
      expect(computeIdentityHash('alice', 'GPLAYER3CCCC', 'bob', 'GPLAYER2BBBB')).not.toBe(base);
      expect(computeIdentityHash('alice', 'GPLAYER1AAAA', 'dave', 'GPLAYER2BBBB')).not.toBe(base);
      expect(computeIdentityHash('alice', 'GPLAYER1AAAA', 'bob', 'GPLAYER4DDDD')).not.toBe(base);
    });

    it('differs when the two players are swapped', () => {
      // Binding order matters: (alice, P1, bob, P2) must not collide with
      // (bob, P1, alice, P2) — otherwise swapping which player occupies
      // which slot would go undetected.
      const original = computeIdentityHash('alice', 'GPLAYER1AAAA', 'bob', 'GPLAYER2BBBB');
      const swapped = computeIdentityHash('bob', 'GPLAYER1AAAA', 'alice', 'GPLAYER2BBBB');
      expect(swapped).not.toBe(original);
    });
  });

  describe('verifyIdentityHash', () => {
    it('is valid for a match whose stored hash matches its current fields', () => {
      const match: MatchRecord = {
        ...mockMatch,
        identityHash: computeIdentityHash('alice', 'GPLAYER1AAAA', 'bob', 'GPLAYER2BBBB'),
      };
      expect(verifyIdentityHash(match).valid).toBe(true);
    });

    it('is valid (backward-compatible) for a match with no stored hash at all', () => {
      const match: MatchRecord = { ...mockMatch, identityHash: undefined };
      expect(verifyIdentityHash(match).valid).toBe(true);
    });

    // The acceptance-criteria case: a mismatched identity hash must be rejected.
    it('rejects a match whose stored hash does not match its current identity fields', () => {
      const match: MatchRecord = {
        ...mockMatch,
        // Hash was bound to a *different* player2Username ("charlie") than
        // what the record now shows ("bob") — simulates the identity having
        // been swapped/altered after the hash was originally computed.
        identityHash: computeIdentityHash('alice', 'GPLAYER1AAAA', 'charlie', 'GPLAYER2BBBB'),
      };

      const result = verifyIdentityHash(match);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Identity hash mismatch');
    });

    it('rejects a match whose player address was altered after the hash was bound', () => {
      const match: MatchRecord = {
        ...mockMatch,
        player1: 'GSWAPPEDADDRESSXXXX',
        identityHash: computeIdentityHash('alice', 'GPLAYER1AAAA', 'bob', 'GPLAYER2BBBB'),
      };

      expect(verifyIdentityHash(match).valid).toBe(false);
    });

    it('rejects a match with a stored hash but missing usernames to recompute it', () => {
      const match: MatchRecord = {
        ...mockMatch,
        player1Username: undefined,
        identityHash: 'some-hash-value',
      };

      const result = verifyIdentityHash(match);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('missing the usernames');
    });
  });
});
