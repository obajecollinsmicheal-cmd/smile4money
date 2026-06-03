extern crate std;
use super::*;
use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, Events},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env, IntoVal, String, Symbol, TryFromVal,
};

fn setup() -> (Env, Address, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = token_id.address();
    let asset_client = StellarAssetClient::new(&env, &token_addr);
    asset_client.mint(&player1, &1000);
    asset_client.mint(&player2, &1000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&oracle, &admin, &token_addr);

    (
        env,
        contract_id,
        oracle,
        player1,
        player2,
        token_addr,
        admin,
    )
}

#[test]
fn test_create_match() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "abc123"),
        &Platform::Lichess,
    );

    assert_eq!(id, 0);
    let m = client.get_match(&id);
    assert_eq!(m.state, MatchState::Pending);
    assert_eq!(m.created_ledger, env.ledger().sequence());
}

#[test]
fn test_get_match_not_found() {
    let (env, contract_id, ..) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    assert!(matches!(
        client.try_get_match(&999),
        Err(Ok(Error::MatchNotFound))
    ));
}

#[test]
fn test_create_match_empty_game_id_fails() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    assert!(matches!(
        client.try_create_match(
            &player1,
            &player2,
            &100,
            &token,
            &String::from_str(&env, ""),
            &Platform::Lichess,
        ),
        Err(Ok(Error::InvalidGameId))
    ));
}

#[test]
fn test_deposit_and_activate() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "abc123"),
        &Platform::Lichess,
    );

    client.deposit(&id, &player1);
    assert!(!client.is_funded(&id));
    client.deposit(&id, &player2);
    assert!(client.is_funded(&id));
    assert_eq!(client.get_escrow_balance(&id), 200);
    assert_eq!(client.get_match(&id).state, MatchState::Active);
    assert_eq!(token_client.balance(&player1), 900);
    assert_eq!(token_client.balance(&player2), 900);
}

#[test]
fn test_payout_winner() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "game1"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);
    client.submit_result(
        &id,
        &String::from_str(&env, "game1"),
        &Winner::Player1,
        &oracle,
    );

    assert_eq!(token_client.balance(&player1), 1100);
    assert_eq!(token_client.balance(&player2), 900);
    assert_eq!(client.get_match(&id).state, MatchState::Completed);
    assert_eq!(client.get_escrow_balance(&id), 0);
}

#[test]
fn test_payout_winner_player2() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "game_player2"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);
    client.submit_result(
        &id,
        &String::from_str(&env, "game_player2"),
        &Winner::Player2,
        &oracle,
    );

    assert_eq!(token_client.balance(&player1), 900);
    assert_eq!(token_client.balance(&player2), 1100);
    assert_eq!(client.get_match(&id).state, MatchState::Completed);
    assert_eq!(client.get_escrow_balance(&id), 0);
}

#[test]
fn test_draw_refund() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "game2"),
        &Platform::ChessDotCom,
    );
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);
    client.submit_result(
        &id,
        &String::from_str(&env, "game2"),
        &Winner::Draw,
        &oracle,
    );

    assert_eq!(token_client.balance(&player1), 1000);
    assert_eq!(token_client.balance(&player2), 1000);
}

#[test]
fn test_cancel_refunds_depositor() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "game3"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    client.cancel_match(&id, &player1);

    assert_eq!(token_client.balance(&player1), 1000);
    assert_eq!(token_client.balance(&player2), 1000);
    assert_eq!(client.get_match(&id).state, MatchState::Cancelled);
    assert_eq!(client.get_escrow_balance(&id), 0);
}

