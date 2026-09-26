# Queue Deduplication Test Coverage Report

## Executive Summary

The smile4money contracts implement robust deduplication for match result submissions via **two complementary mechanisms**:

1. **Oracle Contract**: Explicit `AlreadySubmitted` error tracking (`DataKey::Result(match_id)` persistent index)
2. **Escrow Contract**: Implicit state machine enforcement (only `Active` → `PendingResult` transition allows submission)

Both approaches safely prevent duplicate submissions when the same `match_id` is enqueued twice by the off-chain oracle service queue.

---

## Threat Scenario

**Off-Chain Queue Bug**: The oracle service's async queue might enqueue the same `match_id` twice due to:
- Duplicate event processing (retried webhooks, message broker quirks)
- Race conditions in the enqueue logic
- Network-induced retries with idempotency failures

If not handled, this could trigger:
- **Oracle contract**: Double registration of results (masked by explicit deduplication)
- **Escrow contract**: Double payout to the winner (mitigated by state machine)

---

## Test Coverage

### Oracle Contract Deduplication (Explicit)

**Test**: `test/oracle/submit_result_duplicate_returns_already_submitted()`

```rust
#[test]
fn submit_result_duplicate_returns_already_submitted() {
    let (env, contract_id) = setup();
    let client = OracleContractClient::new(&env, &contract_id);

    // First submission succeeds
    client.submit_result(&0u64, &String::from_str(&env, "abc123"), &MatchResult::Draw);

    // Second submission for same match_id is rejected
    assert!(matches!(
        client.try_submit_result(&0u64, &String::from_str(&env, "abc123"), &MatchResult::Draw),
        Err(Ok(Error::AlreadySubmitted))
    ));
}
```

**How it works**:
- Oracle contract stores each result in `env.storage().persistent()` under `DataKey::Result(match_id)`
- On the second submission, the contract checks `env.storage().persistent().has(&DataKey::Result(match_id))`
- Returns `Error::AlreadySubmitted` if a result already exists

**Strength**: Deterministic, explicit, easy to audit

---

### Escrow Contract Deduplication (Implicit State Machine)

**Test**: `test/escrow/test_submit_result_queue_deduplication_prevents_duplicate_match_id()` (newly added)

```rust
#[test]
fn test_submit_result_queue_deduplication_prevents_duplicate_match_id() {
    // 1. Create match and both players deposit → state = Active
    let match_id = client.create_match(...);
    client.deposit(&match_id, &player1);
    client.deposit(&match_id, &player2);
    assert_eq!(client.get_match(&match_id).state, MatchState::Active);

    // 2. First submit_result succeeds → state transitions to PendingResult
    client.submit_result(&match_id, &game_id, &Winner::Player1, &oracle);
    assert_eq!(client.get_match(&match_id).state, MatchState::PendingResult);

    // 3. Second submit_result is rejected with InvalidState
    let result = client.try_submit_result(&match_id, &game_id, &Winner::Player2, &oracle);
    assert_eq!(result, Err(Ok(Error::InvalidState)));

    // 4. Verify balances remain unchanged (no double payout)
    assert_eq!(token_client.balance(&player1), p1_after_first);
    assert_eq!(token_client.balance(&player2), p2_after_first);
}
```

**How it works**:
- Escrow contract enforces a strict state machine: `Pending` → `Active` → `PendingResult` → `Completed`
- The `submit_result()` function only accepts matches in the `Active` state
- Check: `if m.state != MatchState::Active { return Err(Error::InvalidState); }`
- Once a result is submitted, the state transitions to `PendingResult`
- A second submission on the same match will fail because the state is no longer `Active`

**Strength**: Implicit in the business logic; prevents all invalid state transitions, not just duplicates

---

## Comparison: Explicit vs. Implicit Deduplication

