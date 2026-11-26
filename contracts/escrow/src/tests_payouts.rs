//! Tests for #2061 (pause events), #2063 (pre-flight balance),
//! #2065 (payout validation) and #2066 (payout failure recovery).

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, IssuerFlags, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Env, IntoVal, String, Symbol,
};

const STAKE: i128 = 1_000;
const DISPUTE_WINDOW: u32 = 10;

struct Setup {
    env: Env,
    client: EscrowContractClient<'static>,
    contract: Address,
    admin: Address,
    oracle: Address,
    token: Address,
    p1: Address,
    p2: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let safe = Address::generate(&env);
    // Revocable + clawback, so tests can freeze a payee or shrink the escrow.
    let asset = env.register_stellar_asset_contract_v2(admin.clone());
    asset.issuer().set_flag(IssuerFlags::RevocableFlag);
    asset.issuer().set_flag(IssuerFlags::ClawbackEnabledFlag);
    let token = asset.address();
    let contract = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract);
    client.initialize(&oracle, &admin, &token, &safe, &Some(DISPUTE_WINDOW), &None);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let sac = StellarAssetClient::new(&env, &token);
    let tok = TokenClient::new(&env, &token);
    for p in [&p1, &p2] {
        sac.mint(p, &1_000_000);
        tok.approve(p, &contract, &1_000_000, &1_000);
    }
    // Cover the escrow's reserve buffer, as an operator would.
    sac.mint(&contract, &ESCROW_RESERVE_BUFFER_STROOPS);
    Setup { env, client, contract, admin, oracle, token, p1, p2 }
}

fn sac(s: &Setup) -> StellarAssetClient<'static> {
    StellarAssetClient::new(&s.env, &s.token)
}

fn balance(s: &Setup, who: &Address) -> i128 {
    TokenClient::new(&s.env, &s.token).balance(who)
}

/// Create, fund and report a result; returns the match id, ready to finalize.
fn ready_to_finalize(s: &Setup, winner: Winner) -> u64 {
    let game_id = String::from_str(&s.env, "pay12345");
    let id = s.client.create_match(&s.p1, &s.p2, &STAKE, &None, &game_id, &Platform::Lichess);
    s.client.deposit(&id, &s.p1);
    s.client.deposit(&id, &s.p2);
    s.client.submit_result(&id, &game_id, &winner, &s.oracle);
    s.env.ledger().with_mut(|l| {
        l.sequence_number += DISPUTE_WINDOW + 1;
        l.timestamp += 100;
    });
    id
}

// ── #2061 ──────────────────────────────────────────────────────────────────

fn last_event(s: &Setup) -> (soroban_sdk::Vec<soroban_sdk::Val>, soroban_sdk::Val) {
    let (_, topics, data) = s.env.events().all().last().unwrap();
    (topics, data)
}

#[test]
fn pause_and_unpause_emit_admin_reason_and_time() {
    let s = setup();
    s.env.ledger().with_mut(|l| {
        l.timestamp = 1_700_000_000;
        l.sequence_number = 42;
    });
    let reason = String::from_str(&s.env, "oracle key rotation");
    s.client.pause(&s.admin, &reason);
    let (topics, data) = last_event(&s);
    assert_eq!(
        topics,
        (symbol_short!("paused"), s.admin.clone()).into_val(&s.env)
    );
    let data: (String, u64, u32) = data.into_val(&s.env);
    assert_eq!(data, (reason, 1_700_000_000, 42));
    assert!(s.client.is_paused());

    let reason = String::from_str(&s.env, "rotation done");
    s.client.unpause(&s.admin, &reason);
    let (topics, data) = last_event(&s);
    assert_eq!(
        topics,
        (symbol_short!("unpaused"), s.admin.clone()).into_val(&s.env)
    );
    let data: (String, u64, u32) = data.into_val(&s.env);
    assert_eq!(data.0, reason);
}

#[test]
fn pause_events_name_the_acting_secondary_admin() {
    let s = setup();
    let ops = Address::generate(&s.env);
    s.client.assign_role(&s.admin, &ops, &AdminRole::Secondary);
    s.client.pause(&ops, &String::from_str(&s.env, "incident"));
    let (topics, _) = last_event(&s);
    assert_eq!(topics, (symbol_short!("paused"), ops).into_val(&s.env));
}

#[test]
fn pause_requires_a_reason() {
    let s = setup();
    assert_eq!(
        s.client.try_pause(&s.admin, &String::from_str(&s.env, "")),
        Err(Ok(Error::InvalidPauseReason))
    );
    let long = String::from_str(&s.env, &"x".repeat(257));
    assert_eq!(s.client.try_pause(&s.admin, &long), Err(Ok(Error::InvalidPauseReason)));
    assert!(!s.client.is_paused());
}

// ── #2065 ──────────────────────────────────────────────────────────────────

#[test]
fn payout_amounts_match_the_outcome() {
    assert_eq!(payout_amounts(&Winner::Player1, 7), (14, 0));
    assert_eq!(payout_amounts(&Winner::Player2, 7), (0, 14));
    assert_eq!(payout_amounts(&Winner::Draw, 7), (7, 7));
    for w in [Winner::Player1, Winner::Player2, Winner::Draw] {
        let (a, b) = payout_amounts(&w, 7);
        assert_eq!(validate_payout(&w, 7, a, b), Ok(()));
    }
}

#[test]
fn validate_payout_rejects_discrepancies() {
    for (w, a, b) in [
        (Winner::Player1, 13, 0),
        (Winner::Player1, 14, 1),
        (Winner::Player1, 0, 14),
        (Winner::Player2, 14, 0),
        (Winner::Draw, 14, 0),
        (Winner::Draw, 8, 6),
    ] {
        assert_eq!(validate_payout(&w, 7, a, b), Err(Error::PayoutMismatch), "{w:?} {a} {b}");
    }
    assert_eq!(validate_payout(&Winner::Draw, 0, 0, 0), Err(Error::PayoutMismatch));
}