#[test]
fn test_player2_can_cancel_pending_match() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "p2cancel"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player2);
    client.cancel_match(&id, &player2);

    assert_eq!(token_client.balance(&player2), 1000);
    assert_eq!(client.get_match(&id).state, MatchState::Cancelled);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn test_cancel_with_both_deposits_requires_both_auth() {
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};

    let env = Env::default();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = token_id.address();
    let asset_client = StellarAssetClient::new(&env, &token_addr);
    asset_client.mint(&player1, &1000);
    asset_client.mint(&player2, &1000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    // Initialize with mock_all_auths for setup
    env.mock_all_auths();
    client.initialize(&oracle, &admin, &token_addr);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token_addr,
        &String::from_str(&env, "both_deposits"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);

    // Now set auth to only player1 — should panic because player2's auth is also required
    env.set_auths(&[MockAuth {
        address: &player1,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "cancel_match",
            args: (id, player1.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }
    .into()]);

    client.cancel_match(&id, &player1);
}

#[test]
fn test_cancel_active_match_fails() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "active_cancel"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);

    assert_eq!(
        client.try_cancel_match(&id, &player1),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn test_cancel_completed_match_fails() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "completed_cancel"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);
    client.submit_result(
        &id,
        &String::from_str(&env, "completed_cancel"),
        &Winner::Player1,
        &oracle,
    );

    assert_eq!(
        client.try_cancel_match(&id, &player1),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn test_deposit_into_completed_match_fails() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "completed_deposit"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);
    client.submit_result(
        &id,
        &String::from_str(&env, "completed_deposit"),
        &Winner::Player1,
        &oracle,
    );

    assert_eq!(
        client.try_deposit(&id, &player1),
        Err(Ok(Error::MatchCompleted))
    );
}

#[test]
fn test_deposit_into_cancelled_match_fails() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "cancelled_deposit"),
        &Platform::Lichess,
    );
    client.cancel_match(&id, &player1);

    assert_eq!(
        client.try_deposit(&id, &player1),
        Err(Ok(Error::MatchCancelled))
    );
}

#[test]
fn test_non_oracle_cannot_submit_result() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "unauth_oracle"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);

    let impostor = Address::generate(&env);
    assert_eq!(
        client.try_submit_result(
            &id,
            &String::from_str(&env, "unauth_oracle"),
            &Winner::Player1,
            &impostor
        ),
        Err(Ok(Error::Unauthorized))
    );
}

/// Verify that only the registered oracle address can submit results.
/// A random address passed as `caller` must be rejected with `Unauthorized`
/// regardless of what auth it presents.
#[test]
fn test_submit_result_random_caller_is_unauthorized() {
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};

    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1, &player2, &100, &token,
        &String::from_str(&env, "random_caller"), &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);

    let random = Address::generate(&env);
    let game_id = String::from_str(&env, "random_caller");

    // Provide auth for the random address — the contract must still reject it.
    env.set_auths(&[MockAuth {
        address: &random,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "submit_result",
            args: (id, game_id.clone(), Winner::Player1, random.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }
    .into()]);

    assert_eq!(
        client.try_submit_result(&id, &game_id, &Winner::Player1, &random),
        Err(Ok(Error::Unauthorized))
    );
}

// Issue #196: submit_result on a Pending match should return InvalidState
#[test]
fn test_submit_result_on_pending_match_fails() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "pending_submit"),
        &Platform::Lichess,
    );
    assert_eq!(
        client.try_submit_result(
            &id,
            &String::from_str(&env, "pending_submit"),
            &Winner::Player1,
            &oracle,
        ),
        Err(Ok(Error::InvalidState))
    );
}

// Issue #197: submit_result on an already Completed match should return InvalidState (no double-payout)
#[test]
fn test_submit_result_on_completed_match_fails() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "double_submit"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);
    client.submit_result(
        &id,
        &String::from_str(&env, "double_submit"),
        &Winner::Player1,
        &oracle,
    );

    assert_eq!(
        client.try_submit_result(
            &id,
            &String::from_str(&env, "double_submit"),
            &Winner::Player2,
            &oracle,
        ),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn test_submit_result_wrong_game_id_fails() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "real_game"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);

    assert_eq!(
        client.try_submit_result(
            &id,
            &String::from_str(&env, "wrong_game"),
            &Winner::Player1,
            &oracle,
        ),
        Err(Ok(Error::GameIdMismatch))
    );
}

