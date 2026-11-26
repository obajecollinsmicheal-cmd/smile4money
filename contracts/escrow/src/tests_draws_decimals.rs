//! Tests for #2072 (token decimals), #2073 (draw results), #2075 (outcome
//! statistics) and #2076 (draw dispute window).

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    BytesN, Env, IntoVal, String,
};

const STAKE: i128 = 1_000;
const WINDOW: u32 = 10;

/// A minimal SEP-41 token whose `decimals()` can be changed, to exercise
/// payouts when a token's precision differs from match creation.
#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn set_decimals(env: Env, d: u32) {
        env.storage().instance().set(&symbol_short!("dec"), &d);
    }
    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&symbol_short!("dec")).unwrap_or(7)
    }
    pub fn name(env: Env) -> String {
        String::from_str(&env, "Mock")
    }
    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "MCK")
    }
    pub fn mint(env: Env, to: Address, amount: i128) {
        let b = Self::balance(env.clone(), to.clone());
        env.storage().persistent().set(&to, &(b + amount));
    }
    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().persistent().get(&id).unwrap_or(0)
    }
    pub fn allowance(_env: Env, _from: Address, _spender: Address) -> i128 {
        i128::MAX
    }
    pub fn approve(_env: Env, _from: Address, _spender: Address, _amount: i128, _exp: u32) {}
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let fb = Self::balance(env.clone(), from.clone());
        assert!(fb >= amount, "insufficient balance");
        env.storage().persistent().set(&from, &(fb - amount));
        let tb = Self::balance(env.clone(), to.clone());
        env.storage().persistent().set(&to, &(tb + amount));
    }
}

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

fn setup_with(token_kind: &str) -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let safe = Address::generate(&env);
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let contract = env.register(EscrowContract, ());
    let token = if token_kind == "mock" {
        let t = env.register(MockToken, ());
        let m = MockTokenClient::new(&env, &t);
        for p in [&p1, &p2] {
            m.mint(p, &1_000_000_000_000);
        }
        m.mint(&contract, &ESCROW_RESERVE_BUFFER_STROOPS);
        t
    } else {
        let t = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let sac = StellarAssetClient::new(&env, &t);
        let tok = TokenClient::new(&env, &t);
        for p in [&p1, &p2] {
            sac.mint(p, &1_000_000);
            tok.approve(p, &contract, &1_000_000, &1_000);
        }
        sac.mint(&contract, &ESCROW_RESERVE_BUFFER_STROOPS);
        t
    };
    let client = EscrowContractClient::new(&env, &contract);
    client.initialize(&oracle, &admin, &token, &safe, &Some(WINDOW), &None);
    Setup { env, client, contract, admin, oracle, token, p1, p2 }
}

fn setup() -> Setup {
    setup_with("sac")
}

fn balance(s: &Setup, who: &Address) -> i128 {
    TokenClient::new(&s.env, &s.token).balance(who)
}

const IDS: [&str; 4] = ["drw00001", "drw00002", "drw00003", "drw00004"];

/// Create, fund and report `winner`; returns the id (result pending).
fn reported(s: &Setup, n: usize, winner: Winner) -> u64 {
    let g = String::from_str(&s.env, IDS[n]);
    let id = s.client.create_match(&s.p1, &s.p2, &STAKE, &None, &g, &Platform::Lichess);
    s.client.deposit(&id, &s.p1);
    s.client.deposit(&id, &s.p2);
    s.client.submit_result(&id, &g, &winner, &s.oracle);
    id
}

fn advance(s: &Setup, ledgers: u32) {
    s.env.ledger().with_mut(|l| {
        l.sequence_number += ledgers;
        l.timestamp += ledgers as u64 * 5;
    });
}

fn evidence(s: &Setup) -> BytesN<32> {
    BytesN::from_array(&s.env, &[7u8; 32])
}

// ── #2073 ──────────────────────────────────────────────────────────────────

