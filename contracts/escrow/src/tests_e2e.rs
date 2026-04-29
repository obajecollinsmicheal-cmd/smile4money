//! End-to-end integration tests for the full match lifecycle.
//!
//! Closes #43 -- Issue #216: Add comprehensive integration test covering the
//! complete match lifecycle: create -> both deposits -> oracle submits result ->
//! verify payouts, for all three outcomes (Player1 wins, Player2 wins, Draw).
//!
//! These tests exercise the escrow contract together with the oracle contract
//! (cross-contract call path) and verify:
//!   - Correct state transitions at every step
//!   - Token balance changes for both players and the escrow contract
//!   - `get_escrow_balance` and `is_funded` query accuracy throughout
//!   - All expected events are emitted with correct data
//!   - Error paths: wrong oracle, game_id mismatch, invalid state re-entry

use super::*;
use smile4money_oracle::{OracleContract, OracleContractClient};
use smile4money_oracle::types::MatchResult;
use soroban_sdk::{
    testutils::{Address as _, Events},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env, IntoVal, String, Symbol, TryFromVal,
};

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

/// Spin up a fresh environment with two players, a token, an oracle contract,
/// and an initialised escrow contract.  Each player starts with 1 000 tokens.
///
/// Returns `(env, escrow_id, oracle_service_addr, player1, player2, token_addr, admin)`.
fn setup_e2e() -> (Env, Address, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let oracle_service = Address::generate(&env);
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = token_id.address();
    let asset_client = StellarAssetClient::new(&env, &token_addr);
    asset_client.mint(&player1, &1_000);
    asset_client.mint(&player2, &1_000);

    // Deploy oracle contract and initialise it with the oracle service address as admin
    let oracle_contract_id = env.register(OracleContract, ());
    let oracle_client = OracleContractClient::new(&env, &oracle_contract_id);
    oracle_client.initialize(&oracle_service);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&oracle_service, &oracle_contract_id, &admin, &token_addr);

    (env, contract_id, oracle_service, player1, player2, token_addr, admin)
}

/// Convenience: submit a result to the oracle contract *and* trigger the escrow payout.
fn oracle_submit_e2e(
    env: &Env,
    escrow_id: &Address,
    oracle_service: &Address,
    match_id: u64,
    game_id: &str,
    result: MatchResult,
) {
    let oracle_contract_addr: Address = env.as_contract(escrow_id, || {
        env.storage()
            .instance()
            .get(&DataKey::OracleContract)
            .unwrap()
    });
    let oracle_client = OracleContractClient::new(env, &oracle_contract_addr);
    oracle_client.submit_result(&match_id, &String::from_str(env, game_id), &result);

    let escrow_client = EscrowContractClient::new(env, escrow_id);
    escrow_client.submit_result(&match_id, oracle_service);
}

// ---------------------------------------------------------------------------
// Full lifecycle -- Player 1 wins
// ---------------------------------------------------------------------------

