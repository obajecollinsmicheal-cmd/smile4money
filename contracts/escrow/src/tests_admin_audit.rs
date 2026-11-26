//! Tests for #2074 (draw validation), #2077 (oracle rotation), #2078 (admin
//! audit trail) and #2079 (immutable emergency-drain address).

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Env, IntoVal, String,
};

const STAKE: i128 = 1_000;
const WINDOW: u32 = 10;

struct Setup {
    env: Env,
    client: EscrowContractClient<'static>,
    contract: Address,
    admin: Address,
    oracle: Address,
    safe: Address,
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
    let token = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let contract = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract);
    env.ledger().with_mut(|l| {
        l.sequence_number = 100;
        l.timestamp = 1_700_000_000;
    });
    client.initialize(&oracle, &admin, &token, &safe, &Some(WINDOW), &None);
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let sac = StellarAssetClient::new(&env, &token);
    let tok = TokenClient::new(&env, &token);
    for p in [&p1, &p2] {
        sac.mint(p, &1_000_000);
        tok.approve(p, &contract, &1_000_000, &1_000);
    }
    sac.mint(&contract, &ESCROW_RESERVE_BUFFER_STROOPS);
    Setup { env, client, contract, admin, oracle, safe, token, p1, p2 }
}

fn actions(s: &Setup, log: &soroban_sdk::Vec<AdminAuditEntry>) -> soroban_sdk::Vec<Symbol> {
    let mut out = soroban_sdk::Vec::new(&s.env);
    for e in log.iter() {
        out.push_back(e.action);
    }
    out
}

fn balance(s: &Setup, who: &Address) -> i128 {
    TokenClient::new(&s.env, &s.token).balance(who)
}

fn active_match(s: &Setup, game: &str) -> (u64, String) {
    let g = String::from_str(&s.env, game);
    let id = s.client.create_match(&s.p1, &s.p2, &STAKE, &None, &g, &Platform::Lichess);
    s.client.deposit(&id, &s.p1);
    s.client.deposit(&id, &s.p2);
    (id, g)
}

fn advance(s: &Setup, ledgers: u32) {
    s.env.ledger().with_mut(|l| {
        l.sequence_number += ledgers;
        l.timestamp += ledgers as u64 * 5;
    });
}

// ── #2074 ──────────────────────────────────────────────────────────────────

#[test]
fn validate_draw_requires_identical_stake_refunds() {
    assert_eq!(validate_draw(500, 500, 500), Ok(()));
    for (a, b) in [(499, 501), (1_000, 0), (0, 1_000), (600, 600), (499, 499)] {
        assert_eq!(validate_draw(500, a, b), Err(Error::PayoutMismatch), "{a} {b}");
    }
    assert_eq!(validate_draw(0, 0, 0), Err(Error::PayoutMismatch));
    // validate_payout routes draws through it.
    assert_eq!(validate_payout(&Winner::Draw, 500, 600, 400), Err(Error::PayoutMismatch));
}

#[test]
fn draws_pay_both_players_the_same_even_with_fees() {
    for policy in [FeePolicy::PlatformCovers, FeePolicy::PlayerCovers, FeePolicy::Split] {
        let s = setup();
        s.client.set_fee_config(&s.admin, &30, &policy, &Address::generate(&s.env));
        let (id, g) = active_match(&s, "aud00001");
        s.client.submit_result(&id, &g, &Winner::Draw, &s.oracle);
        advance(&s, WINDOW + 1);
        let (b1, b2) = (balance(&s, &s.p1), balance(&s, &s.p2));
        s.client.finalize_result(&id, &s.p1);
        let (d1, d2) = (balance(&s, &s.p1) - b1, balance(&s, &s.p2) - b2);
        assert_eq!(d1, d2, "{policy:?}");
        assert!(d1 <= STAKE, "no winner bonus on a draw");
    }
}

// ── #2077 ──────────────────────────────────────────────────────────────────