#[test]
#[should_panic(expected = "Contract already initialized")]
/// Issue #110 / Issue #1: a second call to initialize must panic to prevent
/// an attacker from overwriting the oracle and admin addresses post-deployment.
fn test_double_initialize_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let oracle = Address::generate(&env);
    let admin = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&oracle, &admin, &token_addr);
    client.initialize(&oracle, &admin, &token_addr);
}

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

#[test]
fn test_create_match_self_match_fails() {
    let (env, contract_id, _oracle, player1, _player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    assert_eq!(
        client.try_create_match(
            &player1,
            &player1,
            &100,
            &token,
            &String::from_str(&env, "self_match"),
            &Platform::Lichess,
        ),
        Err(Ok(Error::InvalidPlayers))
    );
}

#[test]
fn test_duplicate_game_id_rejected() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let player3 = Address::generate(&env);
    let player4 = Address::generate(&env);

    client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "dup_game"),
        &Platform::Lichess,
    );

    assert_eq!(
        client.try_create_match(
            &player3,
            &player4,
            &100,
            &token,
            &String::from_str(&env, "dup_game"),
            &Platform::Lichess,
        ),
        Err(Ok(Error::DuplicateGameId))
    );
}

#[test]
fn test_duplicate_game_id_fails() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let player3 = Address::generate(&env);
    let player4 = Address::generate(&env);

    client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "dup_game_id"),
        &Platform::Lichess,
    );
    assert_eq!(
        client.try_create_match(
            &player3,
            &player4,
            &100,
            &token,
            &String::from_str(&env, "dup_game_id"),
            &Platform::Lichess,
        ),
        Err(Ok(Error::DuplicateGameId))
    );
}

#[test]
fn test_create_match_empty_game_id_fails() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    assert_eq!(
        client.try_create_match(
            &player1,
            &player2,
            &100,
            &token,
            &String::from_str(&env, ""),
            &Platform::Lichess,
        ),
        Err(Ok(Error::InvalidGameId))
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_unauthorized_player_cannot_cancel() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "unauth_cancel"),
        &Platform::Lichess,
    );
    client.cancel_match(&id, &Address::generate(&env));
}

// Issue #192: deposit by non-player address should return Unauthorized
#[test]
fn test_deposit_by_non_player_returns_unauthorized() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "unauth_deposit"),
        &Platform::Lichess,
    );
    let stranger = Address::generate(&env);
    assert_eq!(
        client.try_deposit(&id, &stranger),
        Err(Ok(Error::Unauthorized))
    );
}

// Issue #195: is_funded returns false after only one player deposits, true after both
#[test]
fn test_is_funded_false_after_one_deposit() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "one_deposit"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    assert!(!client.is_funded(&id));
    client.deposit(&id, &player2);
    assert!(client.is_funded(&id));
}

#[test]
fn test_escrow_balance_stages() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "balance_stages"),
        &Platform::Lichess,
    );
    assert_eq!(client.get_escrow_balance(&id), 0);
    client.deposit(&id, &player1);
    assert_eq!(client.get_escrow_balance(&id), 100);
    client.deposit(&id, &player2);
    assert_eq!(client.get_escrow_balance(&id), 200);
}

#[test]
fn test_draw_payout_exact_amounts() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "draw_exact"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);
    client.submit_result(
        &id,
        &String::from_str(&env, "draw_exact"),
        &Winner::Draw,
        &oracle,
    );

    assert_eq!(token_client.balance(&player1), 1000);
    assert_eq!(token_client.balance(&player2), 1000);
    assert_eq!(client.get_escrow_balance(&id), 0);
}