/// Complete happy-path: create -> p1 deposit -> p2 deposit -> oracle submits
/// Player1 wins -> verify balances, state, escrow balance, and events.
#[test]
fn test_e2e_lifecycle_player1_wins() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let stake: i128 = 250;
    let game_id = String::from_str(&env, "e2e-game-p1-wins");

    // -- Step 1: Create match ------------------------------------------------
    let match_id = client.create_match(
        &player1,
        &player2,
        &stake,
        &token,
        &game_id,
        &Platform::Lichess,
    );

    // State: Pending, no deposits yet
    let m = client.get_match(&match_id);
    assert_eq!(m.state, MatchState::Pending);
    assert!(!m.player1_deposited);
    assert!(!m.player2_deposited);
    assert!(!client.is_funded(&match_id));
    assert_eq!(client.get_escrow_balance(&match_id), 0);

    // Balances unchanged after creation
    assert_eq!(token_client.balance(&player1), 1_000);
    assert_eq!(token_client.balance(&player2), 1_000);

    // -- Step 2: Player 1 deposits -------------------------------------------
    client.deposit(&match_id, &player1);

    let m = client.get_match(&match_id);
    assert_eq!(m.state, MatchState::Pending); // still Pending -- only one deposit
    assert!(m.player1_deposited);
    assert!(!m.player2_deposited);
    assert!(!client.is_funded(&match_id));
    assert_eq!(client.get_escrow_balance(&match_id), stake);
    assert_eq!(token_client.balance(&player1), 1_000 - stake);
    assert_eq!(token_client.balance(&player2), 1_000); // untouched

    // -- Step 3: Player 2 deposits -> match becomes Active -------------------
    client.deposit(&match_id, &player2);

    let m = client.get_match(&match_id);
    assert_eq!(m.state, MatchState::Active);
    assert!(m.player1_deposited);
    assert!(m.player2_deposited);
    assert!(client.is_funded(&match_id));
    assert_eq!(client.get_escrow_balance(&match_id), stake * 2);
    assert_eq!(token_client.balance(&player1), 1_000 - stake);
    assert_eq!(token_client.balance(&player2), 1_000 - stake);

    // -- Step 4: Oracle submits result -- Player 1 wins ----------------------
    oracle_submit_e2e(&env, &contract_id, &oracle, match_id, "e2e-game-p1-wins", MatchResult::Player1Wins);

    // Capture events immediately after submit_result, before any other calls
    let events = env.events().all();
    let completed_topics = vec![
        &env,
        Symbol::new(&env, "match").into_val(&env),
        soroban_sdk::symbol_short!("completed").into_val(&env),
    ];
    let (_, _, data) = events
        .iter()
        .find(|(_, t, _)| *t == completed_topics)
        .expect("completed event not found");
    let (ev_id, ev_winner): (u64, Winner) = TryFromVal::try_from_val(&env, &data).unwrap();
    assert_eq!(ev_id, match_id);
    assert_eq!(ev_winner, Winner::Player1);

    // State: Completed
    let m = client.get_match(&match_id);
    assert_eq!(m.state, MatchState::Completed);

    // Player 1 receives the full pot (2x stake); player 2 loses their stake
    assert_eq!(token_client.balance(&player1), 1_000 + stake); // net gain = stake
    assert_eq!(token_client.balance(&player2), 1_000 - stake); // net loss = stake

    // Escrow is empty
    assert_eq!(client.get_escrow_balance(&match_id), 0);
}

// ---------------------------------------------------------------------------
// Full lifecycle -- Player 2 wins
// ---------------------------------------------------------------------------

/// Same lifecycle but the oracle declares Player 2 the winner.
#[test]
fn test_e2e_lifecycle_player2_wins() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let stake: i128 = 300;
    let game_id = String::from_str(&env, "e2e-game-p2-wins");

    // -- Create --------------------------------------------------------------
    let match_id = client.create_match(
        &player1,
        &player2,
        &stake,
        &token,
        &game_id,
        &Platform::ChessDotCom,
    );

    assert_eq!(client.get_match(&match_id).state, MatchState::Pending);

    // -- Both players deposit ------------------------------------------------
    client.deposit(&match_id, &player1);
    assert_eq!(client.get_match(&match_id).state, MatchState::Pending);
    assert_eq!(client.get_escrow_balance(&match_id), stake);

    client.deposit(&match_id, &player2);
    assert_eq!(client.get_match(&match_id).state, MatchState::Active);
    assert_eq!(client.get_escrow_balance(&match_id), stake * 2);
    assert!(client.is_funded(&match_id));

    // -- Oracle submits result -- Player 2 wins ------------------------------
    oracle_submit_e2e(&env, &contract_id, &oracle, match_id, "e2e-game-p2-wins", MatchResult::Player2Wins);

    // Capture events immediately after submit_result
    let events = env.events().all();
    let completed_topics = vec![
        &env,
        Symbol::new(&env, "match").into_val(&env),
        soroban_sdk::symbol_short!("completed").into_val(&env),
    ];
    let (_, _, data) = events
        .iter()
        .find(|(_, t, _)| *t == completed_topics)
        .expect("completed event not found");
    let (ev_id, ev_winner): (u64, Winner) = TryFromVal::try_from_val(&env, &data).unwrap();
    assert_eq!(ev_id, match_id);
    assert_eq!(ev_winner, Winner::Player2);

    assert_eq!(client.get_match(&match_id).state, MatchState::Completed);

    // Player 2 receives the full pot; player 1 loses their stake
    assert_eq!(token_client.balance(&player2), 1_000 + stake); // net gain = stake
    assert_eq!(token_client.balance(&player1), 1_000 - stake); // net loss = stake
    assert_eq!(client.get_escrow_balance(&match_id), 0);
}