#[test]
fn rotated_oracle_takes_effect_immediately_and_the_old_key_is_refused() {
    let s = setup();
    let (id, g) = active_match(&s, "aud00001");
    let new_oracle = Address::generate(&s.env);
    s.client.update_oracle(&s.admin, &new_oracle);

    assert_eq!(
        s.client.try_submit_result(&id, &g, &Winner::Player1, &s.oracle),
        Err(Ok(Error::Unauthorized))
    );
    s.client.submit_result(&id, &g, &Winner::Player1, &new_oracle);
    assert_eq!(s.client.get_match(&id).state, MatchState::PendingResult);
}

#[test]
fn only_admins_rotate_the_oracle_and_it_must_change() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.client.try_update_oracle(&stranger, &stranger),
        Err(Ok(Error::Unauthorized))
    );
    // The oracle itself can't rotate its own key either.
    assert_eq!(
        s.client.try_update_oracle(&s.oracle, &stranger),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        s.client.try_update_oracle(&s.admin, &s.oracle),
        Err(Ok(Error::InvalidAddress))
    );
}

// ── #2078 ──────────────────────────────────────────────────────────────────

#[test]
fn admin_actions_are_recorded_in_order_with_caller_ledger_and_params() {
    let s = setup();
    // initialize is the first entry.
    let first = s.client.get_admin_audit(&0, &1).get(0).unwrap();
    assert_eq!((first.action, first.caller.clone(), first.ledger), (symbol_short!("init"), s.admin.clone(), 100));
    let safe: Address = first.params.get(2).unwrap().into_val(&s.env);
    assert_eq!(safe, s.safe);

    advance(&s, 5);
    let reason = String::from_str(&s.env, "maintenance");
    s.client.pause(&s.admin, &reason);
    let new_oracle = Address::generate(&s.env);
    s.client.update_oracle(&s.admin, &new_oracle);
    s.client.set_stake_limits(&s.admin, &10, &5_000);

    assert_eq!(s.client.get_admin_audit_len(), 4);
    let log = s.client.get_admin_audit(&1, &10);
    assert_eq!(
        actions(&s, &log),
        soroban_sdk::vec![&s.env, symbol_short!("pause"), symbol_short!("oracle"), symbol_short!("stk_lim")]
    );

    let pause = log.get(0).unwrap();
    assert_eq!((pause.caller.clone(), pause.ledger, pause.timestamp), (s.admin.clone(), 105, 1_700_000_025));
    let r: String = pause.params.get(0).unwrap().into_val(&s.env);
    assert_eq!(r, reason);
    let o: Address = log.get(1).unwrap().params.get(0).unwrap().into_val(&s.env);
    assert_eq!(o, new_oracle);
    let (min, max): (i128, i128) = (
        log.get(2).unwrap().params.get(0).unwrap().into_val(&s.env),
        log.get(2).unwrap().params.get(1).unwrap().into_val(&s.env),
    );
    assert_eq!((min, max), (10, 5_000));
}

#[test]
fn secondary_admin_actions_record_the_acting_address() {
    let s = setup();
    let ops = Address::generate(&s.env);
    s.client.assign_role(&s.admin, &ops, &AdminRole::Secondary);
    s.client.pause(&ops, &String::from_str(&s.env, "incident"));
    let last = s.client.get_admin_audit(&2, &1).get(0).unwrap();
    assert_eq!((last.action, last.caller), (symbol_short!("pause"), ops));
}

#[test]
fn rejected_admin_calls_leave_no_entry() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    let _ = s.client.try_pause(&stranger, &String::from_str(&s.env, "x"));
    let _ = s.client.try_set_stake_limits(&s.admin, &0, &0); // invalid: reverts
    assert_eq!(s.client.get_admin_audit_len(), 1); // just initialize
}