#[test]
fn test_update_oracle() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let new_oracle = Address::generate(&env);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "oracle_rotate"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);

    client.update_oracle(&new_oracle);

    // Old oracle should now be rejected
    assert_eq!(
        client.try_submit_result(
            &id,
            &String::from_str(&env, "oracle_rotate"),
            &Winner::Player1,
            &oracle,
        ),
        Err(Ok(Error::Unauthorized))
    );
    // New oracle should succeed
    client.submit_result(
        &id,
        &String::from_str(&env, "oracle_rotate"),
        &Winner::Player1,
        &new_oracle,
    );
    assert_eq!(client.get_match(&id).state, MatchState::Completed);
}

#[test]
fn test_pause_blocks_all_state_changing_operations() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    // Create a match to test deposit and cancel while paused.
    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "pause_test"),
        &Platform::Lichess,
    );

    client.pause();

    // 1. Block create_match
    assert_eq!(
        client.try_create_match(
            &player1,
            &player2,
            &100,
            &token,
            &String::from_str(&env, "paused_create"),
            &Platform::Lichess,
        ),
        Err(Ok(Error::ContractPaused))
    );

    // 2. Block deposit
    assert_eq!(
        client.try_deposit(&id, &player1),
        Err(Ok(Error::ContractPaused))
    );

    // 3. Allow cancel_match while paused
    client.cancel_match(&id, &player1);
    assert_eq!(client.get_match(&id).state, MatchState::Cancelled);

    // Now unpause and create a fresh match to verify submit_result still respects pause.
    client.unpause();
    let id2 = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "pause_test_active"),
        &Platform::Lichess,
    );
    client.deposit(&id2, &player1);
    client.deposit(&id2, &player2);

    client.pause();

    // 4. Block submit_result
    assert_eq!(
        client.try_submit_result(
            &id2,
            &String::from_str(&env, "pause_test_active"),
            &Winner::Player1,
            &oracle,
        ),
        Err(Ok(Error::ContractPaused))
    );

    client.unpause();
    // Verify submit_result works after unpause
    client.submit_result(
        &id2,
        &String::from_str(&env, "pause_test_active"),
        &Winner::Player1,
        &oracle,
    );
    assert_eq!(client.get_match(&id2).state, MatchState::Completed);
}

#[test]
fn test_non_admin_cannot_pause() {
    let (env, contract_id, _oracle, _player1, _player2, _token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let non_admin = Address::generate(&env);

    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    env.set_auths(&[MockAuth {
        address: &non_admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "pause",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }
    .into()]);

    assert!(client.try_pause().is_err());
}

#[test]
fn test_non_admin_cannot_unpause() {
    let (env, contract_id, _oracle, _player1, _player2, _token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let non_admin = Address::generate(&env);

    client.pause();

    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    env.set_auths(&[MockAuth {
        address: &non_admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "unpause",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }
    .into()]);

    assert!(client.try_unpause().is_err());
}

#[test]
fn test_pause_unpause_events() {
    let (env, contract_id, _, _, _, _, _) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    client.pause();
    let events = env.events().all();
    let last_event = events.last().unwrap();
    assert_eq!(last_event.0, contract_id);
    assert_eq!(last_event.1.len(), 2);
    assert_eq!(
        Symbol::try_from_val(&env, &last_event.1.get(0).unwrap()).unwrap(),
        Symbol::new(&env, "admin")
    );
    assert_eq!(
        Symbol::try_from_val(&env, &last_event.1.get(1).unwrap()).unwrap(),
        symbol_short!("paused")
    );
    assert!(<()>::try_from_val(&env, &last_event.2).is_ok());

    client.unpause();
    let events = env.events().all();
    let last_event = events.last().unwrap();
    assert_eq!(last_event.0, contract_id);
    assert_eq!(last_event.1.len(), 2);
    assert_eq!(
        Symbol::try_from_val(&env, &last_event.1.get(0).unwrap()).unwrap(),
        Symbol::new(&env, "admin")
    );
    assert_eq!(
        Symbol::try_from_val(&env, &last_event.1.get(1).unwrap()).unwrap(),
        symbol_short!("unpaused")
    );
    assert!(<()>::try_from_val(&env, &last_event.2).is_ok());
}

#[test]
fn test_non_admin_cannot_update_oracle() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let new_oracle = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&oracle, &admin, &token_addr);

    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    env.set_auths(&[MockAuth {
        address: &non_admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "update_oracle",
            args: (new_oracle.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }
    .into()]);

    assert!(client.try_update_oracle(&new_oracle).is_err());
}

#[test]
fn test_ttl_extended_on_state_changes() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "ttl_game"),
        &Platform::Lichess,
    );

    let check_ttl =
        |key: DataKey| env.as_contract(&contract_id, || env.storage().persistent().get_ttl(&key));

    assert_eq!(check_ttl(DataKey::Match(id)), crate::MATCH_TTL_LEDGERS);

    client.deposit(&id, &player1);
    assert_eq!(check_ttl(DataKey::Match(id)), crate::MATCH_TTL_LEDGERS);

    client.deposit(&id, &player2);
    assert_eq!(check_ttl(DataKey::Match(id)), crate::MATCH_TTL_LEDGERS);

    client.submit_result(
        &id,
        &String::from_str(&env, "ttl_game"),
        &Winner::Player2,
        &oracle,
    );
    assert_eq!(check_ttl(DataKey::Match(id)), crate::MATCH_TTL_LEDGERS);
}