#[test]
fn winner_receives_exactly_twice_the_stake() {
    let s = setup();
    let id = ready_to_finalize(&s, Winner::Player2);
    let (b1, b2) = (balance(&s, &s.p1), balance(&s, &s.p2));
    s.client.finalize_result(&id, &s.p1);
    assert_eq!(balance(&s, &s.p1), b1);
    assert_eq!(balance(&s, &s.p2), b2 + 2 * STAKE);
    assert_eq!(s.client.get_match(&id).state, MatchState::Completed);
}

#[test]
fn draw_returns_each_stake() {
    let s = setup();
    let id = ready_to_finalize(&s, Winner::Draw);
    let (b1, b2) = (balance(&s, &s.p1), balance(&s, &s.p2));
    s.client.finalize_result(&id, &s.p1);
    assert_eq!(balance(&s, &s.p1), b1 + STAKE);
    assert_eq!(balance(&s, &s.p2), b2 + STAKE);
}

// ── #2063 ──────────────────────────────────────────────────────────────────

#[test]
fn insufficient_balance_blocks_finalize_without_moving_funds() {
    let s = setup();
    let id = ready_to_finalize(&s, Winner::Draw);
    // Drain part of the escrow behind the contract's back.
    sac(&s).clawback(&s.contract, &(STAKE / 2));
    assert_eq!(s.client.payout_shortfall(&id), STAKE / 2);

    let (b1, b2) = (balance(&s, &s.p1), balance(&s, &s.p2));
    assert_eq!(
        s.client.try_finalize_result(&id, &s.p1),
        Err(Ok(Error::InsufficientReserve))
    );
    // No transition and no partial transfer.
    assert_eq!(s.client.get_match(&id).state, MatchState::PendingResult);
    assert_eq!((balance(&s, &s.p1), balance(&s, &s.p2)), (b1, b2));

    // Topping up clears the shortfall and the payout goes through.
    sac(&s).mint(&s.contract, &(STAKE / 2));
    assert_eq!(s.client.payout_shortfall(&id), 0);
    s.client.finalize_result(&id, &s.p1);
    assert_eq!(s.client.get_match(&id).state, MatchState::Completed);
}

// ── #2066 ──────────────────────────────────────────────────────────────────

#[test]
fn failed_payout_keeps_funds_in_escrow_and_can_be_retried() {
    let s = setup();
    let id = ready_to_finalize(&s, Winner::Player1);
    let escrow_before = balance(&s, &s.contract);

    // The winner can't receive the token right now (e.g. a frozen trustline).
    sac(&s).set_authorized(&s.p1, &false);
    s.client.finalize_result(&id, &s.p2);
    let (topics, _) = last_event(&s);
    assert_eq!(
        topics,
        (Symbol::new(&s.env, "payout"), symbol_short!("failed")).into_val(&s.env)
    );

    assert_eq!(s.client.get_match(&id).state, MatchState::PayoutFailed);
    assert_eq!(balance(&s, &s.contract), escrow_before);
    let rec = s.client.get_payout_record(&id).unwrap();
    assert_eq!((rec.attempts, rec.player1_paid, rec.player1_amount), (1, false, 2 * STAKE));
    let failed_at = rec.first_failed_at;
    assert!(failed_at > 0);

    // A retry while the problem persists is logged and changes nothing else.
    s.env.ledger().with_mut(|l| l.timestamp += 60);
    assert!(!s.client.retry_payout(&id));
    let rec = s.client.get_payout_record(&id).unwrap();
    assert_eq!((rec.attempts, rec.first_failed_at), (2, failed_at));
    assert_eq!(rec.last_attempt_at, failed_at + 60);
    assert_eq!(balance(&s, &s.contract), escrow_before);

    // Once the winner can receive again, anyone's retry completes it.
    sac(&s).set_authorized(&s.p1, &true);
    let before = balance(&s, &s.p1);
    assert!(s.client.retry_payout(&id));
    assert_eq!(balance(&s, &s.p1), before + 2 * STAKE);
    assert_eq!(s.client.get_match(&id).state, MatchState::Completed);
    assert_eq!(s.client.get_payout_record(&id), None);
    assert_eq!(s.client.try_retry_payout(&id), Err(Ok(Error::NoFailedPayout)));
}

#[test]
fn draw_retry_pays_only_the_unpaid_player() {
    let s = setup();
    let id = ready_to_finalize(&s, Winner::Draw);
    sac(&s).set_authorized(&s.p2, &false);
    let (b1, b2) = (balance(&s, &s.p1), balance(&s, &s.p2));

    s.client.finalize_result(&id, &s.p1);
    let rec = s.client.get_payout_record(&id).unwrap();
    assert_eq!((rec.player1_paid, rec.player2_paid), (true, false));
    assert_eq!(balance(&s, &s.p1), b1 + STAKE);

    sac(&s).set_authorized(&s.p2, &true);
    assert!(s.client.retry_payout(&id));
    // player1 is not paid twice.
    assert_eq!(balance(&s, &s.p1), b1 + STAKE);
    assert_eq!(balance(&s, &s.p2), b2 + STAKE);
}

#[test]
fn retry_requires_a_failed_payout() {
    let s = setup();
    let id = ready_to_finalize(&s, Winner::Player1);
    assert_eq!(s.client.try_retry_payout(&id), Err(Ok(Error::NoFailedPayout)));
}
