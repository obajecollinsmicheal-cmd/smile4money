# Issue #3: Reject Zero or Negative Stake Amounts in `create_match`

**Labels:** `bug`  
**Priority:** Medium  
**Estimated Time:** 30 minutes

## Problem

`EscrowContract::create_match` accepted any `stake_amount` value, including zero and negative numbers. A match created with `stake_amount = 0` wastes ledger storage, produces meaningless escrow entries, and allows the oracle to execute a "payout" of zero tokens — a no-op that still transitions the match to `Completed` and permanently occupies a match ID.

## Root Cause

The function performed no validation on `stake_amount` before writing the match record to persistent storage:

```rust
// Before fix — no amount guard
pub fn create_match(
    env: Env,
    player1: Address,
    player2: Address,
    stake_amount: i128,
    token: Address,
    game_id: String,
    platform: Platform,
) -> Result<u64, Error> {
    // stake_amount written directly with no check
    let m = Match {
        stake_amount,
        // ...
    };
    env.storage().persistent().set(&DataKey::Match(id), &m);
    Ok(id)
}
```

## Fix

Add an explicit guard at the top of `create_match` that rejects non-positive stake amounts:

```rust
pub fn create_match(/* ... */) -> Result<u64, Error> {
    player1.require_auth();

    if Self::is_paused(&env) {
        return Err(Error::ContractPaused);
    }
    if stake_amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    // ... rest of validation and match creation
}
```

`InvalidAmount` is defined in `errors.rs`:

```rust
/// [E010] `stake_amount` must be a positive integer greater than zero.
InvalidAmount = 10,
```

## Test Cases

```rust
#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn test_create_match_zero_stake_fails() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    client.create_match(
        &player1,
        &player2,
        &0,
        &token,
        &String::from_str(&env, "zero_stake"),
        &Platform::Lichess,
    );
}
```

Negative amounts are also rejected because `i128` allows negative values and `stake_amount <= 0` covers both cases.

## Impact

Without this guard:

- Any caller could create matches with zero stake, consuming match IDs and ledger storage with no economic value.
- The oracle could complete such matches, emitting misleading `("match", "completed")` events with a payout of zero.
- Downstream indexers and frontends would need to filter out zero-stake matches, adding unnecessary complexity.

## Files Changed

- `contracts/escrow/src/lib.rs` — added `if stake_amount <= 0` guard in `create_match`
- `contracts/escrow/src/errors.rs` — added `InvalidAmount = 10` variant
- `contracts/escrow/src/tests.rs` — added `test_create_match_zero_stake_fails`