// ---------------------------------------------------------------------------
// Full lifecycle -- Draw
// ---------------------------------------------------------------------------

/// Same lifecycle but the oracle declares a draw; both players are refunded.
#[test]
fn test_e2e_lifecycle_draw() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let stake: i128 = 150;
    let game_id = String::from_str(&env, "e2e-game-draw");

    // -- Create --------------------------------------------------------------
    let match_id = client.create_match(
        &player1,
        &player2,
        &stake,
        &token,
        &game_id,
        &Platform::Lichess,
    );

    assert_eq!(client.get_match(&match_id).state, MatchState::Pending);
    assert_eq!(client.get_escrow_balance(&match_id), 0);

    // -- Both players deposit (reversed order to confirm order independence) -
    client.deposit(&match_id, &player2);
    assert_eq!(client.get_match(&match_id).state, MatchState::Pending);
    assert_eq!(client.get_escrow_balance(&match_id), stake);
    assert_eq!(token_client.balance(&player2), 1_000 - stake);

    client.deposit(&match_id, &player1);
    assert_eq!(client.get_match(&match_id).state, MatchState::Active);
    assert_eq!(client.get_escrow_balance(&match_id), stake * 2);
    assert!(client.is_funded(&match_id));

    // -- Oracle submits result -- Draw ----------------------------------------
    oracle_submit_e2e(&env, &contract_id, &oracle, match_id, "e2e-game-draw", MatchResult::Draw);

    // Capture events immediately after submit_result
    let events = env.events().all();
    let completed_topics = vec![
        &env,
        Symbol::new(&env, "match").into_val(&env),
        soroban_sdk::symbol_short!("completed").into_val(&env),
    ];
    let (_, _, data) = events
        .iter()
        .find(|(_, t, _)| *t == completed_topics)
        .expect("completed event not found");
    let (ev_id, ev_winner): (u64, Winner) = TryFromVal::try_from_val(&env, &data).unwrap();
    assert_eq!(ev_id, match_id);
    assert_eq!(ev_winner, Winner::Draw);

    assert_eq!(client.get_match(&match_id).state, MatchState::Completed);

    // Both players are refunded their exact stake -- net change is zero
    assert_eq!(token_client.balance(&player1), 1_000);
    assert_eq!(token_client.balance(&player2), 1_000);
    assert_eq!(client.get_escrow_balance(&match_id), 0);
}

// ---------------------------------------------------------------------------
// All three outcomes in a single environment (sequential matches)
// ---------------------------------------------------------------------------

