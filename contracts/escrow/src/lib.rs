#![no_std]

mod errors;
mod types;

use errors::Error;
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
    ///
    /// # Panics
    ///
    /// Panics with `"Contract already initialized"` if called more than once.
    /// This guard prevents an attacker from overwriting the oracle or admin
    /// addresses after deployment (see Issue #1 / #110).
    ///
    /// # Errors
    ///
    /// Returns `Error::InvalidToken` if `token` is not a valid SEP-41 token contract.
    pub fn initialize(
        env: Env,
        oracle: Address,
        admin: Address,
        token: Address,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Oracle) {
            panic!("Contract already initialized");
        }
        // Validate token by calling a read-only method; panics if not a real token contract
        let token_client = token::Client::new(&env, &token);
        let _ = token_client.decimals();
        env.storage().instance().set(&DataKey::Oracle, &oracle);
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
        let game_id_len = game_id.len();
        if game_id_len == 0 || game_id_len > MAX_GAME_ID_LEN {
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
            (id, m.player1.clone(), m.player2.clone(), stake_amount, m.game_id.clone()),
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
            .map_err(|_| Error::TransferFailed)?
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
            (match_id, player, m.stake_amount),
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

    /// Oracle submits the verified match result and triggers payout.
    /// `game_id` must match the game_id stored in the match to prevent cross-match result injection.
    pub fn submit_result(
        env: Env,
        match_id: u64,
        game_id: String,
        winner: Winner,
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

        // Verify the oracle is submitting a result for the correct game
        if m.game_id != game_id {
            return Err(Error::GameIdMismatch);
        }

        if m.state != MatchState::Active {
            return Err(Error::InvalidState);
        }

        if !m.player1_deposited || !m.player2_deposited {
            return Err(Error::NotFunded);
        }

        let client = token::Client::new(&env, &m.token);

        let payout_amount: i128 = match winner {
            Winner::Draw => m.stake_amount,
            _ => m.stake_amount * 2,
        };

        match winner {
            Winner::Player1 => client.transfer(
                &env.current_contract_address(),
                &m.player1,
                &payout_amount,
            ),
            Winner::Player2 => client.transfer(
                &env.current_contract_address(),
                &m.player2,
                &payout_amount,
            ),
            Winner::Draw => {
                client.transfer(&env.current_contract_address(), &m.player1, &payout_amount);
                client.transfer(&env.current_contract_address(), &m.player2, &payout_amount);
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
        env.events().publish(topics, (match_id, winner, payout_amount));

        Ok(())
    }

    /// Cancel a pending match and refund any deposits.
    ///
    /// Authorization model:
    /// - If neither or only one player has deposited: the calling player's auth suffices.
    /// - If both players have deposited: both players must authorize, because cancelling
    ///   would withdraw funds that the other player has already committed.
    ///
    /// Cancelation is allowed while the contract is paused so players can recover funds.
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

        // When both players have deposited, both must consent to cancellation
        // to prevent one player from unilaterally withdrawing the other's funds.
        if m.player1_deposited && m.player2_deposited {
            m.player1.require_auth();
            m.player2.require_auth();
        } else {
            caller.require_auth();
        }

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
            (match_id, caller.clone()),
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