#[test]
fn oracle_draw_refunds_both_players_equally_and_completes() {
    let s = setup();
    let id = reported(&s, 0, Winner::Draw);
    let (b1, b2) = (balance(&s, &s.p1), balance(&s, &s.p2));
    advance(&s, WINDOW + 1);
    s.client.finalize_result(&id, &s.p1);
    // Read the events before any other call replaces them.
    let (_, topics, data) = s.env.events().all().last().unwrap();
    assert_eq!(topics, (symbol_short!("match"), symbol_short!("draw")).into_val(&s.env));
    let data: (u64, i128, i128, u64) = data.into_val(&s.env);
    assert_eq!(data, (id, STAKE, STAKE, 1));

    assert_eq!(balance(&s, &s.p1) - b1, STAKE);
    assert_eq!(balance(&s, &s.p2) - b2, STAKE);
    assert_eq!(s.client.get_match(&id).state, MatchState::Completed);
}

#[test]
fn a_win_is_logged_under_its_own_event() {
    let s = setup();
    let id = reported(&s, 0, Winner::Player2);
    advance(&s, WINDOW + 1);
    s.client.finalize_result(&id, &s.p1);
    let (_, topics, _) = s.env.events().all().last().unwrap();
    assert_eq!(
        topics,
        (symbol_short!("match"), symbol_short!("win"), s.p2.clone()).into_val(&s.env)
    );
}

// ── #2075 ──────────────────────────────────────────────────────────────────

#[test]
fn outcome_counters_track_wins_and_draws() {
    let s = setup();
    assert_eq!(s.client.get_outcome_stats(), OutcomeStats::default());
    let ids = [
        reported(&s, 0, Winner::Player1),
        reported(&s, 1, Winner::Draw),
        reported(&s, 2, Winner::Player2),
        reported(&s, 3, Winner::Player1),
    ];
    // Pending results don't count yet.
    assert_eq!(s.client.get_outcome_stats(), OutcomeStats::default());
    advance(&s, WINDOW + 1);
    for id in ids {
        s.client.finalize_result(&id, &s.p1);
    }
    assert_eq!(
        s.client.get_outcome_stats(),
        OutcomeStats { wins: 3, player1_wins: 2, player2_wins: 1, draws: 1 }
    );
}

#[test]
fn failed_payouts_count_once_completed() {
    let s = setup();
    let id = reported(&s, 0, Winner::Draw);
    advance(&s, WINDOW + 1);
    s.client.finalize_result(&id, &s.p1);
    // Re-finalizing or retrying a completed match can't bump the counter.
    assert!(s.client.try_finalize_result(&id, &s.p1).is_err());
    assert!(s.client.try_retry_payout(&id).is_err());
    assert_eq!(s.client.get_outcome_stats().draws, 1);
}

// ── #2076 ──────────────────────────────────────────────────────────────────

#[test]
fn draw_window_is_configurable_and_enforced_for_finalize() {
    let s = setup();
    assert_eq!(s.client.get_draw_dispute_window_ledgers(), WINDOW);
    s.client.set_draw_dispute_window(&s.admin, &720); // ~1 hour
    assert_eq!(s.client.get_draw_dispute_window_ledgers(), 720);

    let draw = reported(&s, 0, Winner::Draw);
    let win = reported(&s, 1, Winner::Player1);
    advance(&s, WINDOW + 1);
    // A win uses the general window; the draw is still challengeable.
    s.client.finalize_result(&win, &s.p1);
    assert_eq!(
        s.client.try_finalize_result(&draw, &s.p1),
        Err(Ok(Error::DisputeWindowActive))
    );
    advance(&s, 720);
    s.client.finalize_result(&draw, &s.p1);
}