/// Run three independent matches back-to-back in the same environment to
/// confirm the contract handles multiple concurrent game IDs correctly and
/// that each match payout is isolated.
#[test]
fn test_e2e_all_three_outcomes_sequential() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let stake: i128 = 100;

    // -- Match 0: Player 1 wins ----------------------------------------------
    let id0 = client.create_match(
        &player1,
        &player2,
        &stake,
        &token,
        &String::from_str(&env, "seq-game-0"),
        &Platform::Lichess,
    );
    client.deposit(&id0, &player1);
    client.deposit(&id0, &player2);
    assert_eq!(client.get_match(&id0).state, MatchState::Active);

    oracle_submit_e2e(&env, &contract_id, &oracle, id0, "seq-game-0", MatchResult::Player1Wins);
    assert_eq!(client.get_match(&id0).state, MatchState::Completed);
    // After match 0: p1 = 1000 + 100 = 1100, p2 = 1000 - 100 = 900
    assert_eq!(token_client.balance(&player1), 1_100);
    assert_eq!(token_client.balance(&player2), 900);

    // -- Match 1: Player 2 wins ----------------------------------------------
    let id1 = client.create_match(
        &player1,
        &player2,
        &stake,
        &token,
        &String::from_str(&env, "seq-game-1"),
        &Platform::ChessDotCom,
    );
    client.deposit(&id1, &player1);
    client.deposit(&id1, &player2);
    assert_eq!(client.get_match(&id1).state, MatchState::Active);

    oracle_submit_e2e(&env, &contract_id, &oracle, id1, "seq-game-1", MatchResult::Player2Wins);
    assert_eq!(client.get_match(&id1).state, MatchState::Completed);
    // After match 1: p1 = 1100 - 100 = 1000, p2 = 900 + 100 = 1000
    assert_eq!(token_client.balance(&player1), 1_000);
    assert_eq!(token_client.balance(&player2), 1_000);

    // -- Match 2: Draw -------------------------------------------------------
    let id2 = client.create_match(
        &player1,
        &player2,
        &stake,
        &token,
        &String::from_str(&env, "seq-game-2"),
        &Platform::Lichess,
    );
    client.deposit(&id2, &player1);
    client.deposit(&id2, &player2);
    assert_eq!(client.get_match(&id2).state, MatchState::Active);

    oracle_submit_e2e(&env, &contract_id, &oracle, id2, "seq-game-2", MatchResult::Draw);
    assert_eq!(client.get_match(&id2).state, MatchState::Completed);
    // After draw: both players back to 1000
    assert_eq!(token_client.balance(&player1), 1_000);
    assert_eq!(token_client.balance(&player2), 1_000);

    // All three matches are independently completed with sequential IDs
    assert_eq!(id0, 0);
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(client.get_match(&id0).state, MatchState::Completed);
    assert_eq!(client.get_match(&id1).state, MatchState::Completed);
    assert_eq!(client.get_match(&id2).state, MatchState::Completed);
}

// ---------------------------------------------------------------------------
// Error paths: invalid oracle
// ---------------------------------------------------------------------------

/// An address that is not the registered oracle must be rejected with
/// `Unauthorized` even after both players have deposited.
#[test]
fn test_e2e_unauthorized_oracle_rejected() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);

    let game_id = String::from_str(&env, "e2e-unauth-oracle");
    let match_id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &game_id,
        &Platform::Lichess,
    );
    client.deposit(&match_id, &player1);
    client.deposit(&match_id, &player2);
    assert_eq!(client.get_match(&match_id).state, MatchState::Active);

    let impostor = Address::generate(&env);
    assert_eq!(
        client.try_submit_result(&match_id, &impostor),
        Err(Ok(Error::Unauthorized))
    );

    // Match must remain Active -- no payout occurred
    assert_eq!(client.get_match(&match_id).state, MatchState::Active);
}

// ---------------------------------------------------------------------------
// Error paths: game_id mismatch
// ---------------------------------------------------------------------------

