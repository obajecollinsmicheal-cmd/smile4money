# Issue #5: Validate `game_id` in `submit_result` to Prevent Cross-Match Result Injection

**Labels:** `bug`, `security`  
**Priority:** High  
**Estimated Time:** 1 hour

## Problem

`EscrowContract::submit_result` accepted a `match_id` and a `winner` but did not verify that the oracle's result corresponded to the correct chess game. A compromised or mistaken oracle could submit a result for the right `match_id` but with the outcome of a completely different game, redirecting the payout to the wrong player.

## Root Cause

The original `submit_result` signature took only `match_id` and `winner`. There was no cross-check between the oracle's claimed game and the `game_id` stored in the match record at creation time:

```rust
// Before fix — no game_id verification
pub fn submit_result(
    env: Env,
    match_id: u64,
    winner: Winner,
    caller: Address,
) -> Result<(), Error> {
    // caller verified against oracle address ✓
    // match state verified ✓
    // BUT: no check that the oracle is submitting for the right game
    let payout_amount = match winner { /* ... */ };
    client.transfer(/* ... */);
    Ok(())
}
```

### Attack Scenario

1. Player A and Player B create Match #7 for chess game `lichess_abc`.
2. Player C and Player D create Match #8 for chess game `lichess_xyz`.
3. Player C wins `lichess_xyz`.
4. A compromised oracle submits `submit_result(match_id=7, winner=Player1, ...)` — using the result of `lichess_xyz` to pay out Match #7 to the wrong player.

Without `game_id` verification, the escrow contract has no way to detect this substitution.

## Fix

Add `game_id: String` as a required parameter to `submit_result` and compare it against the `game_id` stored in the match record:

```rust
pub fn submit_result(
    env: Env,
    match_id: u64,
    game_id: String,      // ← new parameter
    winner: Winner,
    caller: Address,
) -> Result<(), Error> {
    // ... oracle auth check ...

    let m: Match = env.storage().persistent()
        .get(&DataKey::Match(match_id))
        .ok_or(Error::MatchNotFound)?;

    // Verify the oracle is submitting a result for the correct game
    if m.game_id != game_id {
        return Err(Error::GameIdMismatch);
    }

    // ... state checks and payout ...
}
```

`GameIdMismatch` is defined in `errors.rs`:

```rust
/// [E013] The oracle submitted a result whose `game_id` does not match the
/// `game_id` stored in the match. Prevents cross-match result injection.
GameIdMismatch = 13,
```

## Test Cases

```rust
#[test]
fn test_submit_result_wrong_game_id_fails() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1, &player2, &100, &token,
        &String::from_str(&env, "real_game"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);

    assert_eq!(
        client.try_submit_result(
            &id,
            &String::from_str(&env, "wrong_game"), // ← wrong game_id
            &Winner::Player1,
            &oracle,
        ),
        Err(Ok(Error::GameIdMismatch))
    );
}
```

## Security Properties

After this fix:

- The oracle must supply the exact `game_id` that was recorded at match creation time.
- A result submitted for the correct `match_id` but the wrong `game_id` is rejected before any state change or token transfer occurs.
- The check is performed after oracle authentication and before the state transition, so no partial state changes can occur on a mismatched submission.
- The `game_id` is immutable once a match is created — it cannot be changed by any party.

## Files Changed

- `contracts/escrow/src/lib.rs` — added `game_id: String` parameter and mismatch check in `submit_result`
- `contracts/escrow/src/errors.rs` — added `GameIdMismatch = 13` variant
- `contracts/escrow/src/tests.rs` — added `test_submit_result_wrong_game_id_fails`
- `docs/security.md` — added "Cross-Match Result Injection" threat entry
