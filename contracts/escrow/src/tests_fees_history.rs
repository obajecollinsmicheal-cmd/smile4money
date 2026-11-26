//! Tests for #2064 (double deposits), #2067 (payout fees), #2068 (payout
//! history) and #2069 (partial payouts).

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Env, String,
};

const STAKE: i128 = 1_000;
const DISPUTE_WINDOW: u32 = 10;

struct Setup {
    env: Env,
    client: EscrowContractClient<'static>,
    admin: Address,
    oracle: Address,
    token: Address,
    collector: Address,
    p1: Address,
    p2: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let safe = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin.clone()).address();
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
    sac.mint(&contract, &ESCROW_RESERVE_BUFFER_STROOPS);
    let collector = Address::generate(&env);
    Setup { env, client, admin, oracle, token, collector, p1, p2 }
}

fn balance(s: &Setup, who: &Address) -> i128 {
    TokenClient::new(&s.env, &s.token).balance(who)
}

fn game(s: &Setup, n: u32) -> String {
    let ids = ["fee00001", "fee00002", "fee00003", "fee00004"];
    String::from_str(&s.env, ids[n as usize])
}

/// Create, fund and report a result; returns the id, ready to finalize.
fn ready(s: &Setup, n: u32, winner: Winner) -> u64 {
    let id = s.client.create_match(&s.p1, &s.p2, &STAKE, &None, &game(s, n), &Platform::Lichess);
    s.client.deposit(&id, &s.p1);
    s.client.deposit(&id, &s.p2);
    s.client.submit_result(&id, &game(s, n), &winner, &s.oracle);
    s.env.ledger().with_mut(|l| {
        l.sequence_number += DISPUTE_WINDOW + 1;
        l.timestamp += 3_600;
    });
    id
}

fn set_fee(s: &Setup, fee: i128, policy: FeePolicy) {
    s.client.set_fee_config(&s.admin, &fee, &policy, &s.collector);
}

// ── #2064 ──────────────────────────────────────────────────────────────────

#[test]
fn second_deposit_from_the_same_player_is_rejected() {
    let s = setup();
    let id = s.client.create_match(&s.p1, &s.p2, &STAKE, &None, &game(&s, 0), &Platform::Lichess);
    s.client.deposit(&id, &s.p1);
    let after_first = balance(&s, &s.p1);

    assert_eq!(s.client.try_deposit(&id, &s.p1), Err(Ok(Error::AlreadyFunded)));
    assert_eq!(balance(&s, &s.p1), after_first);
    let m = s.client.get_match(&id);
    assert!(m.player1_deposited && !m.player2_deposited);

    // Player 2 can still deposit once, and not twice.
    s.client.deposit(&id, &s.p2);
    assert_eq!(s.client.try_deposit(&id, &s.p2), Err(Ok(Error::AlreadyFunded)));
    assert_eq!(s.client.try_deposit(&id, &s.p1), Err(Ok(Error::AlreadyFunded)));
    assert_eq!(s.client.get_match(&id).state, MatchState::Active);
}

// ── #2067 ──────────────────────────────────────────────────────────────────

#[test]
fn default_is_no_fee() {
    let s = setup();
    assert_eq!(s.client.get_fee_config().fee_per_payout, 0);
    let id = ready(&s, 0, Winner::Player1);
    let before = balance(&s, &s.p1);
    s.client.finalize_result(&id, &s.p1);
    assert_eq!(balance(&s, &s.p1), before + 2 * STAKE);
}

#[test]
fn each_policy_deducts_the_right_share() {
    for (policy, player_share) in [
        (FeePolicy::PlatformCovers, 0),
        (FeePolicy::PlayerCovers, 30),
        (FeePolicy::Split, 15),
    ] {
        let s = setup();
        set_fee(&s, 30, policy);
        let id = ready(&s, 0, Winner::Player2);
        assert_eq!(
            s.client.quote_payout(&id),
            soroban_sdk::vec![&s.env, 0, 0, 0, 2 * STAKE, player_share, 2 * STAKE - player_share]
        );
        let before = balance(&s, &s.p2);
        s.client.finalize_result(&id, &s.p1);
        assert_eq!(balance(&s, &s.p2), before + 2 * STAKE - player_share, "{policy:?}");
        assert_eq!(balance(&s, &s.collector), player_share, "{policy:?}");
    }
}

#[test]
fn draw_charges_each_payout() {
    let s = setup();
    set_fee(&s, 10, FeePolicy::PlayerCovers);
    let id = ready(&s, 0, Winner::Draw);
    let (b1, b2) = (balance(&s, &s.p1), balance(&s, &s.p2));
    s.client.finalize_result(&id, &s.p1);
    assert_eq!(balance(&s, &s.p1), b1 + STAKE - 10);
    assert_eq!(balance(&s, &s.p2), b2 + STAKE - 10);
    assert_eq!(balance(&s, &s.collector), 20);
}