/// The oracle must supply the exact game_id stored in the match.  A mismatched
/// game_id must be rejected with `GameIdMismatch` and leave the match Active.
#[test]
fn test_e2e_game_id_mismatch_rejected() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);

    let real_game_id = String::from_str(&env, "e2e-real-game");
    let wrong_game_id = String::from_str(&env, "e2e-wrong-game");

    let match_id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &real_game_id,
        &Platform::Lichess,
    );
    client.deposit(&match_id, &player1);
    client.deposit(&match_id, &player2);

    // Submit a result to the oracle contract for the wrong game_id.
    // The escrow must detect the mismatch and return GameIdMismatch.
    let oracle_contract_addr: Address = env.as_contract(&contract_id, || {
        env.storage().instance().get(&DataKey::OracleContract).unwrap()
    });
    let oracle_client = OracleContractClient::new(&env, &oracle_contract_addr);
    oracle_client.submit_result(&match_id, &wrong_game_id, &MatchResult::Player1Wins);

    assert_eq!(
        client.try_submit_result(&match_id, &oracle),
        Err(Ok(Error::GameIdMismatch))
    );

    // Match must remain Active
    assert_eq!(client.get_match(&match_id).state, MatchState::Active);
}

// ---------------------------------------------------------------------------
// Error paths: submit_result on Pending match
// ---------------------------------------------------------------------------

/// Submitting a result before both players have deposited (Pending state) must
/// return `InvalidState`.
#[test]
fn test_e2e_submit_result_on_pending_match_fails() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);

    let game_id = String::from_str(&env, "e2e-pending-submit");
    let match_id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &game_id,
        &Platform::Lichess,
    );

    // No deposits -- match is still Pending
    assert_eq!(
        client.try_submit_result(&match_id, &oracle),
        Err(Ok(Error::InvalidState))
    );
}

// ---------------------------------------------------------------------------
// Error paths: double payout prevention
// ---------------------------------------------------------------------------

/// Once a match is Completed, a second call to `submit_result` must return
/// `InvalidState` -- no double-payout is possible.
#[test]
fn test_e2e_no_double_payout_after_completion() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let game_id = String::from_str(&env, "e2e-double-payout");
    let match_id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &game_id,
        &Platform::Lichess,
    );
    client.deposit(&match_id, &player1);
    client.deposit(&match_id, &player2);
    oracle_submit_e2e(&env, &contract_id, &oracle, match_id, "e2e-double-payout", MatchResult::Player1Wins);

    assert_eq!(client.get_match(&match_id).state, MatchState::Completed);
    let p1_balance_after_first = token_client.balance(&player1);

    // Second submit_result must be rejected (escrow is already Completed)
    assert_eq!(
        client.try_submit_result(&match_id, &oracle),
        Err(Ok(Error::InvalidState))
    );

    // Balances must not have changed
    assert_eq!(token_client.balance(&player1), p1_balance_after_first);
}

// ---------------------------------------------------------------------------
// Error paths: deposit after completion / cancellation
// ---------------------------------------------------------------------------

/// Depositing into a Completed match must return `MatchCompleted`.
#[test]
fn test_e2e_deposit_into_completed_match_fails() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);

    let game_id = String::from_str(&env, "e2e-dep-completed");
    let match_id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &game_id,
        &Platform::Lichess,
    );
    client.deposit(&match_id, &player1);
    client.deposit(&match_id, &player2);
    oracle_submit_e2e(&env, &contract_id, &oracle, match_id, "e2e-dep-completed", MatchResult::Draw);

    assert_eq!(
        client.try_deposit(&match_id, &player1),
        Err(Ok(Error::MatchCompleted))
    );
}

/// Depositing into a Cancelled match must return `MatchCancelled`.
#[test]
fn test_e2e_deposit_into_cancelled_match_fails() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);

    let match_id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "e2e-dep-cancelled"),
        &Platform::Lichess,
    );
    client.cancel_match(&match_id, &player1);

    assert_eq!(
        client.try_deposit(&match_id, &player1),
        Err(Ok(Error::MatchCancelled))
    );
}

// ---------------------------------------------------------------------------
// Escrow balance tracks correctly through the full lifecycle
// ---------------------------------------------------------------------------