#[test]
fn test_create_match_emits_event() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let game_id = String::from_str(&env, "game_ev");
    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &game_id,
        &Platform::Lichess,
    );

    let events = env.events().all();
    let topics = vec![
        &env,
        Symbol::new(&env, "match").into_val(&env),
        soroban_sdk::symbol_short!("created").into_val(&env),
    ];
    let matched = events.iter().find(|(_, t, _)| *t == topics);
    assert!(matched.is_some());

    let (_, _, data) = matched.unwrap();
    let (ev_id, ev_p1, ev_p2, ev_stake, ev_game_id): (u64, Address, Address, i128, String) =
        TryFromVal::try_from_val(&env, &data).unwrap();
    assert_eq!(ev_id, id);
    assert_eq!(ev_p1, player1);
    assert_eq!(ev_p2, player2);
    assert_eq!(ev_stake, 100);
    assert_eq!(ev_game_id, game_id);
}

#[test]
fn test_deposit_emits_event() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "deposit_ev"),
        &Platform::Lichess,
    );
    
    // Test player1 deposit
    client.deposit(&id, &player1);

    client.deposit(&id, &player2);
    
    let events = env.events().all();
    let deposit_topics = vec![
        &env,
        Symbol::new(&env, "match").into_val(&env),
        soroban_sdk::symbol_short!("deposit").into_val(&env),
    ];
    let matched = events.iter().find(|(_, t, _)| *t == deposit_topics);
    assert!(matched.is_some());

    let (_, _, data) = matched.unwrap();
    let (ev_id, ev_player, ev_amount): (u64, Address, i128) =
        TryFromVal::try_from_val(&env, &data).unwrap();
    assert_eq!((ev_id, ev_player, ev_amount), (id, player1, 100));
}

#[test]
fn test_submit_result_emits_event() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "result_ev"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);
    client.submit_result(
        &id,
        &String::from_str(&env, "result_ev"),
        &Winner::Player1,
        &oracle,
    );

    let events = env.events().all();
    let topics = vec![
        &env,
        Symbol::new(&env, "match").into_val(&env),
        soroban_sdk::symbol_short!("completed").into_val(&env),
    ];
    let matched = events.iter().find(|(_, t, _)| *t == topics);
    assert!(matched.is_some());

    let (_, _, data) = matched.unwrap();
    let (ev_id, ev_winner): (u64, Winner) = TryFromVal::try_from_val(&env, &data).unwrap();
    assert_eq!((ev_id, ev_winner), (id, Winner::Player1));
}