#[test]
fn only_admins_can_set_fees_and_fees_must_be_valid() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.client.try_set_fee_config(&stranger, &10, &FeePolicy::PlayerCovers, &s.collector),
        Err(Ok(Error::Unauthorized))
    );
    for fee in [-1, MAX_STAKE + 1] {
        assert_eq!(
            s.client.try_set_fee_config(&s.admin, &fee, &FeePolicy::PlayerCovers, &s.collector),
            Err(Ok(Error::InvalidAmount))
        );
    }
    let ops = Address::generate(&s.env);
    s.client.assign_role(&s.admin, &ops, &AdminRole::Secondary);
    s.client.set_fee_config(&ops, &7, &FeePolicy::Split, &s.collector);
    assert_eq!(s.client.get_fee_config().fee_per_payout, 7);
}

// ── #2069 ──────────────────────────────────────────────────────────────────

#[test]
fn fee_larger_than_the_payout_pays_what_is_left_and_tracks_the_shortfall() {
    let s = setup();
    set_fee(&s, 1_200, FeePolicy::PlayerCovers);
    let id = ready(&s, 0, Winner::Draw);
    let (b1, b2) = (balance(&s, &s.p1), balance(&s, &s.p2));
    s.client.finalize_result(&id, &s.p1);

    // Each draw payout is 1 000; the 1 200 fee can only take what's there.
    assert_eq!((balance(&s, &s.p1), balance(&s, &s.p2)), (b1, b2));
    assert_eq!(balance(&s, &s.collector), 2 * STAKE);
    assert_eq!(s.client.get_match(&id).state, MatchState::Completed);
    assert_eq!(s.client.get_total_shortfall(), 2 * STAKE);
}

#[test]
fn shortfalls_accumulate_across_matches() {
    let s = setup();
    set_fee(&s, 40, FeePolicy::PlayerCovers);
    let a = ready(&s, 0, Winner::Player1);
    s.client.finalize_result(&a, &s.p1);
    let b = ready(&s, 1, Winner::Draw);
    s.client.finalize_result(&b, &s.p1);
    assert_eq!(s.client.get_total_shortfall(), 40 + 40 + 40);
}

#[test]
fn no_shortfall_without_fees() {
    let s = setup();
    let id = ready(&s, 0, Winner::Player1);
    s.client.finalize_result(&id, &s.p1);
    assert_eq!(s.client.get_total_shortfall(), 0);
}

// ── #2068 ──────────────────────────────────────────────────────────────────

#[test]
fn payouts_are_recorded_per_address() {
    let s = setup();
    set_fee(&s, 10, FeePolicy::PlayerCovers);
    let a = ready(&s, 0, Winner::Player1);
    s.client.finalize_result(&a, &s.p1);
    let ts_a = s.env.ledger().timestamp();
    let ledger_a = s.env.ledger().sequence();
    let b = ready(&s, 1, Winner::Draw);
    s.client.finalize_result(&b, &s.p1);

    assert_eq!(s.client.get_payout_history_len(&s.p1), 2);
    let h = s.client.get_payout_history(&s.p1, &0, &10);
    assert_eq!(
        h.get(0).unwrap(),
        PayoutEntry {
            match_id: a,
            gross: 2 * STAKE,
            fee: 10,
            net: 2 * STAKE - 10,
            timestamp: ts_a,
            ledger: ledger_a,
        }
    );
    let second = h.get(1).unwrap();
    assert_eq!((second.match_id, second.gross, second.net), (b, STAKE, STAKE - 10));

    // The loser of match A only has the draw payout.
    let h2 = s.client.get_payout_history(&s.p2, &0, &10);
    assert_eq!(h2.len(), 1);
    assert_eq!(h2.get(0).unwrap().match_id, b);
}

#[test]
fn history_pages_and_ignores_out_of_range_requests() {
    let s = setup();
    for n in 0..3 {
        let id = ready(&s, n, Winner::Player1);
        s.client.finalize_result(&id, &s.p1);
    }
    let page = s.client.get_payout_history(&s.p1, &1, &1);
    assert_eq!(page.len(), 1);
    assert_eq!(page.get(0).unwrap().match_id, 1);
    assert_eq!(s.client.get_payout_history(&s.p1, &5, &10).len(), 0);
    assert_eq!(s.client.get_payout_history(&s.p1, &0, &1_000).len(), 3);
    assert_eq!(s.client.get_payout_history_len(&Address::generate(&s.env)), 0);
}