/// Verify `get_escrow_balance` returns the correct value at every stage:
/// 0 (created) -> stake (p1 deposited) -> 2xstake (p2 deposited) -> 0 (completed).
#[test]
fn test_e2e_escrow_balance_full_lifecycle() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);

    let stake: i128 = 200;
    let game_id = String::from_str(&env, "e2e-balance-lifecycle");

    let match_id = client.create_match(
        &player1,
        &player2,
        &stake,
        &token,
        &game_id,
        &Platform::ChessDotCom,
    );

    assert_eq!(client.get_escrow_balance(&match_id), 0);

    client.deposit(&match_id, &player1);
    assert_eq!(client.get_escrow_balance(&match_id), stake);

    client.deposit(&match_id, &player2);
    assert_eq!(client.get_escrow_balance(&match_id), stake * 2);

    oracle_submit_e2e(&env, &contract_id, &oracle, match_id, "e2e-balance-lifecycle", MatchResult::Player1Wins);
    assert_eq!(client.get_escrow_balance(&match_id), 0);
}
// ---------------------------------------------------------------------------

/// Confirm that all four expected events are emitted during a complete match
/// lifecycle: created -> deposit (x2) -> activated -> completed.
/// Also verifies the payload of the "created", "activated", and "completed" events.
///
/// Note: env.events().all() returns events from the most recent contract
/// invocation and clears the buffer. Events are captured immediately after
/// each relevant call.
#[test]
fn test_e2e_event_sequence_full_lifecycle() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);

    let game_id = String::from_str(&env, "e2e-event-seq");

    // Capture "created" event immediately after create_match
    let match_id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &game_id,
        &Platform::Lichess,
    );
    let events_after_create = env.events().all();
    let created_topics = vec![
        &env,
        Symbol::new(&env, "match").into_val(&env),
        soroban_sdk::symbol_short!("created").into_val(&env),
    ];
    let (_, _, created_data) = events_after_create
        .iter()
        .find(|(_, t, _)| *t == created_topics)
        .expect("created event not found");
    let (ev_id, ev_p1, ev_p2, ev_stake): (u64, Address, Address, i128) =
        TryFromVal::try_from_val(&env, &created_data).unwrap();
    assert_eq!(ev_id, match_id);
    assert_eq!(ev_p1, player1);
    assert_eq!(ev_p2, player2);
    assert_eq!(ev_stake, 100);

    // Capture "deposit" event after player1 deposits
    client.deposit(&match_id, &player1);
    let events_after_p1_deposit = env.events().all();
    let deposit_topics = vec![
        &env,
        Symbol::new(&env, "match").into_val(&env),
        soroban_sdk::symbol_short!("deposit").into_val(&env),
    ];
    assert!(
        events_after_p1_deposit.iter().any(|(_, t, _)| t == deposit_topics),
        "expected (match, deposit) event after player1 deposit"
    );

    // Capture "activated" event after player2 deposits (triggers activation)
    client.deposit(&match_id, &player2);
    let events_after_p2_deposit = env.events().all();
    let activated_topics = vec![
        &env,
        Symbol::new(&env, "match").into_val(&env),
        soroban_sdk::symbol_short!("activated").into_val(&env),
    ];
    let (_, _, activated_data) = events_after_p2_deposit
        .iter()
        .find(|(_, t, _)| *t == activated_topics)
        .expect("activated event not found");
    let ev_activated_id: u64 = TryFromVal::try_from_val(&env, &activated_data).unwrap();
    assert_eq!(ev_activated_id, match_id);

    // Capture "completed" event after oracle submits result
    oracle_submit_e2e(&env, &contract_id, &oracle, match_id, "e2e-event-seq", MatchResult::Player1Wins);
    let events_after_submit = env.events().all();
    let completed_topics = vec![
        &env,
        Symbol::new(&env, "match").into_val(&env),
        soroban_sdk::symbol_short!("completed").into_val(&env),
    ];
    let (_, _, completed_data) = events_after_submit
        .iter()
        .find(|(_, t, _)| *t == completed_topics)
        .expect("completed event not found");
    let (ev_completed_id, ev_winner): (u64, Winner) =
        TryFromVal::try_from_val(&env, &completed_data).unwrap();
    assert_eq!(ev_completed_id, match_id);
    assert_eq!(ev_winner, Winner::Player1);
}