#[test]
fn test_cancel_match_emits_event() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "cancel_ev"),
        &Platform::Lichess,
    );
    client.cancel_match(&id, &player1);

    let events = env.events().all();
    let topics = vec![
        &env,
        Symbol::new(&env, "match").into_val(&env),
        soroban_sdk::symbol_short!("cancelled").into_val(&env),
    ];
    let matched = events.iter().find(|(_, t, _)| *t == topics);
    assert!(matched.is_some());

    let (_, _, data) = matched.unwrap();
    let (ev_id, ev_cancelled_by): (u64, Address) = TryFromVal::try_from_val(&env, &data).unwrap();
    assert_eq!(ev_id, id);
    assert_eq!(ev_cancelled_by, player1);
}

// Issue #59: Test that pause() prevents match creation
#[test]
fn test_pause_prevents_match_creation() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    client.pause();

    assert_eq!(
        client.try_create_match(
            &player1,
            &player2,
            &100,
            &token,
            &String::from_str(&env, "paused_match"),
            &Platform::Lichess,
        ),
        Err(Ok(Error::ContractPaused))
    );
}

// Issue #60: Test that unpause() re-enables match creation
#[test]
fn test_unpause_enables_match_creation() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    client.pause();
    client.unpause();

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "unpaused_match"),
        &Platform::Lichess,
    );

    assert_eq!(id, 0);
    let m = client.get_match(&id);
    assert_eq!(m.state, MatchState::Pending);
}

// Issue #61: Test that update_oracle() successfully rotates the oracle address
#[test]
fn test_update_oracle_rotates_address() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let new_oracle = Address::generate(&env);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "oracle_test"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);

    client.update_oracle(&new_oracle);

    client.submit_result(
        &id,
        &String::from_str(&env, "oracle_test"),
        &Winner::Player1,
        &new_oracle,
    );
}

// Issue #62: Test that non-admin cannot call pause(), unpause(), or update_oracle()
#[test]
fn test_non_admin_cannot_call_admin_functions() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let new_oracle = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&oracle, &admin, &token_addr);

    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};

    env.set_auths(&[MockAuth {
        address: &non_admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "pause",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }
    .into()]);
    assert!(client.try_pause().is_err());

    env.set_auths(&[MockAuth {
        address: &non_admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "unpause",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }
    .into()]);
    assert!(client.try_unpause().is_err());

    env.set_auths(&[MockAuth {
        address: &non_admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "update_oracle",
            args: (new_oracle.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }
    .into()]);
    assert!(client.try_update_oracle(&new_oracle).is_err());
}

// Issue #55: Multiple matches can be created and tracked independently
#[test]
fn test_multiple_matches_independent() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let player3 = Address::generate(&env);
    let player4 = Address::generate(&env);
    let asset_client = StellarAssetClient::new(&env, &token);
    asset_client.mint(&player3, &1000);
    asset_client.mint(&player4, &1000);

    let id0 = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "game_m0"),
        &Platform::Lichess,
    );
    let id1 = client.create_match(
        &player3,
        &player4,
        &200,
        &token,
        &String::from_str(&env, "game_m1"),
        &Platform::Lichess,
    );
    let id2 = client.create_match(
        &player1,
        &player3,
        &50,
        &token,
        &String::from_str(&env, "game_m2"),
        &Platform::ChessDotCom,
    );

    assert_eq!(id0, 0);
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);

    // Fund and complete match 0 (player1 wins)
    client.deposit(&id0, &player1);
    client.deposit(&id0, &player2);
    client.submit_result(
        &id0,
        &String::from_str(&env, "game_m0"),
        &Winner::Player1,
        &oracle,
    );
    assert_eq!(client.get_match(&id0).state, MatchState::Completed);
    assert_eq!(token_client.balance(&player1), 1100); // 1000 - 100 + 200

    // Fund and complete match 1 (draw)
    client.deposit(&id1, &player3);
    client.deposit(&id1, &player4);
    client.submit_result(
        &id1,
        &String::from_str(&env, "game_m1"),
        &Winner::Draw,
        &oracle,
    );
    assert_eq!(client.get_match(&id1).state, MatchState::Completed);
    assert_eq!(token_client.balance(&player3), 1000); // 1000 - 200 + 200 (draw refund)

    // Cancel match 2 (only player1 deposited)
    client.deposit(&id2, &player1);
    client.cancel_match(&id2, &player1);
    assert_eq!(client.get_match(&id2).state, MatchState::Cancelled);
    // player1 net: started 1000, won 200 from match0, deposited 50 for match2, refunded 50 = 1100
    assert_eq!(token_client.balance(&player1), 1100);
}