#[test]
fn invalid_draw_windows_and_non_admins_are_rejected() {
    let s = setup();
    for bad in [0, LEDGERS_PER_WEEK + 1] {
        assert_eq!(
            s.client.try_set_draw_dispute_window(&s.admin, &bad),
            Err(Ok(Error::InvalidAmount))
        );
    }
    assert_eq!(
        s.client.try_set_draw_dispute_window(&s.p1, &100),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn either_player_can_dispute_a_draw_with_evidence() {
    for disputer in [0, 1] {
        let s = setup();
        let id = reported(&s, 0, Winner::Draw);
        let who = if disputer == 0 { s.p1.clone() } else { s.p2.clone() };
        let idx = s.client.dispute_draw(&who, &id, &String::from_str(&s.env, "I won on time"), &evidence(&s));
        assert_eq!(idx, 0);
        assert_eq!(s.client.get_match(&id).state, MatchState::Contested);

        // The payout is held while contested.
        advance(&s, WINDOW + 1);
        assert_eq!(s.client.try_finalize_result(&id, &s.p1), Err(Ok(Error::InvalidState)));
    }
}

#[test]
fn draw_disputes_are_limited_to_players_draws_and_the_window() {
    let s = setup();
    let draw = reported(&s, 0, Winner::Draw);
    let win = reported(&s, 1, Winner::Player1);
    let reason = String::from_str(&s.env, "x");
    let stranger = Address::generate(&s.env);

    assert_eq!(
        s.client.try_dispute_draw(&stranger, &draw, &reason, &evidence(&s)),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        s.client.try_dispute_draw(&s.p1, &win, &reason, &evidence(&s)),
        Err(Ok(Error::InvalidState))
    );
    advance(&s, WINDOW + 1);
    assert_eq!(
        s.client.try_dispute_draw(&s.p1, &draw, &reason, &evidence(&s)),
        Err(Ok(Error::DisputeWindowExpired))
    );
    // The generic contest path enforces the same window for draws.
    assert_eq!(
        s.client.try_contest_result(&s.p2, &draw, &reason),
        Err(Ok(Error::DisputeWindowExpired))
    );
}

// ── #2072 ──────────────────────────────────────────────────────────────────

#[test]
fn normalize_amount_converts_exactly() {
    assert_eq!(normalize_amount(1_000, 7, 7), Ok(1_000));
    assert_eq!(normalize_amount(1_000, 6, 7), Ok(10_000)); // USDC(6) -> 7
    assert_eq!(normalize_amount(10_000, 7, 6), Ok(1_000));
    assert_eq!(normalize_amount(1_234, 7, 6), Err(Error::InvalidTokenMetadata));
    assert_eq!(normalize_amount(i128::MAX / 10, 0, 18), Err(Error::Overflow));
}

#[test]
fn match_records_token_decimals_from_the_token() {
    let s = setup_with("mock");
    MockTokenClient::new(&s.env, &s.token).set_decimals(&6);
    let id = reported(&s, 0, Winner::Player1);
    assert_eq!(s.client.get_match(&id).token_decimals, 6);
}

#[test]
fn payout_is_normalized_when_token_precision_changes() {
    let s = setup_with("mock");
    let mock = MockTokenClient::new(&s.env, &s.token);
    mock.set_decimals(&6);
    let id = reported(&s, 0, Winner::Player1); // stake 1 000 at 6 decimals
    mock.set_decimals(&7);
    // The escrow must hold the payout in the new precision.
    mock.mint(&s.contract, &(2 * STAKE * 10));
    let before = balance(&s, &s.p1);
    advance(&s, WINDOW + 1);
    s.client.finalize_result(&id, &s.p1);
    assert_eq!(balance(&s, &s.p1) - before, 2 * STAKE * 10);
}

#[test]
fn lossy_precision_change_blocks_the_payout_without_moving_funds() {
    let s = setup_with("mock");
    let mock = MockTokenClient::new(&s.env, &s.token);
    mock.set_decimals(&7);
    let g = String::from_str(&s.env, IDS[0]);
    let id = s.client.create_match(&s.p1, &s.p2, &1_005, &None, &g, &Platform::Lichess);
    s.client.deposit(&id, &s.p1);
    s.client.deposit(&id, &s.p2);
    s.client.submit_result(&id, &g, &Winner::Draw, &s.oracle);
    mock.set_decimals(&5); // 1 005 at 7 dp isn't representable at 5 dp
    advance(&s, WINDOW + 1);
    let before = (balance(&s, &s.p1), balance(&s, &s.p2));
    assert_eq!(
        s.client.try_finalize_result(&id, &s.p1),
        Err(Ok(Error::InvalidTokenMetadata))
    );
    assert_eq!((balance(&s, &s.p1), balance(&s, &s.p2)), before);
    assert_eq!(s.client.get_match(&id).state, MatchState::PendingResult);
}

#[test]
fn sac_payouts_stay_exact_at_seven_decimals() {
    let s = setup();
    let id = reported(&s, 0, Winner::Player1);
    assert_eq!(s.client.get_match(&id).token_decimals, 7);
    let before = balance(&s, &s.p1);
    advance(&s, WINDOW + 1);
    s.client.finalize_result(&id, &s.p1);
    assert_eq!(balance(&s, &s.p1) - before, 2 * STAKE);
}