// ---------------------------------------------------------------------------
// Issue #179: Oracle-escrow integration — cross-contract result verification
// ---------------------------------------------------------------------------

/// Full integration test: oracle contract stores result → escrow reads it via
/// cross-contract call → payout is executed.
///
/// This test closes issue #179 by verifying that:
///   1. The escrow contract reads the result from the oracle contract's
///      on-chain storage (not from a caller-supplied parameter).
///   2. The escrow rejects payout if the oracle contract has no result yet
///      (`OracleResultNotFound`).
///   3. Once the oracle contract has the result, the escrow executes the
///      correct payout atomically.
///   4. The oracle contract's `game_id` is cross-checked against the match's
///      `game_id` (`GameIdMismatch` if they differ).
///   5. All three outcomes (Player1 wins, Player2 wins, Draw) work correctly.
#[test]
fn test_e2e_oracle_escrow_integration_player1_wins() {
    let (env, contract_id, oracle_service, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let stake: i128 = 500;
    let game_id_str = "integration-game-p1";
    let game_id = String::from_str(&env, game_id_str);

    // Retrieve the oracle contract address stored in the escrow
    let oracle_contract_addr: Address = env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .get(&DataKey::OracleContract)
            .unwrap()
    });
    let oracle_client = OracleContractClient::new(&env, &oracle_contract_addr);

    // -- Step 1: Create match and fund it ------------------------------------
    let match_id = client.create_match(
        &player1, &player2, &stake, &token, &game_id, &Platform::Lichess,
    );
    client.deposit(&match_id, &player1);
    client.deposit(&match_id, &player2);
    assert_eq!(client.get_match(&match_id).state, MatchState::Active);

    // -- Step 2: Escrow rejects payout if oracle has no result yet -----------
    assert_eq!(
        client.try_submit_result(&match_id, &oracle_service),
        Err(Ok(Error::OracleResultNotFound)),
        "escrow must reject payout when oracle contract has no result yet"
    );
    // Match must remain Active — no payout occurred
    assert_eq!(client.get_match(&match_id).state, MatchState::Active);
    assert_eq!(token_client.balance(&player1), 1_000 - stake);
    assert_eq!(token_client.balance(&player2), 1_000 - stake);

    // -- Step 3: Oracle service commits result to oracle contract ------------
    oracle_client.submit_result(&match_id, &game_id, &MatchResult::Player1Wins);
    assert!(oracle_client.has_result(&match_id));
    assert_eq!(oracle_client.get_result(&match_id).result, MatchResult::Player1Wins);

    // -- Step 4: Escrow reads oracle result and executes payout --------------
    client.submit_result(&match_id, &oracle_service);

    // Player1 wins: receives 2x stake; player2 loses their stake
    assert_eq!(token_client.balance(&player1), 1_000 + stake);
    assert_eq!(token_client.balance(&player2), 1_000 - stake);
    assert_eq!(client.get_match(&match_id).state, MatchState::Completed);
    assert_eq!(client.get_escrow_balance(&match_id), 0);
}