// Issue #56: Paused contract blocks deposit as well
#[test]
fn test_pause_blocks_deposit() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "pause_deposit"),
        &Platform::Lichess,
    );

    client.pause();

    assert_eq!(
        client.try_deposit(&id, &player1),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        client.try_create_match(
            &player1,
            &player2,
            &100,
            &token,
            &String::from_str(&env, "pause_create"),
            &Platform::Lichess,
        ),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        client.try_submit_result(
            &id,
            &String::from_str(&env, "pause_deposit"),
            &Winner::Player1,
            &oracle,
        ),
        Err(Ok(Error::ContractPaused))
    );

    // Unpause and verify deposit works again
    client.unpause();
    client.deposit(&id, &player1);
    assert!(!client.is_funded(&id));
}

// Issue #72: submit_result on already Cancelled match should return InvalidState
#[test]
fn test_submit_result_on_cancelled_match_fails() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "cancelled_result"),
        &Platform::Lichess,
    );
    client.cancel_match(&id, &player1);
    assert_eq!(client.get_match(&id).state, MatchState::Cancelled);

    assert_eq!(
        client.try_submit_result(
            &id,
            &String::from_str(&env, "cancelled_result"),
            &Winner::Player1,
            &oracle,
        ),
        Err(Ok(Error::InvalidState))
    );
}

// Issue #33: Already-deposited player cannot deposit again
#[test]
fn test_double_deposit_same_player_fails() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "double_dep"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    assert_eq!(
        client.try_deposit(&id, &player1),
        Err(Ok(Error::AlreadyFunded))
    );
}

// Issue #34: Negative stake_amount is rejected
#[test]
fn test_create_match_negative_stake_fails() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    assert_eq!(
        client.try_create_match(
            &player1,
            &player2,
            &-1,
            &token,
            &String::from_str(&env, "neg_stake"),
            &Platform::Lichess,
        ),
        Err(Ok(Error::InvalidAmount))
    );
}

// Issue #35: get_escrow_balance returns 0 after match is cancelled with partial deposit
#[test]
fn test_escrow_balance_zero_after_cancel() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "cancel_balance"),
        &Platform::Lichess,
    );
    client.deposit(&id, &player1);
    assert_eq!(client.get_escrow_balance(&id), 100);

    client.cancel_match(&id, &player1);
    assert_eq!(client.get_escrow_balance(&id), 0);
    assert_eq!(token_client.balance(&player1), 1000); // fully refunded
}

// Issue #180: Once both players have deposited the match transitions to Active.
// cancel_match must be rejected for Active matches — neither player can unilaterally
// cancel after both have committed funds. The only valid exit is submit_result by the oracle.
#[test]
fn test_cancel_with_both_deposits_requires_auth() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "both_dep_cancel"),
        &Platform::Lichess,
    );

    // Both players deposit → state becomes Active
    client.deposit(&id, &player1);
    client.deposit(&id, &player2);
    assert_eq!(client.get_match(&id).state, MatchState::Active);

    // Neither player can cancel once the match is Active
    assert_eq!(
        client.try_cancel_match(&id, &player1),
        Err(Ok(Error::InvalidState))
    );
    assert_eq!(
        client.try_cancel_match(&id, &player2),
        Err(Ok(Error::InvalidState))
    );

    // Match must remain Active — funds are safe
    assert_eq!(client.get_match(&id).state, MatchState::Active);
}

