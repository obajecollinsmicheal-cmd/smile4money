//! Tests for #2058 (distinct players), #2059 (admin stake limits),
//! #2060 (deposit order and timestamps) and #2062 (game ID formats).

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Env, String,
};

struct Setup {
    env: Env,
    client: EscrowContractClient<'static>,
    admin: Address,
    p1: Address,
    p2: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let safe = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&oracle, &admin, &token, &safe, &None, &None);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let sac = StellarAssetClient::new(&env, &token);
    sac.mint(&p1, &1_000_000_000);
    sac.mint(&p2, &1_000_000_000);
    let tok = soroban_sdk::token::Client::new(&env, &token);
    tok.approve(&p1, &contract_id, &1_000_000_000, &1_000);
    tok.approve(&p2, &contract_id, &1_000_000_000, &1_000);
    Setup {
        env,
        client,
        admin,
        p1,
        p2,
    }
}

fn lichess(env: &Env, id: &str) -> String {
    String::from_str(env, id)
}

// ── #2058 ──────────────────────────────────────────────────────────────────

#[test]
fn rejects_self_match() {
    let s = setup();
    let r = s.client.try_create_match(
        &s.p1,
        &s.p1,
        &100,
        &None,
        &lichess(&s.env, "abcd1234"),
        &Platform::Lichess,
    );
    assert_eq!(r, Err(Ok(Error::InvalidPlayers)));
}

// ── #2059 ──────────────────────────────────────────────────────────────────

#[test]
fn default_limits_are_the_constants() {
    let s = setup();
    assert_eq!(
        s.client.get_stake_limits(),
        StakeLimits {
            min: MIN_STAKE,
            max: MAX_STAKE
        }
    );
}

#[test]
fn admin_limits_are_enforced_at_creation() {
    let s = setup();
    s.client
        .set_stake_limits(&s.admin, &10_000_000, &50_000_000);
    let id = |n: &str| lichess(&s.env, n);

    assert_eq!(
        s.client.try_create_match(
            &s.p1,
            &s.p2,
            &9_999_999,
            &None,
            &id("aaaa0001"),
            &Platform::Lichess
        ),
        Err(Ok(Error::StakeTooLow))
    );
    assert_eq!(
        s.client.try_create_match(
            &s.p1,
            &s.p2,
            &50_000_001,
            &None,
            &id("aaaa0002"),
            &Platform::Lichess
        ),
        Err(Ok(Error::StakeTooHigh))
    );
    // Both bounds are inclusive.
    s.client.create_match(
        &s.p1,
        &s.p2,
        &10_000_000,
        &None,
        &id("aaaa0003"),
        &Platform::Lichess,
    );
    s.client.create_match(
        &s.p1,
        &s.p2,
        &50_000_000,
        &None,
        &id("aaaa0004"),
        &Platform::Lichess,
    );
}

#[test]
fn secondary_admin_can_set_limits_but_others_cannot() {
    let s = setup();
    let secondary = Address::generate(&s.env);
    let stranger = Address::generate(&s.env);
    s.client
        .assign_role(&s.admin, &secondary, &AdminRole::Secondary);

    s.client.set_stake_limits(&secondary, &5, &500);
    assert_eq!(
        s.client.get_stake_limits(),
        StakeLimits { min: 5, max: 500 }
    );

    assert_eq!(
        s.client.try_set_stake_limits(&stranger, &1, &2),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        s.client.get_stake_limits(),
        StakeLimits { min: 5, max: 500 }
    );
}

#[test]
fn rejects_invalid_limits() {
    let s = setup();
    for (min, max) in [(0, 10), (-1, 10), (11, 10), (1, MAX_STAKE + 1)] {
        assert_eq!(
            s.client.try_set_stake_limits(&s.admin, &min, &max),
            Err(Ok(Error::InvalidStakeLimits)),
            "min={min} max={max}"
        );
    }
}

// ── #2060 ──────────────────────────────────────────────────────────────────

