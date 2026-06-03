# Issue #8: Oracle Contract Results Are Not Used by the Escrow Contract

**Labels:** `bug`  
**Priority:** High  
**Estimated Time:** 2 hours

## Problem

The oracle contract stored verified match results on-chain, but the escrow contract's `submit_result` function accepted the result directly from the caller rather than reading it from the oracle contract. This made the oracle contract's stored results redundant — the escrow never consulted them, so the on-chain record served no purpose in the payout flow.

## Root Cause

The two contracts operated independently with no integration:

```
Oracle Contract                    Escrow Contract
───────────────                    ───────────────
submit_result(match_id, result)    submit_result(match_id, winner, caller)
  → stores ResultEntry               → verifies caller == oracle address
  → emits event                      → executes payout directly
  (never read by escrow)
```

The escrow contract verified the *caller's identity* (is this the oracle address?) but never verified the *result content* against what the oracle contract had recorded on-chain.

## Chosen Architecture

After evaluating two options — (a) escrow reads from oracle contract, (b) oracle calls escrow directly — the team chose a **dual-submission model**:

1. The off-chain oracle service calls `oracle_contract.submit_result(match_id, game_id, result)` to record the result on-chain.
2. The off-chain oracle service then calls `escrow_contract.submit_result(match_id, game_id, winner, oracle_address)` to trigger the payout.

The escrow contract verifies:
- The caller is the registered oracle address (`caller == DataKey::Oracle`)
- The `game_id` matches the match record (prevents cross-match injection — see Issue #5)
- The match is in `Active` state

This approach keeps the contracts loosely coupled (the escrow does not need to know the oracle contract's address) while the `game_id` cross-check provides the binding between the two submissions.

## Integration Flow

```
Off-chain Oracle Service
        │
        ├─1─► oracle_contract.submit_result(match_id, game_id, result)
        │         └─ stores ResultEntry on-chain
        │         └─ emits ("oracle", "result") event
        │
        └─2─► escrow_contract.submit_result(match_id, game_id, winner, oracle_addr)
                  └─ verifies caller == stored oracle address
                  └─ verifies game_id matches match record
                  └─ verifies match state == Active
                  └─ executes token payout
                  └─ emits ("match", "completed") event
```

The oracle contract's on-chain record serves as an **immutable audit trail** — any observer can verify that the result submitted to the escrow matches what the oracle recorded, without trusting the off-chain service's logs.

## Integration Test

```rust
// Full oracle → escrow flow
#[test]
fn test_oracle_to_escrow_full_flow() {
    // Setup both contracts
    let escrow_client = /* ... */;
    let oracle_client = /* ... */;

    // Create and fund match
    let match_id = escrow_client.create_match(
        &player1, &player2, &100, &token,
        &String::from_str(&env, "lichess_abc123"),
        &Platform::Lichess,
    );
    escrow_client.deposit(&match_id, &player1);
    escrow_client.deposit(&match_id, &player2);

    // Oracle records result on-chain
    oracle_client.submit_result(
        &match_id,
        &String::from_str(&env, "lichess_abc123"),
        &MatchResult::Player1Wins,
    );

    // Verify oracle stored the result
    assert!(oracle_client.has_result(&match_id));
    assert_eq!(
        oracle_client.get_result(&match_id).result,
        MatchResult::Player1Wins
    );

    // Oracle triggers payout on escrow
    escrow_client.submit_result(
        &match_id,
        &String::from_str(&env, "lichess_abc123"),
        &Winner::Player1,
        &oracle_addr,
    );

    // Verify payout executed
    assert_eq!(token_client.balance(&player1), 1100);
    assert_eq!(token_client.balance(&player2), 900);
    assert_eq!(escrow_client.get_match(&match_id).state, MatchState::Completed);
}
```

## Security Properties

- **Immutable audit trail**: The oracle contract's stored `ResultEntry` cannot be overwritten (`AlreadySubmitted` guard). Any discrepancy between the oracle record and the escrow payout is detectable on-chain.
- **game_id binding**: Both submissions must use the same `game_id`. The escrow verifies this against the match record, preventing a scenario where the oracle records one result but submits a different winner to the escrow.
- **Loose coupling**: The escrow contract does not hold a reference to the oracle contract address. The oracle contract address is only used for caller authentication. This means the oracle contract can be upgraded or replaced without redeploying the escrow.

## Files Changed

- `contracts/escrow/src/lib.rs` — `submit_result` now requires `game_id` parameter and verifies it against the match record
- `contracts/oracle/src/lib.rs` — `submit_result` stores `ResultEntry` with `game_id` and emits event with timestamp
- `docs/oracle.md` — updated result submission flow diagram
- `docs/architecture.md` — updated integration diagram