// Issue #100: Test that submit_result on a cancelled match returns InvalidState (no deposit)
#[test]
fn test_submit_result_on_cancelled_match_no_deposit_fails() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_match(
        &player1, &player2, &100, &token,
        &String::from_str(&env, "cancelled_result2"), &Platform::Lichess,
    );
    client.cancel_match(&id, &player1);

    assert_eq!(
        client.try_submit_result(
            &id,
            &String::from_str(&env, "cancelled_result2"),
            &Winner::Player1,
            &oracle,
        ),
        Err(Ok(Error::InvalidState))
    );
}

// Issue #225: MatchCount overflow returns Error::Overflow instead of wrapping
#[test]
fn test_match_count_overflow_returns_error() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    // Seed the counter at u64::MAX so the next increment would overflow
    env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .set(&DataKey::MatchCount, &u64::MAX);
    });

    assert_eq!(
        client.try_create_match(
            &player1,
            &player2,
            &100,
            &token,
            &String::from_str(&env, "overflow_game"),
            &Platform::Lichess,
        ),
        Err(Ok(Error::Overflow))
    );
}

// Issue #209 / Closes #36: Player2 win payout sends full pot to player2
#[test]
fn test_player2_win_payout_full_pot() {
    let (env, contract_id, oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let stake = 100_i128;

    // Record pre-match balances
    let p1_before = token_client.balance(&player1);
    let p2_before = token_client.balance(&player2);

    let id = client.create_match(
        &player1,
        &player2,
        &stake,
        &token,
        &String::from_str(&env, "p2_win_pot"),
        &Platform::Lichess,
    );

    client.deposit(&id, &player1);
    client.deposit(&id, &player2);
    assert!(client.is_funded(&id));
    assert_eq!(client.get_escrow_balance(&id), stake * 2);

    client.submit_result(
        &id,
        &String::from_str(&env, "p2_win_pot"),
        &Winner::Player2,
        &oracle,
    );

    // Player2 receives full pot (2x stake); player1 receives nothing
    // net gain = stake (deposited stake, won 2x)
    assert_eq!(token_client.balance(&player2), p2_before + stake);
    assert_eq!(token_client.balance(&player1), p1_before - stake); // net loss = stake
    assert_eq!(client.get_match(&id).state, MatchState::Completed);
    assert_eq!(client.get_escrow_balance(&id), 0);
}

// Issue #222: cancel_match refunds only player1 when only player1 has deposited;
// player2 balance must remain unchanged and escrow must return to 0.
#[test]
fn test_cancel_match_refunds_only_player1_when_only_player1_deposited() {
    let (env, contract_id, _oracle, player1, player2, token, _admin) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let id = client.create_match(
        &player1,
        &player2,
        &100,
        &token,
        &String::from_str(&env, "partial_deposit_cancel"),
        &Platform::Lichess,
    );

    // Only player1 deposits
    client.deposit(&id, &player1);
    assert_eq!(token_client.balance(&player1), 900);
    assert_eq!(token_client.balance(&player2), 1000); // player2 untouched
    assert_eq!(client.get_escrow_balance(&id), 100);

    // Cancel — player2 triggers the cancellation
    client.cancel_match(&id, &player2);

    // player1 must be fully refunded
    assert_eq!(token_client.balance(&player1), 1000);
    // player2 balance must be unchanged (never deposited, must not receive anything)
    assert_eq!(token_client.balance(&player2), 1000);
    // Escrow must be empty
    assert_eq!(client.get_escrow_balance(&id), 0);
    // Match must be in Cancelled state
    assert_eq!(client.get_match(&id).state, MatchState::Cancelled);
}