#[test]
fn every_admin_entry_point_is_audited() {
    let s = setup();
    let arbiter = Address::generate(&s.env);
    let ops = Address::generate(&s.env);
    let reason = String::from_str(&s.env, "r");
    s.client.set_arbiter(&s.admin, &arbiter);
    s.client.assign_role(&s.admin, &ops, &AdminRole::Secondary);
    s.client.revoke_role(&s.admin, &ops);
    s.client.set_fee_config(&s.admin, &0, &FeePolicy::PlatformCovers, &s.safe);
    s.client.set_draw_dispute_window(&s.admin, &20);
    let (id, g) = active_match(&s, "aud00002");
    s.client.submit_result(&id, &g, &Winner::Player1, &s.oracle);
    s.client.override_result(&id, &Winner::Player2, &s.admin);
    s.client.contest_result(&s.p1, &id, &reason);
    s.client.resolve_dispute(&arbiter, &id, &Winner::Draw);
    s.client.pause(&s.admin, &reason);
    s.client.unpause(&s.admin, &reason);
    let new_admin = Address::generate(&s.env);
    s.client.transfer_admin(&s.admin, &new_admin);

    assert_eq!(
        actions(&s, &s.client.get_admin_audit(&0, &50)),
        soroban_sdk::vec![
            &s.env,
            symbol_short!("init"),
            symbol_short!("arbiter"),
            symbol_short!("role_set"),
            symbol_short!("role_rev"),
            symbol_short!("fee_cfg"),
            symbol_short!("draw_win"),
            symbol_short!("override"),
            symbol_short!("resolve"),
            symbol_short!("pause"),
            symbol_short!("unpause"),
            symbol_short!("adm_xfer"),
        ]
    );
}

// ── #2079 ──────────────────────────────────────────────────────────────────

#[test]
fn safe_address_is_fixed_at_initialization() {
    let s = setup();
    assert_eq!(s.client.get_safe_address(), s.safe);
    // Re-initializing (the only writer) is refused.
    let other = Address::generate(&s.env);
    assert_eq!(
        s.client.try_initialize(&s.oracle, &s.admin, &s.token, &other, &None, &None),
        Err(Ok(Error::AlreadyInitialized))
    );
    // Rotating the admin, roles and the oracle doesn't move it.
    let new_admin = Address::generate(&s.env);
    s.client.update_oracle(&s.admin, &Address::generate(&s.env));
    s.client.transfer_admin(&s.admin, &new_admin);
    assert_eq!(s.client.get_safe_address(), s.safe);
}

#[test]
fn drains_only_ever_pay_the_safe_address() {
    let s = setup();
    let second = Address::generate(&s.env);
    s.client.assign_role(&s.admin, &second, &AdminRole::Emergency);
    s.client.pause(&s.admin, &String::from_str(&s.env, "drain"));
    let held = balance(&s, &s.contract);

    s.client.initiate_drain(&s.admin, &held);
    s.client.confirm_drain(&second);

    assert_eq!(balance(&s, &s.safe), held);
    assert_eq!(balance(&s, &s.contract), 0);
    // Neither signer received anything.
    assert_eq!(balance(&s, &s.admin), 0);
    assert_eq!(balance(&s, &second), 0);
}

#[test]
fn a_compromised_admin_cannot_redirect_a_drain() {
    let s = setup();
    let attacker = Address::generate(&s.env);
    // Even with the admin key, the only knobs are the drain amount and
    // a second signer; the destination is not a parameter.
    s.client.assign_role(&s.admin, &attacker, &AdminRole::Emergency);
    s.client.pause(&s.admin, &String::from_str(&s.env, "x"));
    s.client.initiate_drain(&attacker, &ESCROW_RESERVE_BUFFER_STROOPS);
    s.client.confirm_drain(&s.admin);
    assert_eq!(balance(&s, &attacker), 0);
    assert_eq!(balance(&s, &s.safe), ESCROW_RESERVE_BUFFER_STROOPS);
    // The same signer can't both initiate and confirm.
    s.client.initiate_drain(&s.admin, &1);
    assert_eq!(s.client.try_confirm_drain(&s.admin), Err(Ok(Error::Unauthorized)));
}
