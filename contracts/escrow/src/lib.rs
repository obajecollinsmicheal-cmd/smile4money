#![no_std]

mod errors;
mod types;

use errors::Error;
use smile4money_oracle::OracleContractClient;
use smile4money_oracle::types::MatchResult;
use soroban_sdk::{contract, contractimpl, symbol_short, token, Address, Env, String, Symbol};
use types::{DataKey, Match, MatchState, Platform, Winner};

/// ~30 days at 5s/ledger. Used as both the TTL threshold and the extend-to value.
const MATCH_TTL_LEDGERS: u32 = 518_400;

/// Maximum allowed byte length for a game_id string.
const MAX_GAME_ID_LEN: u32 = 64;

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    fn is_paused(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Initialize the contract with a trusted oracle address, an admin, and a default token.
    /// `oracle` is the off-chain oracle service address (authorized to call submit_result).
    /// `oracle_contract` is the on-chain oracle contract address used to verify results.
    /// Returns `Error::InvalidToken` if the token address is not a valid token contract.
    pub fn initialize(env: Env, oracle: Address, oracle_contract: Address, admin: Address, token: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Oracle) {
            panic!("Contract already initialized");
        }
        // Validate token by calling a read-only method; panics if not a real token contract
        let token_client = token::Client::new(&env, &token);
        let _ = token_client.decimals();
        env.storage().instance().set(&DataKey::Oracle, &oracle);
        env.storage().instance().set(&DataKey::OracleContract, &oracle_contract);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::MatchCount, &0u64);
        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }

    /// Rotate the oracle address — requires the current oracle or admin to authorize.
    pub fn update_oracle(env: Env, new_oracle: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::Oracle, &new_oracle);
        env.events().publish(
            (Symbol::new(&env, "admin"), symbol_short!("oracle")),
            new_oracle,
        );
        Ok(())
    }

    /// Pause the contract — admin only. Blocks create_match, deposit, and submit_result.
    pub fn pause(env: Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events()
            .publish((Symbol::new(&env, "admin"), symbol_short!("paused")), ());
        Ok(())
    }

    /// Unpause the contract — admin only.
    pub fn unpause(env: Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events()
            .publish((Symbol::new(&env, "admin"), symbol_short!("unpaused")), ());
        Ok(())
    }

    /// Create a new match. Both players must call `deposit` before the game starts.
    pub fn create_match(
        env: Env,
        player1: Address,
        player2: Address,
        stake_amount: i128,
        token: Address,
        game_id: String,
        platform: Platform,
    ) -> Result<u64, Error> {
        player1.require_auth();

        if Self::is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        if stake_amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if player1 == player2 {
            return Err(Error::InvalidPlayers);
        }
        if game_id.len() > MAX_GAME_ID_LEN {
            return Err(Error::InvalidGameId);
        }
        // Reject duplicate game_id — same game cannot be used in multiple matches
        if env
            .storage()
            .persistent()
            .has(&DataKey::GameId(game_id.clone()))
        {
            return Err(Error::DuplicateGameId);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::MatchCount)
            .unwrap_or(0);

        if env.storage().persistent().has(&DataKey::Match(id)) {
            return Err(Error::AlreadyExists);
        }

        // STATE TRANSITION: (none) → Pending
        // A brand-new match starts in Pending. No funds are held yet.
        // Valid next transitions:
        //   • Pending → Active    : both players call deposit()
        //   • Pending → Cancelled : either player calls cancel_match()
        let m = Match {
            id,
            player1,
            player2,
            stake_amount,
            token,
            game_id: game_id.clone(),
            platform,
            state: MatchState::Pending,
            player1_deposited: false,
            player2_deposited: false,
            created_ledger: env.ledger().sequence(),
        };

        env.storage().persistent().set(&DataKey::Match(id), &m);
        env.storage().persistent().extend_ttl(
            &DataKey::Match(id),
            MATCH_TTL_LEDGERS,
            MATCH_TTL_LEDGERS,
        );
        // Mark game_id as used
        env.storage()
            .persistent()
            .set(&DataKey::GameId(m.game_id.clone()), &id);
        env.storage().persistent().extend_ttl(
            &DataKey::GameId(m.game_id.clone()),
            MATCH_TTL_LEDGERS,
            MATCH_TTL_LEDGERS,
        );
        // Guard against u64 overflow in release mode where wrapping would occur silently
        let next_id = id.checked_add(1).ok_or(Error::Overflow)?;
        env.storage().instance().set(&DataKey::MatchCount, &next_id);

        env.events().publish(
            (Symbol::new(&env, "match"), symbol_short!("created")),
            (id, m.player1.clone(), m.player2.clone(), stake_amount),
        );

        Ok(id)
    }

    /// Player deposits their stake into escrow.
    pub fn deposit(env: Env, match_id: u64, player: Address) -> Result<(), Error> {
        player.require_auth();

        if Self::is_paused(&env) {
            return Err(Error::ContractPaused);
        }

        let mut m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;

        if m.state == MatchState::Cancelled {
            return Err(Error::MatchCancelled);
        }
        if m.state == MatchState::Completed {
            return Err(Error::MatchCompleted);
        }
        if m.state != MatchState::Pending {
            return Err(Error::InvalidState);
        }

        let is_p1 = player == m.player1;
        let is_p2 = player == m.player2;

        if !is_p1 && !is_p2 {
            return Err(Error::Unauthorized);
        }

        let already_deposited = if is_p1 {
            m.player1_deposited
        } else {
            m.player2_deposited
        };

        if already_deposited {
            return Err(Error::AlreadyFunded);
        }

        let client = token::Client::new(&env, &m.token);
        client
            .try_transfer(&player, &env.current_contract_address(), &m.stake_amount)
            .map_err(|_| Error::TransferFailed)?;

        if is_p1 {
            m.player1_deposited = true;
        } else {
            m.player2_deposited = true;
        }

        if m.player1_deposited && m.player2_deposited {
            // STATE TRANSITION: Pending → Active
            // Both players have now deposited their stake. The game is in progress.
            // Valid next transitions:
            //   • Active → Completed : oracle calls submit_result()
            // Note: cancel_match() is rejected once Active; the match must be resolved
            //       via submit_result().
            m.state = MatchState::Active;
            env.events().publish(
                (Symbol::new(&env, "match"), symbol_short!("activated")),
                match_id,
            );
        }

        env.events().publish(
            (Symbol::new(&env, "match"), symbol_short!("deposit")),
            (match_id, player),
        );

        env.storage()
            .persistent()
            .set(&DataKey::Match(match_id), &m);
        env.storage().persistent().extend_ttl(
            &DataKey::Match(match_id),
            MATCH_TTL_LEDGERS,
            MATCH_TTL_LEDGERS,
        );

        Ok(())
    }

    /// Oracle service triggers payout by providing its caller address.
    ///
    /// The escrow contract reads the verified result directly from the oracle
    /// contract's on-chain storage, ensuring the result was committed there
    /// before any payout is executed.  This closes the silo between the two
    /// contracts: the oracle contract is now the single source of truth.
    ///
    /// Flow:
    ///   1. Verify `caller` == registered oracle service address.
    ///   2. Load the match and validate state / game_id.
    ///   3. Call `oracle_contract.get_result(match_id)` — returns
    ///      `OracleResultNotFound` if the oracle has not yet committed a result.
    ///   4. Cross-check the oracle's `game_id` against the match's `game_id`
    ///      (double-guard against cross-match injection).
    ///   5. Execute payout based on the oracle's `MatchResult`.
    pub fn submit_result(
        env: Env,
        match_id: u64,
        caller: Address,
    ) -> Result<(), Error> {
        if Self::is_paused(&env) {
            return Err(Error::ContractPaused);
        }

        let oracle: Address = env
            .storage()
            .instance()
            .get(&DataKey::Oracle)
            .ok_or(Error::Unauthorized)?;

        if caller != oracle {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        let mut m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;

        if m.state != MatchState::Active {
            return Err(Error::InvalidState);
        }

        if !m.player1_deposited || !m.player2_deposited {
            return Err(Error::NotFunded);
        }

        // --- Cross-contract read: fetch result from oracle contract ----------
        let oracle_contract_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleContract)
            .ok_or(Error::Unauthorized)?;

        let oracle_client = OracleContractClient::new(&env, &oracle_contract_addr);
        let result_entry = oracle_client
            .try_get_result(&match_id)
            .map_err(|_| Error::OracleResultNotFound)?
            .map_err(|_| Error::OracleResultNotFound)?;

        // Verify the oracle result's game_id matches the match's game_id.
        // This is a second line of defence against cross-match result injection
        // (the oracle contract already guards this on its side, but we verify
        // independently so neither contract has to trust the other blindly).
        if m.game_id != result_entry.game_id {
            return Err(Error::GameIdMismatch);
        }

        // Map oracle MatchResult → escrow Winner
        let winner = match result_entry.result {
            MatchResult::Player1Wins => Winner::Player1,
            MatchResult::Player2Wins => Winner::Player2,
            MatchResult::Draw => Winner::Draw,
        };

        let client = token::Client::new(&env, &m.token);

        match winner {
            Winner::Player1 => client.transfer(
                &env.current_contract_address(),
                &m.player1,
                &(m.stake_amount * 2),
            ),
            Winner::Player2 => client.transfer(
                &env.current_contract_address(),
                &m.player2,
                &(m.stake_amount * 2),
            ),
            Winner::Draw => {
                client.transfer(&env.current_contract_address(), &m.player1, &m.stake_amount);
                client.transfer(&env.current_contract_address(), &m.player2, &m.stake_amount);
            }
        }

        // STATE TRANSITION: Active → Completed
        // The oracle has submitted a verified result and the payout has been executed.
        // This is a terminal state — no further transitions are possible.
        m.state = MatchState::Completed;
        env.storage()
            .persistent()
            .set(&DataKey::Match(match_id), &m);
        env.storage().persistent().extend_ttl(
            &DataKey::Match(match_id),
            MATCH_TTL_LEDGERS,
            MATCH_TTL_LEDGERS,
        );

        let topics = (Symbol::new(&env, "match"), symbol_short!("completed"));
        env.events().publish(topics, (match_id, winner));

        Ok(())
    }

    /// Cancel a pending match and refund any deposits.
    /// Either player can cancel a pending match.
    pub fn cancel_match(env: Env, match_id: u64, caller: Address) -> Result<(), Error> {
        let mut m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;

        if m.state != MatchState::Pending {
            return Err(Error::InvalidState);
        }

        let is_p1 = caller == m.player1;
        let is_p2 = caller == m.player2;

        if !is_p1 && !is_p2 {
            return Err(Error::Unauthorized);
        }

        caller.require_auth();

        let client = token::Client::new(&env, &m.token);
        if m.player1_deposited {
            client.transfer(&env.current_contract_address(), &m.player1, &m.stake_amount);
        }
        if m.player2_deposited {
            client.transfer(&env.current_contract_address(), &m.player2, &m.stake_amount);
        }

        // STATE TRANSITION: Pending → Cancelled
        // Either player may cancel before both deposits are made. Any deposit already
        // transferred is refunded above. This is a terminal state — no further
        // transitions are possible.
        m.state = MatchState::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Match(match_id), &m);
        env.storage().persistent().extend_ttl(
            &DataKey::Match(match_id),
            MATCH_TTL_LEDGERS,
            MATCH_TTL_LEDGERS,
        );

        env.events().publish(
            (Symbol::new(&env, "match"), symbol_short!("cancelled")),
            match_id,
        );

        Ok(())
    }

    /// Read a match by ID.
    pub fn get_match(env: Env, match_id: u64) -> Result<Match, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)
    }

    /// Check whether both players have deposited.
    pub fn is_funded(env: Env, match_id: u64) -> Result<bool, Error> {
        let m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;
        Ok(m.player1_deposited && m.player2_deposited)
    }

    /// Return the total escrowed balance for a match (0, 1x, or 2x stake).
    pub fn get_escrow_balance(env: Env, match_id: u64) -> Result<i128, Error> {
        let m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;
        if m.state == MatchState::Completed || m.state == MatchState::Cancelled {
            return Ok(0);
        }
        // Explicit logic avoids fragile bool-to-integer casting
        let deposited: i128 = match (m.player1_deposited, m.player2_deposited) {
            (true, true) => 2,
            (true, false) | (false, true) => 1,
            (false, false) => 0,
        };
        Ok(deposited * m.stake_amount)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod tests_e2e;
