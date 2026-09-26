/**
 * Player Identity Verification Service
 *
 * This service verifies that the players reported by the chess platform APIs
 * (Lichess or Chess.com) correspond to the Stellar addresses registered in
 * the on-chain match record.
 *
 * Security Model:
 * ───────────────
 * When a match is created, the off-chain oracle records the mapping between:
 *   - Stellar addresses (player1, player2)
 *   - Chess platform usernames (e.g., alice, bob on Lichess)
 *
 * When the oracle later fetches and submits a game result, it verifies:
 *   1. The game exists on the platform
 *   2. The two players in the game match the registered mapping
 *   3. The result is submitted to the correct match_id
 *
 * This prevents a malicious actor from "swapping" results between matches or
 * injecting game results where the oracle never verified player identities.
 *
 * Example Attack Scenario (Without Verification):
 * ───────────────────────────────────────────────
 * 1. Admin creates match: (player1=Alice, player2=Bob) for game ABC123
 * 2. Malicious oracle submits result of DIFFERENT game XYZ789 where:
 *    - White: Charlie, Black: David
 *    - Result: Charlie wins
 * 3. Escrow contract pays Alice (player1) because the result says "Player1Wins"
 * 4. But Charlie and David played game XYZ789, not Alice and Bob!
 *
 * Defense:
 * ─────────
 * Before accepting the result, the oracle verifies:
 *   - Game ABC123 players: white=alice, black=bob ✓ matches player1/player2
 *   - Result: alice wins → payout to Alice (player1) ✓ correct
 *
 * Injected game XYZ789 would be rejected because charlie/david don't match
 * the registered players.
 */
/**
 * Verify that the players in an API game result match the on-chain match record.
 *
 * # Arguments
 *
 * - `match` - The on-chain match record with registered player addresses
 * - `result` - The game result from the chess platform API
 *
 * # Returns
 *
 * - `{ valid: true }` if players match
 * - `{ valid: false, error: "..." }` if verification fails
 *
 * # Verification Logic
 *
 * The function checks if the reported players (by username) correspond to the
 * registered Stellar addresses:
 *
 * 1. **Exact Match**: Both usernames match in order
 *    - API: white=alice, black=bob
 *    - Registered: player1=alice, player2=bob
 *    - Result: ✓ Valid
 *
 * 2. **Swapped Players**: Usernames match but in reverse order
 *    - API: white=bob, black=alice
 *    - Registered: player1=alice, player2=bob
 *    - Result: ✓ Valid (but result will be flipped: player2 wins instead of player1)
 *
 * 3. **Missing Player**: Username not found or doesn't match
 *    - API: white=alice, black=charlie
 *    - Registered: player1=alice, player2=bob
 *    - Result: ✗ Invalid (charlie ≠ bob)
 *
 * 4. **Injected Game**: Completely different players
 *    - API: white=charlie, black=david
 *    - Registered: player1=alice, player2=bob
 *    - Result: ✗ Invalid (charlie ≠ alice, david ≠ bob)
 *
 * # Case Sensitivity
 *
 * Usernames are compared case-insensitively after trimming whitespace,
 * as chess platform usernames are typically case-insensitive.
 */
export function verifyPlayerIdentities(match, result, identityMap) {
    // Normalize usernames for comparison (case-insensitive, trim whitespace)
    const normalize = (name) => (name || '').trim().toLowerCase();
    const whiteNorm = normalize(result.whitePlayer);
    const blackNorm = normalize(result.blackPlayer);
    const player1Norm = normalize(identityMap.player1Username);
    const player2Norm = normalize(identityMap.player2Username);
    // Check for exact match: white=player1, black=player2
    if (whiteNorm === player1Norm && blackNorm === player2Norm) {
        return { valid: true };
    }
    // Check for swapped match: white=player2, black=player1
    // This is valid because the players can play on either color.
    // The result will be interpreted differently (player2 wins → player1 wins),
    // but the game involves the correct players.
    if (whiteNorm === player2Norm && blackNorm === player1Norm) {
        return { valid: true };
    }
    // If neither exact nor swapped matches, the players don't correspond
    return {
        valid: false,
        error: `Player identity mismatch. Expected (${player1Norm}, ${player2Norm}) or (${player2Norm}, ${player1Norm}), but got (${whiteNorm}, ${blackNorm})`,
    };
}
/**
 * Extract player usernames from a game result and create a mapping.
 * Used to store identity information when a match is created.
 *
 * # Arguments
 *
 * - `player1Address` - Stellar address of player1
 * - `player2Address` - Stellar address of player2
 * - `result` - The game result from the API (contains username information)
 * - `platform` - The chess platform
 * - `assumedPlayer1IsWhite` - Whether player1 is assumed to be white (true)
 *   or black (false)
 *
 * # Returns
 *
 * A PlayerIdentityMap that can be stored and later used for verification.
 */
export function createIdentityMap(player1Address, player2Address, result, platform, assumedPlayer1IsWhite = true) {
    if (assumedPlayer1IsWhite) {
        return {
            player1Address,
            player1Username: result.whitePlayer,
            player2Address,
            player2Username: result.blackPlayer,
            platform,
        };
    }
    else {
        return {
            player1Address,
            player1Username: result.blackPlayer,
            player2Address,
            player2Username: result.whitePlayer,
            platform,
        };
    }
}
/**
 * Determine which player is white and which is black based on the API result.
 * Returns the corrected identity map if the players were swapped.
 *
 * # Arguments
 *
 * - `match` - The on-chain match record
 * - `result` - The game result from the API
 * - `identityMap` - The original identity map
 *
 * # Returns
 *
 * A corrected identity map if players were swapped, otherwise the original.
 */
export function normalizePlayerOrder(match, result, identityMap) {
    const normalize = (name) => (name || '').trim().toLowerCase();
    const whiteNorm = normalize(result.whitePlayer);
    const blackNorm = normalize(result.blackPlayer);
    const player1Norm = normalize(identityMap.player1Username);
    const player2Norm = normalize(identityMap.player2Username);
    // If players are swapped in the API result, swap the identity map
    if (whiteNorm === player2Norm && blackNorm === player1Norm) {
        return {
            player1Address: identityMap.player2Address,
            player1Username: identityMap.player2Username,
            player2Address: identityMap.player1Address,
            player2Username: identityMap.player1Username,
            platform: identityMap.platform,
        };
    }
    // Otherwise return the original map
    return identityMap;
}