| Aspect | Oracle (Explicit) | Escrow (Implicit) |
|--------|-------------------|-------------------|
| **Mechanism** | Dedicated index (`DataKey::Result`) | State machine enforcement |
| **Error Type** | `AlreadySubmitted` | `InvalidState` |
| **Storage Overhead** | Additional persistent index | None (state already tracked) |
| **Clarity** | Very clear intent in error | Intent requires state machine knowledge |
| **Scope** | Only prevents same result twice | Prevents all invalid state transitions |
| **Testability** | Simple: call twice, expect `AlreadySubmitted` | Simple: check state after each transition |

---

## Risk Assessment

### Queue-Based Double Submission

**Severity**: LOW (fully mitigated)

**Scenario**: Off-chain service enqueues match_id twice

| Step | Oracle Contract | Escrow Contract |
|------|-----------------|-----------------|
| 1. First item processed | Result stored in `DataKey::Result` | State: `Pending` → `Active` → `PendingResult` |
| 2. Second item processed | Returns `AlreadySubmitted` ✓ | Returns `InvalidState` ✓ |
| **Outcome** | No double-record | No double-payout |

Both contracts safely reject the duplicate with appropriate errors.

---

## Test Matrix

### Escrow Contract Submit_Result Tests

| Test Name | Scenario | Assertion |
|-----------|----------|-----------|
| `test_submit_result_on_pending_match_fails` | Submit on `Pending` state | `InvalidState` |
| `test_submit_result_on_completed_match_fails` | Submit on `Completed` state (duplicate) | `InvalidState` |
| `test_submit_result_queue_deduplication_prevents_duplicate_match_id` | Duplicate enqueue (NEW) | `InvalidState` + balance invariant |
| `test_non_oracle_cannot_submit_result` | Non-oracle caller | `Unauthorized` |
| `test_submit_result_wrong_game_id_fails` | Mismatched game_id | `GameIdMismatch` |
| `test_submit_result_on_cancelled_match_fails` | Submit on `Cancelled` state | `InvalidState` |

### Oracle Contract Submit_Result Tests

| Test Name | Scenario | Assertion |
|-----------|----------|-----------|
| `test_duplicate_submit_fails` | Same match_id twice | Panic (should_panic) |
| `submit_result_duplicate_returns_already_submitted` | Same match_id twice | `AlreadySubmitted` |
| `test_submit_result_by_non_admin_returns_unauthorized` | Non-admin caller | `Unauthorized` |
| `test_submit_result_empty_game_id_fails` | Empty game_id | `InvalidGameId` |

---

## Recommendations

### 1. ✅ Documentation (DONE)

The new test `test_submit_result_queue_deduplication_prevents_duplicate_match_id` explicitly documents the deduplication behavior in the escrow contract via comments:

```rust
/// Queue deduplication test: Simulate the scenario where an off-chain oracle
/// service buggy queue might enqueue the same match_id twice, then process both
/// items. This test verifies that the second submission is rejected with
/// `InvalidState`, preventing double-payout.
```

### 2. ✅ Test Coverage (DONE)

- Escrow contract now has explicit test for queue-based duplicate submissions
- Oracle contract already has comprehensive duplicate tests
- Both contracts protected via complementary mechanisms

### 3. Monitoring (Consider)

Off-chain oracle service should:
- Log and alert on `InvalidState` / `AlreadySubmitted` responses
- Implement idempotency tokens in queue to prevent duplicate enqueues
- Exponential backoff + dedupe window for retried submissions

### 4. Error Handling (Best Practice)

```rust
// Oracle service pseudocode
if result_error == AlreadySubmitted || result_error == InvalidState {
    log_warn!("Duplicate submission detected for match_id={}: {}", match_id, result_error);
    // Count metrics, alert, but do NOT retry
    return Ok(()); // Already recorded
}
```

---

## Conclusion

The smile4money contracts are **robustly protected against queue-based duplicate submissions**:

- **Oracle contract**: Explicit index-based deduplication → `AlreadySubmitted`
- **Escrow contract**: Implicit state machine deduplication → `InvalidState`
- **Test coverage**: Both mechanisms now have comprehensive tests
- **Defense in depth**: Even if the off-chain service has a queue bug, on-chain contracts ensure safety

**Risk Level**: ✅ **MITIGATED** — No additional changes required.
