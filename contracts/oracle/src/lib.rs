#![no_std]

mod errors;
mod types;

use errors::Error;
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, String, Symbol};
use types::{DataKey, MatchResult, ResultEntry};

/// ~30 days at 5s/ledger.
const MATCH_TTL_LEDGERS: u32 = 518_400;

/// Maximum allowed byte length for a game_id string.
const MAX_GAME_ID_LEN: u32 = 64;

#[contract]
pub struct OracleContract;

#[contractimpl]
impl OracleContract {
    /// Initialize with a trusted admin (the off-chain oracle service).
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.events()
            .publish((Symbol::new(&env, "oracle"), symbol_short!("init")), admin);
        Ok(())
    }

    /// Admin submits a verified match result on-chain.
    pub fn submit_result(
        env: Env,
        match_id: u64,
        game_id: String,
        result: MatchResult,
    ) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();

        let game_id_len = game_id.len();
        if game_id_len == 0 || game_id_len > MAX_GAME_ID_LEN {
            return Err(Error::InvalidGameId);
        }

        if env.storage().persistent().has(&DataKey::Result(match_id)) {
            return Err(Error::AlreadySubmitted);
        }

        env.storage().persistent().set(
            &DataKey::Result(match_id),
            &ResultEntry {
                game_id,
                result: result.clone(),
            },
        );
        env.storage().persistent().extend_ttl(
            &DataKey::Result(match_id),
            MATCH_TTL_LEDGERS,
            MATCH_TTL_LEDGERS,
        );

        let timestamp = env.ledger().timestamp();
        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("result")),
            (match_id, result, timestamp),
        );

        Ok(())
    }

    /// Retrieve the stored result for a match.
    pub fn get_result(env: Env, match_id: u64) -> Result<ResultEntry, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Result(match_id))
            .ok_or(Error::ResultNotFound)
    }

    /// Check whether a result has been submitted for a match.
    pub fn has_result(env: Env, match_id: u64) -> bool {
        env.storage().persistent().has(&DataKey::Result(match_id))
    }

    /// Admin deletes a mis-submitted result before the escrow contract processes it.
    pub fn delete_result(env: Env, match_id: u64, caller: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;

        if caller != admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        if !env.storage().persistent().has(&DataKey::Result(match_id)) {
            return Err(Error::ResultNotFound);
        }

        env.storage().persistent().remove(&DataKey::Result(match_id));

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("res_del")),
            (match_id, caller),
        );

        Ok(())
    }

    /// Transfer admin rights to a new address. Requires current admin auth.
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &new_admin);

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("adm_xfer")),
            (admin, new_admin),
        );

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{storage::Persistent as _, Address as _, Events},
        vec, Address, Env, IntoVal, String, Symbol,
    };

    fn setup() -> (Env, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        (env, contract_id)
    }

    #[test]
    fn test_submit_and_get_result() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        assert!(!client.has_result(&0u64));

        client.submit_result(
            &0u64,
            &String::from_str(&env, "abc123"),
            &MatchResult::Player1Wins,
        );

        assert!(client.has_result(&0u64));
        assert_eq!(client.get_result(&0u64).result, MatchResult::Player1Wins);

        // TTL must be extended
        let ttl = env.as_contract(&contract_id, || {
            env.storage().persistent().get_ttl(&DataKey::Result(0u64))
        });
        assert_eq!(ttl, crate::MATCH_TTL_LEDGERS);
    }

    #[test]
    fn test_get_result_not_found() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        assert!(matches!(
            client.try_get_result(&999u64),
            Err(Ok(Error::ResultNotFound))
        ));
    }

    #[test]
    fn test_submit_result_empty_game_id_fails() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        assert_eq!(
            client.try_submit_result(
                &0u64,
                &String::from_str(&env, ""),
                &MatchResult::Player1Wins,
            ),
            Err(Ok(Error::InvalidGameId))
        );
    }

    #[test]
    fn test_non_admin_cannot_submit_result() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        env.mock_auths(&[MockAuth {
            address: &non_admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "submit_result",
                args: (
                    0u64,
                    String::from_str(&env, "game"),
                    MatchResult::Player1Wins,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);

        assert!(client
            .try_submit_result(
                &0u64,
                &String::from_str(&env, "game"),
                &MatchResult::Player1Wins
            )
            .is_err());
    }

    #[test]
    fn test_submit_result_by_non_admin_returns_unauthorized() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        env.mock_auths(&[MockAuth {
            address: &non_admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "submit_result",
                args: (1u64, String::from_str(&env, "game1"), MatchResult::Player1Wins)
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);

        assert!(
            client
                .try_submit_result(&1u64, &String::from_str(&env, "game1"), &MatchResult::Player1Wins)
                .is_err(),
            "non-admin must not be able to submit results"
        );
        assert!(!client.has_result(&1u64), "result must not be stored after rejected submission");
    }

    #[test]
    fn test_double_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        assert_eq!(
            client.try_initialize(&admin),
            Err(Ok(Error::AlreadyInitialized))
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_duplicate_submit_fails() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        client.submit_result(&0u64, &String::from_str(&env, "abc123"), &MatchResult::Draw);
        client.submit_result(&0u64, &String::from_str(&env, "abc123"), &MatchResult::Draw);
    }

    #[test]
    fn test_has_result_false_for_non_existent() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        assert!(!client.has_result(&999u64));
    }

    #[test]
    fn test_transfer_admin_success() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        let new_admin = Address::generate(&env);
        client.transfer_admin(&new_admin);

        // new admin can now submit a result; old admin cannot drive auth
        client.submit_result(
            &1u64,
            &String::from_str(&env, "game1"),
            &MatchResult::Player2Wins,
        );
        assert_eq!(client.get_result(&1u64).result, MatchResult::Player2Wins);
    }

    #[test]
    fn test_transfer_admin_emits_event() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        let new_admin = Address::generate(&env);
        client.transfer_admin(&new_admin);

        let events = env.events().all();
        let topics = vec![
            &env,
            Symbol::new(&env, "oracle").into_val(&env),
            soroban_sdk::symbol_short!("adm_xfer").into_val(&env),
        ];
        assert!(events.iter().any(|(_, t, _)| t == topics));
    }

    #[test]
    fn test_delete_result_authorized() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        client.submit_result(&42u64, &String::from_str(&env, "game42"), &MatchResult::Draw);
        assert!(client.has_result(&42u64));

        client.delete_result(&42u64, &admin);

        // Capture events immediately — env.events().all() returns events from
        // the most recent invocation, so this must come before the next client call.
        let events = env.events().all();
        let topics = vec![
            &env,
            Symbol::new(&env, "oracle").into_val(&env),
            soroban_sdk::symbol_short!("res_del").into_val(&env),
        ];
        assert!(events.iter().any(|(_, t, _)| t == topics));

        assert!(!client.has_result(&42u64));
    }

    #[test]
    fn test_delete_result_unauthorized() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        env.mock_all_auths();
        client.initialize(&admin);
        client.submit_result(&10u64, &String::from_str(&env, "game10"), &MatchResult::Player1Wins);

        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        env.mock_auths(&[MockAuth {
            address: &non_admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "delete_result",
                args: (10u64, non_admin.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);

        assert_eq!(
            client.try_delete_result(&10u64, &non_admin),
            Err(Ok(Error::Unauthorized))
        );
        assert!(client.has_result(&10u64));
    }

    #[test]
    fn test_delete_result_not_found() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        assert_eq!(
            client.try_delete_result(&999u64, &admin),
            Err(Ok(Error::ResultNotFound))
        );
    }

    #[test]
    fn test_non_admin_cannot_transfer_admin() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let new_admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        env.mock_auths(&[MockAuth {
            address: &non_admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "transfer_admin",
                args: (new_admin.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);

        assert!(client.try_transfer_admin(&new_admin).is_err());
    }

    #[test]
    fn test_initialize_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        let events = env.events().all();
        let topics = vec![
            &env,
            Symbol::new(&env, "oracle").into_val(&env),
            soroban_sdk::symbol_short!("init").into_val(&env),
        ];
        let matched = events.iter().find(|(_, t, _)| *t == topics);
        assert!(matched.is_some());
    }

    /// Verifies that `submit_result` emits an event with the correct topics
    /// `(Symbol("oracle"), Symbol("result"))` and payload `(match_id, result, timestamp)`
    /// for every possible `MatchResult` variant.
    #[test]
    fn test_oracle_submit_result_emits_event() {
        let cases: &[(u64, MatchResult)] = &[
            (1u64, MatchResult::Player1Wins),
            (2u64, MatchResult::Player2Wins),
            (3u64, MatchResult::Draw),
        ];

        for (match_id, expected_result) in cases {
            let env = Env::default();
            env.mock_all_auths();
            let admin = Address::generate(&env);
            let contract_id = env.register(OracleContract, ());
            let client = OracleContractClient::new(&env, &contract_id);
            client.initialize(&admin);

            client.submit_result(
                match_id,
                &String::from_str(&env, "game_abc"),
                expected_result,
            );

            let expected_topics = vec![
                &env,
                Symbol::new(&env, "oracle").into_val(&env),
                soroban_sdk::symbol_short!("result").into_val(&env),
            ];

            let timestamp = env.ledger().timestamp();

            let events = env.events().all();
            let matched = events
                .iter()
                .find(|(_, topics, _)| *topics == expected_topics);

            assert!(
                matched.is_some(),
                "No result event emitted for variant {expected_result:?}",
            );

            let (_, _, actual_data) = matched.unwrap();
            let (ev_match_id, ev_result, ev_timestamp): (u64, MatchResult, u64) =
                soroban_sdk::TryFromVal::try_from_val(&env, &actual_data).unwrap();
            assert_eq!(
                ev_match_id, *match_id,
                "match_id mismatch for variant {expected_result:?}",
            );
            assert_eq!(
                &ev_result, expected_result,
                "result mismatch for variant {expected_result:?}",
            );
            assert_eq!(
                ev_timestamp, timestamp,
                "timestamp mismatch for variant {expected_result:?}",
            );
        }
    }
}