#[test]
fn test_e2e_oracle_escrow_integration_player2_wins() {
    let (env, contract_id, oracle_service, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let stake: i128 = 300;
    let game_id = String::from_str(&env, "integration-game-p2");

    let oracle_contract_addr: Address = env.as_contract(&contract_id, || {
        env.storage().instance().get(&DataKey::OracleContract).unwrap()
    });
    let oracle_client = OracleContractClient::new(&env, &oracle_contract_addr);

    let match_id = client.create_match(
        &player1, &player2, &stake, &token, &game_id, &Platform::ChessDotCom,
    );
    client.deposit(&match_id, &player1);
    client.deposit(&match_id, &player2);

    oracle_client.submit_result(&match_id, &game_id, &MatchResult::Player2Wins);
    client.submit_result(&match_id, &oracle_service);

    assert_eq!(token_client.balance(&player2), 1_000 + stake);
    assert_eq!(token_client.balance(&player1), 1_000 - stake);
    assert_eq!(client.get_match(&match_id).state, MatchState::Completed);
}

#[test]
fn test_e2e_oracle_escrow_integration_draw() {
    let (env, contract_id, oracle_service, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let stake: i128 = 200;
    let game_id = String::from_str(&env, "integration-game-draw");

    let oracle_contract_addr: Address = env.as_contract(&contract_id, || {
        env.storage().instance().get(&DataKey::OracleContract).unwrap()
    });
    let oracle_client = OracleContractClient::new(&env, &oracle_contract_addr);

    let match_id = client.create_match(
        &player1, &player2, &stake, &token, &game_id, &Platform::Lichess,
    );
    client.deposit(&match_id, &player1);
    client.deposit(&match_id, &player2);

    oracle_client.submit_result(&match_id, &game_id, &MatchResult::Draw);
    client.submit_result(&match_id, &oracle_service);

    // Draw: both players get their stake back
    assert_eq!(token_client.balance(&player1), 1_000);
    assert_eq!(token_client.balance(&player2), 1_000);
    assert_eq!(client.get_match(&match_id).state, MatchState::Completed);
    assert_eq!(client.get_escrow_balance(&match_id), 0);
}

/// Verify that the escrow cross-checks the oracle result's game_id against the
/// match's game_id.  If the oracle committed a result for a different game_id
/// (e.g. due to a match_id collision), the escrow must reject with GameIdMismatch.
#[test]
fn test_e2e_oracle_game_id_mismatch_rejected() {
    let (env, contract_id, oracle_service, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);

    let oracle_contract_addr: Address = env.as_contract(&contract_id, || {
        env.storage().instance().get(&DataKey::OracleContract).unwrap()
    });
    let oracle_client = OracleContractClient::new(&env, &oracle_contract_addr);

    // Create match with game_id "real-game"
    let match_id = client.create_match(
        &player1, &player2, &100, &token,
        &String::from_str(&env, "real-game"), &Platform::Lichess,
    );
    client.deposit(&match_id, &player1);
    client.deposit(&match_id, &player2);

    // Oracle commits a result for a *different* game_id under the same match_id
    oracle_client.submit_result(
        &match_id,
        &String::from_str(&env, "wrong-game"),
        &MatchResult::Player1Wins,
    );

    // Escrow must detect the mismatch and reject
    assert_eq!(
        client.try_submit_result(&match_id, &oracle_service),
        Err(Ok(Error::GameIdMismatch))
    );
    assert_eq!(client.get_match(&match_id).state, MatchState::Active);
}

/// Verify that the escrow rejects payout when the oracle contract has no result
/// for the given match_id, returning OracleResultNotFound.
#[test]
fn test_e2e_oracle_result_not_found_rejected() {
    let (env, contract_id, oracle_service, player1, player2, token, _admin) = setup_e2e();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let stake: i128 = 150;
    let match_id = client.create_match(
        &player1, &player2, &stake, &token,
        &String::from_str(&env, "no-oracle-result"), &Platform::Lichess,
    );
    client.deposit(&match_id, &player1);
    client.deposit(&match_id, &player2);

    // Oracle has NOT submitted a result yet
    assert_eq!(
        client.try_submit_result(&match_id, &oracle_service),
        Err(Ok(Error::OracleResultNotFound))
    );

    // Match must remain Active and balances unchanged
    assert_eq!(client.get_match(&match_id).state, MatchState::Active);
    assert_eq!(token_client.balance(&player1), 1_000 - stake);
    assert_eq!(token_client.balance(&player2), 1_000 - stake);
}