fn deposit_in_order(first_is_p2: bool) {
    let s = setup();
    let id = s.client.create_match(
        &s.p1,
        &s.p2,
        &100,
        &None,
        &lichess(&s.env, "ord12345"),
        &Platform::Lichess,
    );
    let (first, second) = if first_is_p2 {
        (&s.p2, &s.p1)
    } else {
        (&s.p1, &s.p2)
    };

    s.env.ledger().with_mut(|l| l.timestamp = 1_000);
    s.client.deposit(&id, first);
    let m = s.client.get_match(&id);
    assert_eq!(m.first_depositor, Some(first.clone()));
    assert_eq!(m.state, MatchState::Pending);

    // The second deposit arrives later.
    s.env.ledger().with_mut(|l| l.timestamp = 1_450);
    s.client.deposit(&id, second);
    let m = s.client.get_match(&id);
    assert_eq!(m.first_depositor, Some(first.clone()));
    assert_eq!(m.state, MatchState::Active);
    let (t1, t2) = if first_is_p2 {
        (1_450, 1_000)
    } else {
        (1_000, 1_450)
    };
    assert_eq!(m.player1_deposited_at, Some(t1));
    assert_eq!(m.player2_deposited_at, Some(t2));
}

#[test]
fn records_deposit_timestamps_player1_first() {
    deposit_in_order(false);
}

#[test]
fn records_deposit_timestamps_player2_first() {
    deposit_in_order(true);
}

#[test]
fn new_match_has_no_deposit_times() {
    let s = setup();
    let id = s.client.create_match(
        &s.p1,
        &s.p2,
        &100,
        &None,
        &lichess(&s.env, "new12345"),
        &Platform::Lichess,
    );
    let m = s.client.get_match(&id);
    assert_eq!(
        (
            m.player1_deposited_at,
            m.player2_deposited_at,
            m.first_depositor
        ),
        (None, None, None)
    );
}

// ── #2062 ──────────────────────────────────────────────────────────────────

fn create(s: &Setup, id: &str, platform: Platform) -> Result<u64, Error> {
    match s.client.try_create_match(
        &s.p1,
        &s.p2,
        &100,
        &None,
        &String::from_str(&s.env, id),
        &platform,
    ) {
        Ok(Ok(id)) => Ok(id),
        Err(Ok(e)) => Err(e),
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn accepts_well_formed_ids() {
    let s = setup();
    assert!(create(&s, "q7ZvsdUF", Platform::Lichess).is_ok());
    assert!(create(&s, "ABCDEFGH", Platform::Lichess).is_ok());
    assert!(create(&s, "98765432101", Platform::ChessDotCom).is_ok());
    assert!(create(&s, "1", Platform::ChessDotCom).is_ok());
    assert!(create(&s, "12345678901234567890", Platform::ChessDotCom).is_ok());
}

#[test]
fn rejects_malformed_lichess_ids() {
    let s = setup();
    for id in [
        "q7Zvsd",
        "q7ZvsdUFx",
        "q7Zvsd_F",
        "q7Zvsd-F",
        "q7ZvsdUFab12",
    ] {
        assert_eq!(
            create(&s, id, Platform::Lichess),
            Err(Error::InvalidGameIdFormat),
            "{id}"
        );
    }
}

#[test]
fn rejects_malformed_chesscom_ids() {
    let s = setup();
    for id in [
        "abc123",
        "0123456",
        "123456789012345678901",
        "123-456",
        "q7ZvsdUF",
    ] {
        assert_eq!(
            create(&s, id, Platform::ChessDotCom),
            Err(Error::InvalidGameIdFormat),
            "{id}"
        );
    }
}

#[test]
fn generic_checks_still_come_first() {
    let s = setup();
    // Empty and non-ASCII IDs keep their existing InvalidGameId error.
    assert_eq!(create(&s, "", Platform::Lichess), Err(Error::InvalidGameId));
    assert_eq!(
        create(&s, "abc d123", Platform::Lichess),
        Err(Error::InvalidGameId)
    );
}

#[test]
fn rejects_zero_address_player() {
    let s = setup();
    let zero = Address::from_str(&s.env, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
    let r = s.client.try_create_match(
        &s.p1,
        &zero,
        &100,
        &None,
        &lichess(&s.env, "zero1234"),
        &Platform::Lichess,
    );
    assert_eq!(r, Err(Ok(Error::InvalidAddress)));
}
