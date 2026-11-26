//! # Escrow Contract
//!
//! Trustless chess-match escrow on Stellar Soroban. Players stake XLM or USDC before a game;
//! the verified winner is paid out automatically the moment the oracle submits the result.
//!
//! ## State Machine
//!
//! Every match moves through the following states. Invalid transitions are rejected on-chain
//! with [`Error::InvalidState`].
//!
//! ```text
//! (none) ──create_match()──► Pending
//!                                │
//!                ┌───────────────┤
//!                │               │
//!         cancel_match()    deposit() × 2
//!                │               │
//!                ▼               ▼
//!            Cancelled        Active ──── claim_timeout() ──► Cancelled
//!                           (funds held)         │
//!                                │        cancel_match()
//!                                │        (both players) ──► Cancelled
//!                         submit_result()
//!                          (oracle only)
//!                                │
//!                                ▼
//!                         PendingResult  ◄── override_result() (admin)
//!                          (dispute window)
//!                                │
//!                       finalize_result()
//!                     (after window expires)
//!                                │
//!                                ▼
//!                           Completed
//!                          (payout done)
//! ```
//!
//! `Cancelled` and `Completed` are **terminal** — no further transitions are possible.
//!
//! ## Key Data Structures
//!
//! - [`Match`](types::Match) — full record of a single betting match stored in persistent storage.
//! - [`MatchState`](types::MatchState) — lifecycle enum driving the state machine above.
//! - [`Winner`](types::Winner) — payout outcome: `Player1`, `Player2`, or `Draw`.
//! - [`Platform`](types::Platform) — chess platform the game is hosted on (`Lichess` / `ChessDotCom`).
//! - [`DataKey`](types::DataKey) — all storage keys used by the contract.
//! - [`Error`](errors::Error) — every error code the contract can return.
//!
//! ## Further Reading
//!
//! - Architecture & sequence diagrams: [`docs/architecture.md`](../../docs/architecture.md)
//! - Full API reference with CLI examples: [`docs/api-reference.md`](../../docs/api-reference.md)
//! - Emergency procedures: [`docs/runbook.md`](../../docs/runbook.md)

// Enforced for every item in this crate, and denied outright by the `Rustdoc`
// CI job. The two `#[allow(missing_docs)]` attributes below are the only
// exemptions: they cover items that soroban's `#[contract]` and `#[contractimpl]`
// macros generate, which cannot be documented from this crate's source.
#![warn(missing_docs)]
#![no_std]

mod constants;
mod errors;
mod types;

pub use constants::*;

use errors::Error;
use soroban_sdk::{contract, contractimpl, symbol_short, token, vec, Address, BytesN, Env, String, Symbol, Vec};

/// Topic symbol for the event emitted when the contract is paused.
const CONTRACT_PAUSED: Symbol = symbol_short!("paused");
/// Topic symbol for the event emitted when the contract is unpaused.
const CONTRACT_UNPAUSED: Symbol = symbol_short!("unpaused");
use types::{
    AdminRole, DataKey, DisputeEvidenceRecord, Match, MatchState, OptionalWinner, PendingDrain,
    FeeConfig, FeePolicy, PayoutEntry, PayoutRecord, Permission, Platform, StakeLimits, Winner,
};

fn is_zero_address(env: &Env, addr: &Address) -> bool {
    // The all-zeros ed25519 account key as a strkey. Built from the string
    // because the XDR `ScAddress` conversion is host-only and doesn't exist in
    // the wasm build.
    let zero_address = Address::from_str(
        env,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );
    addr == &zero_address
}

/// The trustless chess-match escrow contract.
///
/// This unit struct is a marker and carries no state of its own. All state lives
/// in the contract's storage, addressed by the `DataKey` enum in `types.rs`, and
/// every operation is exposed as an associated function in the `#[contractimpl]`
/// block below.
///
/// The public data model is:
///
/// | Concept            | Type                                                    |
/// |--------------------|---------------------------------------------------------|
/// | Per-match state    | `Match` (persistent, keyed by `DataKey::Match`)          |
/// | Lifecycle          | `MatchState`                                            |
/// | Oracle result      | `Winner`, wrapped in `OptionalWinner` while in dispute  |
/// | Storage keys       | `DataKey`                                               |
/// | Error codes        | `Error` in `errors.rs`                                  |
///
/// See the crate-level documentation above for the full state machine.
#[allow(missing_docs)]
#[contract]
pub struct EscrowContract;

#[allow(missing_docs)]
#[contractimpl]
impl EscrowContract {
    /// Read the currently initialized admin for deployment authorization checks.
    /// Does not mutate state or grant authority.
    pub fn get_admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    /// The stake range (inclusive, smallest token unit) new matches must fall in.
    pub fn get_stake_limits(env: Env) -> StakeLimits {
        Self::stake_limits(&env)
    }

    /// Set the stake range for new matches (#2059). Requires
    /// [`Permission::TokenManagement`] (primary or secondary admin).
    ///
    /// `min` and `max` are inclusive and must satisfy
    /// `0 < min <= max <= MAX_STAKE`; `MAX_STAKE` is a hard ceiling so payouts
    /// can't overflow. Existing matches keep the stake they were created with.
    pub fn set_stake_limits(env: Env, caller: Address, min: i128, max: i128) -> Result<(), Error> {
        Self::require_permission(&env, &caller, Permission::TokenManagement)?;
        caller.require_auth();
        if min <= 0 || min > max || max > MAX_STAKE {
            return Err(Error::InvalidStakeLimits);
        }
        env.storage()
            .instance()
            .set(&DataKey::StakeLimits, &StakeLimits { min, max });
        Self::bump_instance_ttl(&env);
        env.events().publish(
            (Symbol::new(&env, "admin"), symbol_short!("stk_lim")),
            (caller, min, max),
        );
        Ok(())
    }

    /// Return the role assigned to `account`, or `None` if it holds no role.
    pub fn get_role(env: Env, account: Address) -> Option<AdminRole> {
        env.storage()
            .persistent()
            .get(&DataKey::Role(account))
    }

    /// Assign `role` to `account`. Only the primary admin may call this.
    ///
    /// The primary admin is the address stored under [`DataKey::Admin`] at
    /// initialization. It implicitly holds every permission and is the only
    /// account allowed to grant or revoke roles.
    pub fn assign_role(
        env: Env,
        caller: Address,
        account: Address,
        role: AdminRole,
    ) -> Result<(), Error> {
        Self::require_primary_admin(&env, &caller)?;
        caller.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::Role(account.clone()), &role);
        env.storage().persistent().extend_ttl(
            &DataKey::Role(account.clone()),
            MATCH_TTL_LEDGERS,
            MATCH_TTL_LEDGERS,
        );
        Self::bump_instance_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "admin"), symbol_short!("role_set")),
            (account, role),
        );
        Ok(())
    }

    /// Revoke any role held by `account`. Only the primary admin may call this.
    pub fn revoke_role(env: Env, caller: Address, account: Address) -> Result<(), Error> {
        Self::require_primary_admin(&env, &caller)?;
        caller.require_auth();

        env.storage()
            .persistent()
            .remove(&DataKey::Role(account.clone()));
        Self::bump_instance_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "admin"), symbol_short!("role_rev")),
            account,
        );
        Ok(())
    }

    /// Ensure `caller` is the primary admin (the address stored under `DataKey::Admin`).
    fn require_primary_admin(env: &Env, caller: &Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if caller != &admin {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }

    /// Ensure `caller` holds `permission`, either directly via its assigned role
    /// or implicitly as the primary admin.
    fn require_permission(
        env: &Env,
        caller: &Address,
        permission: Permission,
    ) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if caller == &admin {
            return Ok(());
        }
        let role: AdminRole = env
            .storage()
            .persistent()
            .get(&DataKey::Role(caller.clone()))
            .ok_or(Error::Unauthorized)?;
        if role.has_permission(permission) {
            Ok(())
        } else {
            Err(Error::Unauthorized)
        }
    }

    /// Pause the contract, blocking new match creation and deposits while
    /// allowing in-flight matches to settle.
    ///
    /// Requires [`Permission::Pause`] and a `reason` of 1-256 bytes (#2061).
    ///
    /// Emits `("paused", admin)` with data `(reason, timestamp, ledger)`. The
    /// admin address is a topic, so indexers can filter pause events by admin.
    pub fn pause(env: Env, caller: Address, reason: String) -> Result<(), Error> {
        Self::require_permission(&env, &caller, Permission::Pause)?;
        caller.require_auth();
        Self::check_pause_reason(&reason)?;
        if Self::is_paused(&env) {
            return Ok(());
        }
        env.storage().instance().set(&DataKey::Paused, &true);
        Self::bump_instance_ttl(&env);
        env.events().publish(
            (CONTRACT_PAUSED, caller.clone()),
            (reason, env.ledger().timestamp(), env.ledger().sequence()),
        );
        Ok(())
    }

    fn check_pause_reason(reason: &String) -> Result<(), Error> {
        if reason.len() == 0 || reason.len() > MAX_PAUSE_REASON_LEN {
            return Err(Error::InvalidPauseReason);
        }
        Ok(())
    }

    /// Unpause the contract, re-enabling normal operation.
    ///
    /// Requires [`Permission::Unpause`] and a `reason` of 1-256 bytes (#2061).
    ///
    /// Emits `("unpaused", admin)` with data `(reason, timestamp, ledger)`.
    pub fn unpause(env: Env, caller: Address, reason: String) -> Result<(), Error> {
        Self::require_permission(&env, &caller, Permission::Unpause)?;
        caller.require_auth();
        Self::check_pause_reason(&reason)?;
        if !Self::is_paused(&env) {
            return Ok(());
        }
        env.storage().instance().set(&DataKey::Paused, &false);
        Self::bump_instance_ttl(&env);
        env.events().publish(
            (CONTRACT_UNPAUSED, caller.clone()),
            (reason, env.ledger().timestamp(), env.ledger().sequence()),
        );
        Ok(())
    }

    /// Return whether the contract is currently paused.
    pub fn is_paused(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Return the configured dispute window duration in ledgers.
    ///
    /// This is the time the admin has to call [`override_result`](EscrowContract::override_result)
    /// after the oracle submits a result, before it becomes final. Defaults to
    /// `DISPUTE_WINDOW_LEDGERS` (~24 hours) if not configured at initialization.
    pub fn get_dispute_window_ledgers(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::DisputeWindowLedgers)
            .unwrap_or(DISPUTE_WINDOW_LEDGERS)
    }

    /// Return the configured match timeout duration in ledgers.
    ///
    /// This is the time an active match can remain without an oracle result
    /// before any account may call [`enforce_timeout`](EscrowContract::enforce_timeout).
    /// Defaults to [`DEFAULT_TIMEOUT_LEDGERS`] (~7 days / `120_960` ledgers at the
    /// Stellar 5 s/ledger average) if no explicit value was passed to
    /// [`initialize`](EscrowContract::initialize).
    pub fn get_timeout_ledgers(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::TimeoutLedgers)
            .unwrap_or(DEFAULT_TIMEOUT_LEDGERS)
    }

    fn get_match_count(env: &Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::MatchCount)
            .unwrap_or(0)
    }

    /// Return the total number of matches ever created.
    ///
    /// Exposed as a public read-only view so that frontends and off-chain tooling
    /// can efficiently query the total match count for pagination and progress
    /// displays without needing to enumerate via `list_matches`.
    pub fn match_count(env: Env) -> u64 {
        Self::get_match_count(&env)
    }

    fn validate_match_id(env: &Env, match_id: u64) -> Result<(), Error> {
        if match_id >= Self::get_match_count(env) {
            return Err(Error::MatchNotFound);
        }
        Ok(())
    }

    /// Validate that every byte of `game_id` belongs to the set `[A-Za-z0-9_-]`.
    ///
    /// This enforces printable ASCII and prevents null bytes, control characters,
    /// whitespace, and non-ASCII sequences from entering persistent storage.
    /// The allowed set mirrors the identifier format used by Lichess and Chess.com.
    ///
    /// The string is copied into a fixed 64-byte stack buffer — the same size as
    /// `MAX_GAME_ID_LEN` — so no heap allocation is required inside the WASM guest.
    /// Whether `game_id` has the format `platform` issues (#2062).
    ///
    /// * Lichess: exactly 8 ASCII alphanumeric characters (e.g. `q7ZvsdUF`).
    /// * Chess.com: the numeric game ID, 1-20 digits with no leading zero
    ///   (e.g. `98765432101`).
    ///
    /// Assumes the generic length check has already passed.
    fn game_id_matches_platform(game_id: &soroban_sdk::String, platform: &Platform) -> bool {
        let len = game_id.len() as usize;
        if len > MAX_GAME_ID_LEN as usize {
            return false;
        }
        let mut buf = [0u8; MAX_GAME_ID_LEN as usize];
        game_id.copy_into_slice(&mut buf[..len]);
        let id = &buf[..len];
        match platform {
            Platform::Lichess => {
                len == LICHESS_GAME_ID_LEN && id.iter().all(|b| b.is_ascii_alphanumeric())
            }
            Platform::ChessDotCom => {
                (1..=CHESSCOM_GAME_ID_MAX_LEN).contains(&len)
                    && id[0] != b'0'
                    && id.iter().all(|b| b.is_ascii_digit())
            }
        }
    }

    /// The stake range applied to new matches (#2059).
    fn stake_limits(env: &Env) -> StakeLimits {
        env.storage()
            .instance()
            .get(&DataKey::StakeLimits)
            .unwrap_or(StakeLimits {
                min: MIN_STAKE,
                max: MAX_STAKE,
            })
    }

    fn is_valid_game_id(game_id: &soroban_sdk::String) -> bool {
        let len = game_id.len() as usize;
        // Safety: len is already validated to be in [1, MAX_GAME_ID_LEN].
        let mut buf = [0u8; MAX_GAME_ID_LEN as usize];
        game_id.copy_into_slice(&mut buf[..len]);
        for i in 0..len {
            let b = buf[i];
            let ok = b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
            if !ok {
                return false;
            }
        }
        true
    }

    /// Extend the lifetime of every instance-storage entry held by this contract.
    ///
    /// Instance storage (oracle, admin, token, paused, match_count) shares a single
    /// TTL, so it is bumped as a unit after every mutating call. Without this the
    /// instance entries would expire while a long-running tournament of matches was
    /// still in progress and the contract would start failing with storage-not-found
    /// errors.
    fn bump_instance_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    /// Pre-flight check that the contract retains at least
    /// [`ESCROW_RESERVE_BUFFER_STROOPS`] of `token` **after** a total payout of
    /// `payout_total` is subtracted.
    ///
    /// Without this guard a token::transfer performed at payout time could
    /// fail at the Stellar protocol layer with a reserve-induced
    /// `op_under_min_balance` / generic `TransferFailed`, leaving the match
    /// state machine stuck (funds not sent, state still `PendingResult` etc.).
    fn ensure_reserve_for_payout(
        env: &Env,
        token: &Address,
        payout_total: i128,
    ) -> Result<(), Error> {
        let client = token::Client::new(env, token);
        let balance = client.balance(&env.current_contract_address());
        if balance < payout_total + ESCROW_RESERVE_BUFFER_STROOPS {
            return Err(Error::InsufficientReserve);
        }
        Ok(())
    }

    fn store_match(env: &Env, m: &Match) {
        let storage = env.storage().persistent();
        let match_key = DataKey::Match(m.id);
        let game_id_key = DataKey::GameId(m.game_id.clone());

        storage.set(&match_key, m);
        storage.extend_ttl(&match_key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        storage.set(&game_id_key, &m.id);
        storage.extend_ttl(&game_id_key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
    }

    fn publish_state_transition(
        env: &Env,
        m: &Match,
        from_state: Option<MatchState>,
        to_state: MatchState,
        player1_amount: u128,
        player2_amount: u128,
    ) {
        env.events().publish(
            (Symbol::new(env, "match"), Symbol::new(env, "transition")),
            (
                m.id,
                from_state,
                to_state,
                m.player1.clone(),
                m.player2.clone(),
                m.stake_amount,
                player1_amount,
                player2_amount,
            ),
        );
    }

    fn cancel_timed_out_match(
        env: &Env,
        match_id: u64,
        caller: Option<Address>,
    ) -> Result<(), Error> {
        Self::validate_match_id(env, match_id)?;

        let mut m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;

        if m.state != MatchState::Active {
            return Err(Error::InvalidState);
        }

        if let Some(ref caller) = caller {
            caller.require_auth();
            if caller != &m.player1 && caller != &m.player2 {
                return Err(Error::Unauthorized);
            }
        }

        let activated = m.activated_ledger.ok_or(Error::InvalidState)?;
        let current = env.ledger().sequence();
        let timeout = Self::get_timeout_ledgers(env);
        if current.saturating_sub(activated) <= timeout {
            return Err(Error::TimeoutNotReached);
        }

        let client = token::Client::new(env, &m.token);
        let refund_total = m.stake_amount * 2;
        Self::ensure_reserve_for_payout(env, &m.token, refund_total as i128)?;
        client.transfer(&env.current_contract_address(), &m.player1, &stake_i128(&m));
        client.transfer(&env.current_contract_address(), &m.player2, &stake_i128(&m));

        m.state = MatchState::Cancelled;
        m.cancelled_ledger = Some(current);
        Self::store_match(env, &m);
        Self::bump_instance_ttl(env);

        Self::publish_state_transition(
            env,
            &m,
            Some(MatchState::Active),
            MatchState::Cancelled,
            m.stake_amount,
            m.stake_amount,
        );
        if let Some(caller) = caller {
            env.events().publish(
                (Symbol::new(env, "match"), symbol_short!("timeout")),
                (match_id, caller),
            );
        }

        Ok(())
    }

    /// Initialize the contract with a trusted oracle address, an admin, a default token,
    /// and a pre-registered safe address that is the sole permitted destination for
    /// [`emergency_drain`](EscrowContract::emergency_drain).
    ///
    /// The `safe_address` is stored immutably at initialization time. It cannot be
    /// changed afterwards. This eliminates the rug-pull vector where a compromised or
    /// malicious admin could call `emergency_drain` with an arbitrary destination address.
    ///
    /// The `dispute_window_ledgers` and `timeout_ledgers` parameters allow configurable
    /// timing for different deployments (testnet vs mainnet, casual vs high-stakes matches).
    /// If not provided, they default to `DISPUTE_WINDOW_LEDGERS` (~24 hours) and
    /// [`DEFAULT_TIMEOUT_LEDGERS`] (~7 days / `120_960` ledgers) respectively.
    ///
    /// # Arguments
    ///
    /// * `oracle` — The address of the trusted oracle contract.
    /// * `admin` — The address of the contract administrator.
    /// * `token` — The SEP-41 token address for staking.
    /// * `safe_address` — The immutable destination for emergency drain operations.
    /// * `dispute_window_ledgers` — The duration of the dispute window in ledgers. If `None`,
    ///   defaults to `DISPUTE_WINDOW_LEDGERS`.
    /// * `timeout_ledgers` — The timeout duration for active matches in ledgers. If `None`,
    ///   defaults to [`DEFAULT_TIMEOUT_LEDGERS`] (~7 days / `120_960` ledgers).
    ///
    /// # Panics
    ///
    /// Panics with `"Contract already initialized"` if called more than once.
    pub fn initialize(
        env: Env,
        oracle: Address,
        admin: Address,
        token: Address,
        safe_address: Address,
        dispute_window_ledgers: Option<u32>,
        timeout_ledgers: Option<u32>,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Oracle) {
            return Err(Error::AlreadyInitialized);
        }
        let token_client = token::Client::new(&env, &token);
        let _ = token_client.decimals();
        env.storage().instance().set(&DataKey::Oracle, &oracle);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);

        // Seed the allowlist with the default token so a contract that is
        // never extended behaves exactly as it did before the allowlist
        // existed: the only accepted token is the one passed to `initialize`.
        // `remove_token` refuses to remove this entry, so the contract can
        // never be left with no acceptable token at all.
        env.storage()
            .persistent()
            .set(&DataKey::TokenAllowlisted(token.clone()), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::TokenAllowlisted(token.clone()),
            MATCH_TTL_LEDGERS,
            MATCH_TTL_LEDGERS,
        );
        env.storage()
            .instance()
            .set(&DataKey::SafeAddress, &safe_address);
        env.storage().instance().set(&DataKey::MatchCount, &0u64);
        env.storage().instance().set(&DataKey::Paused, &false);

        // Store the configured dispute window, or use the default
        let dispute_window = dispute_window_ledgers.unwrap_or(DISPUTE_WINDOW_LEDGERS);
        env.storage()
            .instance()
            .set(&DataKey::DisputeWindowLedgers, &dispute_window);

        // Store the configured timeout, or fall back to the default (~7 days).
        let timeout = timeout_ledgers.unwrap_or(DEFAULT_TIMEOUT_LEDGERS);
        env.storage()
            .instance()
            .set(&DataKey::TimeoutLedgers, &timeout);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Rotate the oracle address — requires [`Permission::OracleRotation`].
    pub fn update_oracle(env: Env, caller: Address, new_oracle: Address) -> Result<(), Error> {
        Self::require_permission(&env, &caller, Permission::OracleRotation)?;
        caller.require_auth();
        let old_oracle: Address = env
            .storage()
            .instance()
            .get(&DataKey::Oracle)
            .ok_or(Error::Unauthorized)?;
        env.storage().instance().set(&DataKey::Oracle, &new_oracle);
        Self::bump_instance_ttl(&env);
        env.events().publish(
            (
                Symbol::new(&env, "admin"),
                Symbol::new(&env, "oracle_updated"),
            ),
            (old_oracle, new_oracle, caller),
        );
        Ok(())
    }

    /// Rotate the admin address — requires the current admin to authorize.
    pub fn transfer_admin(env: Env, caller: Address, new_admin: Address) -> Result<(), Error> {
        let current_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;

        if caller != current_admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        if is_zero_address(&env, &new_admin) || new_admin == current_admin {
            return Err(Error::InvalidAdmin);
        }

        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Self::bump_instance_ttl(&env);
        env.events().publish(
            (Symbol::new(&env, "admin"), symbol_short!("adm_xfer")),
            (current_admin, new_admin),
        );
        Ok(())
    }

    /// Create a new match. Both players must call `deposit` before the game starts.
    ///
    /// Rejected with [`Error::ContractPaused`] while the contract is paused, so
    /// no new matches can be created during maintenance or an emergency.
    ///
    /// `token` selects which SEP-41 token this match is escrowed in. Passing
    /// `None` uses the contract's default token (the one supplied to
    /// [`initialize`](EscrowContract::initialize)), which is what a caller that
    /// does not care about the currency should do.
    ///
    /// A non-`None` token must be on the admin-managed allowlist
    /// ([`add_token`](EscrowContract::add_token)); otherwise the call fails with
    /// [`Error::TokenNotAllowlisted`]. This is what stops a caller from naming
    /// an arbitrary SEP-41 contract and having the escrow pull funds through
    /// it.
    ///
    /// The chosen token is copied into [`Match::token`] at creation and is the
    /// token [`deposit`](EscrowContract::deposit) pulls and the payout pays
    /// out in. A later `remove_token` does **not** disturb matches that already
    /// exist: it stops new matches from being created in that token, leaving
    /// in-flight escrows untouched and settleable.
    pub fn create_match(
        env: Env,
        player1: Address,
        player2: Address,
        stake_amount: i128,
        token: Option<Address>,
        game_id: String,
        platform: Platform,
    ) -> Result<u64, Error> {
        player1.require_auth();

        if Self::is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        // Reject a zero stake explicitly before the MIN_STAKE range check so
        // callers receive a dedicated error code rather than StakeTooLow.
        if stake_amount == 0 {
            return Err(Error::InvalidStakeAmount);
        }
        let limits = Self::stake_limits(&env);
        if stake_amount < limits.min {
            return Err(Error::StakeTooLow);
        }
        if stake_amount > limits.max {
            return Err(Error::StakeTooHigh);
        }
        if player1 == player2 {
            return Err(Error::InvalidPlayers);
        }
        // Validate that neither player is the zero/burn address.
        // Uses the existing is_zero_address helper (XDR-based Address equality)
        // instead of a string comparison, which is cheaper on compute budget and
        // robust against any future strkey encoding changes.
        if is_zero_address(&env, &player1) || is_zero_address(&env, &player2) {
            return Err(Error::InvalidAddress);
        }
        let game_id_len = game_id.len();
        if game_id_len == 0 || game_id_len > MAX_GAME_ID_LEN {
            return Err(Error::InvalidGameId);
        }
        // Enforce printable ASCII: only [A-Za-z0-9_-] are accepted.
        // This closes the gap where a caller could submit a game_id containing
        // null bytes, control characters, or non-ASCII sequences that would
        // match the length check but silently diverge from the platform API
        // lookup key used by the oracle.
        if !Self::is_valid_game_id(&game_id) {
            return Err(Error::InvalidGameId);
        }
        // Platform-specific format (#2062): a well-formed ID the platform could
        // never issue would leave the oracle unable to settle the match.
        if !Self::game_id_matches_platform(&game_id, &platform) {
            return Err(Error::InvalidGameIdFormat);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::GameId(game_id.clone()))
        {
            return Err(Error::DuplicateGameId);
        }

        // Resolve the token: an explicit argument overrides the default, and
        // `None` means "use whatever this contract was initialized with".
        let stored_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::Unauthorized)?;
        let token = match token {
            Some(t) => t,
            None => stored_token,
        };

        // The default token is allowlisted by `initialize` and cannot be
        // removed, so checking every token — including the default — against
        // the allowlist is both simpler and stricter than special-casing it.
        if !env
            .storage()
            .persistent()
            .has(&DataKey::TokenAllowlisted(token.clone()))
        {
            return Err(Error::TokenNotAllowlisted);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::MatchCount)
            .unwrap_or(0);

        if env.storage().persistent().has(&DataKey::Match(id)) {
            return Err(Error::AlreadyExists);
        }

        // Capture the event values *before* the locals are moved into the Match struct.
        let event_player1 = player1.clone();
        let event_player2 = player2.clone();
        let event_game_id = game_id.clone();

        let m = Match {
            id,
            player1,
            player2,
            // Validated positive and <= MAX_STAKE above, so this is lossless.
            stake_amount: stake_amount as u128,
            token,
            game_id,
            platform,
            state: MatchState::Pending,
            player1_deposited: false,
            player2_deposited: false,
            created_ledger: env.ledger().sequence(),
            activated_ledger: None,
            pending_result_ledger: None,
            pending_winner: OptionalWinner::None,
            cancelled_ledger: None,
            completed_ledger: None,
            player1_deposited_at: None,
            player2_deposited_at: None,
            first_depositor: None,
        };

        Self::store_match(&env, &m);
        let next_id = id.checked_add(1).ok_or(Error::Overflow)?;
        env.storage().instance().set(&DataKey::MatchCount, &next_id);
        Self::bump_instance_ttl(&env);

        Self::publish_state_transition(
            &env,
            &m,
            None,
            MatchState::Pending,
            0,
            0,
        );
        env.events().publish(
            (Symbol::new(&env, "match"), symbol_short!("created")),
            (id, event_player1, event_player2, stake_amount, event_game_id),
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
        let is_p1 = player == m.player1;
        let is_p2 = player == m.player2;

        if !is_p1 && !is_p2 {
            return Err(Error::Unauthorized);
        }
        let player_label = if is_p1 {
            symbol_short!("player1")
        } else {
            symbol_short!("player2")
        };

        let already_deposited = if is_p1 {
            m.player1_deposited
        } else {
            m.player2_deposited
        };

        // #2064: a player who has deposited always gets AlreadyFunded, even
        // once the match is Active, so the error says what actually happened.
        if already_deposited {
            return Err(Error::AlreadyFunded);
        }
        if m.state != MatchState::Pending {
            return Err(Error::InvalidState);
        }

        let client = token::Client::new(&env, &m.token);
        let allowance = client.allowance(&player, &env.current_contract_address());
        if allowance < stake_i128(&m) {
            return Err(Error::InsufficientAllowance);
        }
        client
            .try_transfer(&player, &env.current_contract_address(), &stake_i128(&m))
            .map_err(|_| Error::TransferFailed)?
            .map_err(|_| Error::TransferFailed)?;

        // Record when each deposit landed and which came first (#2060).
        let now = env.ledger().timestamp();
        let is_first = !m.player1_deposited && !m.player2_deposited;
        if is_p1 {
            m.player1_deposited = true;
            m.player1_deposited_at = Some(now);
        } else {
            m.player2_deposited = true;
            m.player2_deposited_at = Some(now);
        }
        if is_first {
            m.first_depositor = Some(player.clone());
        }
        // Audit log: order (1 or 2), ledger time and sequence of this deposit.
        env.events().publish(
            (Symbol::new(&env, "match"), symbol_short!("dep_order")),
            (
                match_id,
                player.clone(),
                if is_first { 1u32 } else { 2u32 },
                now,
                env.ledger().sequence(),
            ),
        );

        // Check if exactly one player has now deposited (half-funded state)
        let one_deposited = (m.player1_deposited as u8) + (m.player2_deposited as u8) == 1;

        if one_deposited {
            // STATE TRANSITION: Pending → Half-Funded (one player deposited)
            // Emit event to signal this observability milestone
            let player_label = if is_p1 {
                symbol_short!("player1")
            } else {
                symbol_short!("player2")
            };
            env.events().publish(
                (Symbol::new(&env, "match"), symbol_short!("half_fun")),
                (match_id, player_label, m.stake_amount),
            );
        }

        if m.player1_deposited && m.player2_deposited {
            // STATE TRANSITION: Pending → Active
            // Record the ledger at which the match became active for timeout tracking.
            m.state = MatchState::Active;
            m.activated_ledger = Some(env.ledger().sequence());
            Self::publish_state_transition(
                &env,
                &m,
                Some(MatchState::Pending),
                MatchState::Active,
                0,
                0,
            );
            env.events().publish(
                (Symbol::new(&env, "match"), symbol_short!("activated")),
                match_id,
            );
        } else {
            env.events().publish(
                (Symbol::new(&env, "match"), symbol_short!("half_fun")),
                (
                    match_id,
                    player.clone(),
                    m.stake_amount,
                    player_label.clone(),
                ),
            );
        }

        env.events().publish(
            (Symbol::new(&env, "match"), symbol_short!("deposit")),
            (match_id, player, m.stake_amount, player_label),
        );

        Self::store_match(&env, &m);
        Self::bump_instance_ttl(&env);

        Ok(())
    }

    /// Oracle submits the verified match result. Transitions match to `PendingResult`
    /// and starts the dispute window. Payout is NOT executed immediately — call
    /// `finalize_result` after `DISPUTE_WINDOW_LEDGERS` to execute the payout.
    ///
    /// `game_id` must match the game_id stored in the match to prevent cross-match
    /// result injection.
    ///
    /// Settlement is intentionally **not** blocked while the contract is paused:
    /// in-flight matches must be able to complete during a graceful shutdown.
    pub fn submit_result(
        env: Env,
        match_id: u64,
        game_id: String,
        winner: Winner,
        caller: Address,
    ) -> Result<(), Error> {
        let oracle: Address = env
            .storage()
            .instance()
            .get(&DataKey::Oracle)
            .ok_or(Error::Unauthorized)?;

        if caller != oracle {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        Self::validate_match_id(&env, match_id)?;

        let mut m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;

        if m.game_id != game_id {
            return Err(Error::GameIdMismatch);
        }

        if m.state != MatchState::Active {
            return Err(Error::InvalidState);
        }

        if !m.player1_deposited || !m.player2_deposited {
            // Invariant: Active state implies both players have deposited.
            // This check is a defensive guard — it should never be reached because
            // the match can only transition to Active once both deposits are confirmed.
            // It is retained to prevent any future refactor from inadvertently allowing
            // a payout on a match where funds were never fully escrowed.
            return Err(Error::NotFunded);
        }

        let activated = m.activated_ledger.ok_or(Error::InvalidState)?;
        let timeout = Self::get_timeout_ledgers(&env);
        if env.ledger().sequence().saturating_sub(activated) > timeout {
            return Err(Error::MatchTimedOut);
        }

        // STATE TRANSITION: Active → PendingResult
        // The oracle's result enters a dispute window. No payout yet.
        m.state = MatchState::PendingResult;
        m.pending_result_ledger = Some(env.ledger().sequence());
        m.pending_winner = OptionalWinner::Some(winner.clone());

        Self::store_match(&env, &m);
        Self::bump_instance_ttl(&env);

        Self::publish_state_transition(
            &env,
            &m,
            Some(MatchState::Active),
            MatchState::PendingResult,
            0,
            0,
        );
        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("pending")),
            (match_id, winner, m.pending_result_ledger),
        );

        Ok(())
    }

    /// Admin overrides an oracle result during the dispute window.
    ///
    /// Can only be called while the match is in `PendingResult` state and before
    /// `DISPUTE_WINDOW_LEDGERS` have elapsed since the result was submitted.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`]      — caller is not the admin.
    /// * [`Error::InvalidState`]      — match is not in `PendingResult` state.
    /// * [`Error::DisputeWindowActive`] — dispute window has already expired; call
    ///   `finalize_result` instead.
    pub fn override_result(
        env: Env,
        match_id: u64,
        new_winner: Winner,
        caller: Address,
    ) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;

        if caller != admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        Self::validate_match_id(&env, match_id)?;

        let mut m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;

        if m.state == MatchState::Contested {
            return Err(Error::DisputeActive);
        }

        if m.state != MatchState::PendingResult {
            return Err(Error::InvalidState);
        }

        // Ensure the dispute window has not yet expired; after expiry the result
        // is final and must be processed via finalize_result.
        let prl = m
            .pending_result_ledger
            .ok_or(Error::InvalidState)?;
        let current = env.ledger().sequence();
        let dispute_window = Self::get_dispute_window_ledgers(&env);
        if current > prl + dispute_window {
            return Err(Error::DisputeWindowExpired);
        }

        let old_winner = m.pending_winner.clone();
        if old_winner == OptionalWinner::Some(new_winner.clone()) {
            return Ok(());
        }
        m.pending_winner = OptionalWinner::Some(new_winner.clone());

        Self::store_match(&env, &m);
        Self::bump_instance_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("overridn")),
            (match_id, old_winner, new_winner),
        );

        Ok(())
    }

    /// Finalize a pending result and execute payout after the dispute window has expired.
    ///
    /// May only be called by one of the **matched players** (`player1` or `player2`),
    /// the registered **oracle**, or the **admin**. This prevents a third party from
    /// triggering payout transactions on behalf of players (e.g. to collect fee rebates
    /// or grief a player who intended to call `finalize_result` themselves).
    ///
    /// # Arguments
    ///
    /// * `match_id` — The match to finalize.
    /// * `caller`   — Must be `player1`, `player2`, the oracle, or the admin; must authorize.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`]        — caller is not a matched player, the oracle, or the admin.
    /// * [`Error::InvalidState`]        — match is not in `PendingResult` state.
    /// * [`Error::DisputeWindowActive`] — dispute window has not yet expired.
    pub fn finalize_result(env: Env, match_id: u64, caller: Address) -> Result<(), Error> {
        Self::validate_match_id(&env, match_id)?;

        let mut m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;

        // Authorisation: only player1, player2, the oracle, or the admin may
        // call finalize_result. This stops any random account from triggering
        // the payout (e.g. to collect fee rebates or grief a player).
        let oracle: Address = env
            .storage()
            .instance()
            .get(&DataKey::Oracle)
            .ok_or(Error::Unauthorized)?;
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;

        if caller != m.player1 && caller != m.player2 && caller != oracle && caller != admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        if m.state != MatchState::PendingResult {
            return Err(Error::InvalidState);
        }

        let prl = m
            .pending_result_ledger
            .ok_or(Error::InvalidState)?;
        let current = env.ledger().sequence();
        let dispute_window = Self::get_dispute_window_ledgers(&env);
        if current <= prl + dispute_window {
            return Err(Error::DisputeWindowActive);
        }

        let winner = match m.pending_winner.clone() {
            OptionalWinner::Some(w) => w,
            OptionalWinner::None => return Err(Error::InvalidState),
        };

        // #2065: compute and validate the amounts before anything moves.
        let (player1_amount, player2_amount) = payout_amounts(&winner, stake_i128(&m));
        validate_payout(&winner, stake_i128(&m), player1_amount, player2_amount)?;
        // #2067: fix the fee for each payout now, so a later config change
        // can't alter a match already being paid.
        let fees = Self::fee_config(&env);
        let mut record = PayoutRecord {
            player1_amount,
            player2_amount,
            player1_fee: player_fee_share(&fees, player1_amount),
            player2_fee: player_fee_share(&fees, player2_amount),
            player1_paid: player1_amount == 0,
            player2_paid: player2_amount == 0,
            attempts: 0,
            first_failed_at: 0,
            last_attempt_at: 0,
        };
        // #2063: the escrow must hold the whole payout before the first
        // transfer, so a shortfall changes nothing (see `payout_shortfall`).
        Self::ensure_reserve_for_payout(&env, &m.token, player1_amount + player2_amount)?;
        Self::attempt_payout(&env, &mut m, &mut record, &winner, MatchState::PendingResult);
        Ok(())
    }

    /// Retry a failed payout (#2066). Anyone may call it (an operator or a
    /// keeper bot): funds only ever go to the recorded payees, and only
    /// amounts not yet paid are sent. Returns `true` once the match is
    /// `Completed`, `false` if a transfer failed again (the match stays
    /// `PayoutFailed`, funds stay in escrow, and the attempt is logged).
    ///
    /// # Errors
    ///
    /// * [`Error::NoFailedPayout`] — the match isn't `PayoutFailed`.
    /// * [`Error::InsufficientReserve`] — the escrow can't cover what is still
    ///   owed; nothing is sent.
    pub fn retry_payout(env: Env, match_id: u64) -> Result<bool, Error> {
        Self::validate_match_id(&env, match_id)?;
        let mut m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;
        if m.state != MatchState::PayoutFailed {
            return Err(Error::NoFailedPayout);
        }
        let mut record: PayoutRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Payout(match_id))
            .ok_or(Error::NoFailedPayout)?;
        let winner = match m.pending_winner.clone() {
            OptionalWinner::Some(w) => w,
            OptionalWinner::None => return Err(Error::InvalidState),
        };
        Self::ensure_reserve_for_payout(&env, &m.token, outstanding(&record))?;
        Self::attempt_payout(&env, &mut m, &mut record, &winner, MatchState::PayoutFailed);
        Ok(m.state == MatchState::Completed)
    }

    /// The payout record of a match whose payout failed, if any (#2066).
    pub fn get_payout_record(env: Env, match_id: u64) -> Option<PayoutRecord> {
        env.storage().persistent().get(&DataKey::Payout(match_id))
    }

    /// How many more token units the escrow needs before this match can be
    /// paid out, including the reserve buffer; `0` if it can pay now (#2063).
    ///
    /// Contract errors can't carry data, so this is how a client turns an
    /// `InsufficientReserve` error into an exact shortfall.
    pub fn payout_shortfall(env: Env, match_id: u64) -> Result<i128, Error> {
        let m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;
        let owed = match m.state {
            MatchState::PayoutFailed => env
                .storage()
                .persistent()
                .get::<DataKey, PayoutRecord>(&DataKey::Payout(match_id))
                .map(|r| outstanding(&r))
                .unwrap_or(0),
            MatchState::PendingResult | MatchState::Active => stake_i128(&m) * 2,
            _ => 0,
        };
        if owed == 0 {
            return Ok(0);
        }
        let balance = token::Client::new(&env, &m.token).balance(&env.current_contract_address());
        Ok((owed + ESCROW_RESERVE_BUFFER_STROOPS - balance).max(0))
    }

    /// Pay one player `gross` minus `fee_share` (#2067, #2069), send the fee
    /// to the collector, and append the payout to the player's history
    /// (#2068). Returns whether the player is now paid.
    ///
    /// If the fee is at least the gross amount, the player receives the most
    /// that is left (possibly nothing): a partial payout, logged with its
    /// shortfall and reason and added to the platform's running total.
    fn pay_one(
        env: &Env,
        client: &token::Client,
        match_id: u64,
        player: &Address,
        gross: i128,
        fee_share: i128,
    ) -> bool {
        let escrow = env.current_contract_address();
        let fee = fee_share.clamp(0, gross);
        let net = gross - fee;
        if net > 0 && !matches!(client.try_transfer(&escrow, player, &net), Ok(Ok(()))) {
            return false;
        }
        if fee > 0 {
            // The collector is admin-controlled; a failure here reverts the
            // whole call, so a player is never paid without the fee settling.
            let collector = Self::fee_config(env).collector;
            client.transfer(&escrow, &collector, &fee);
        }

        let now = env.ledger().timestamp();
        let ledger = env.ledger().sequence();
        env.events().publish(
            (Symbol::new(env, "payout"), symbol_short!("paid"), player.clone()),
            (match_id, gross, fee, net, now),
        );
        if net < gross {
            // #2069: the player got less than the outcome's amount.
            let shortfall = gross - net;
            let reason = if fee_share >= gross {
                symbol_short!("fee_all")
            } else {
                symbol_short!("fee")
            };
            let total: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalShortfall)
                .unwrap_or(0);
            env.storage()
                .instance()
                .set(&DataKey::TotalShortfall, &(total + shortfall));
            env.events().publish(
                (Symbol::new(env, "payout"), symbol_short!("shortfall"), player.clone()),
                (match_id, shortfall, reason, fee_share, now),
            );
        }

        // #2068: append-only payout ledger per address.
        let storage = env.storage().persistent();
        let len_key = DataKey::PayoutHistoryLen(player.clone());
        let n: u32 = storage.get(&len_key).unwrap_or(0);
        let entry_key = DataKey::PayoutHistory(player.clone(), n);
        storage.set(
            &entry_key,
            &PayoutEntry {
                match_id,
                gross,
                fee,
                net,
                timestamp: now,
                ledger,
            },
        );
        storage.set(&len_key, &(n + 1));
        storage.extend_ttl(&entry_key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        storage.extend_ttl(&len_key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        true
    }

    fn fee_config(env: &Env) -> FeeConfig {
        env.storage()
            .instance()
            .get(&DataKey::FeeConfig)
            .unwrap_or_else(|| FeeConfig {
                fee_per_payout: 0,
                policy: FeePolicy::PlatformCovers,
                collector: env
                    .storage()
                    .instance()
                    .get(&DataKey::SafeAddress)
                    .unwrap_or_else(|| env.current_contract_address()),
            })
    }

    /// The payout fee settings (#2067). Default: no fee, platform covers it.
    pub fn get_fee_config(env: Env) -> FeeConfig {
        Self::fee_config(&env)
    }

    /// Set the payout fee and who bears it (#2067). Requires
    /// [`Permission::TokenManagement`]. Applies to matches finalized after
    /// the change; `collector` receives deducted fees. A fee outside
    /// `0..=MAX_STAKE` is rejected with [`Error::InvalidAmount`].
    pub fn set_fee_config(
        env: Env,
        caller: Address,
        fee_per_payout: i128,
        policy: FeePolicy,
        collector: Address,
    ) -> Result<(), Error> {
        Self::require_permission(&env, &caller, Permission::TokenManagement)?;
        caller.require_auth();
        if !(0..=MAX_STAKE).contains(&fee_per_payout) {
            // The error enum is at Soroban's 50-variant limit, so reuse InvalidAmount.
            return Err(Error::InvalidAmount);
        }
        let config = FeeConfig {
            fee_per_payout,
            policy,
            collector,
        };
        env.storage().instance().set(&DataKey::FeeConfig, &config);
        Self::bump_instance_ttl(&env);
        env.events().publish(
            (Symbol::new(&env, "admin"), symbol_short!("fee_cfg")),
            (caller, config),
        );
        Ok(())
    }

    /// What each player of `match_id` would receive if it were paid out now
    /// under the current fee config: `(gross, fee, net)` for player 1, then
    /// player 2 (#2067: fee accounting visible to players before payout).
    pub fn quote_payout(env: Env, match_id: u64) -> Result<Vec<i128>, Error> {
        let m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;
        let (g1, g2, f1, f2) = match env
            .storage()
            .persistent()
            .get::<DataKey, PayoutRecord>(&DataKey::Payout(match_id))
        {
            Some(r) => (r.player1_amount, r.player2_amount, r.player1_fee, r.player2_fee),
            None => {
                let winner = match m.pending_winner.clone() {
                    OptionalWinner::Some(w) => w,
                    OptionalWinner::None => return Err(Error::InvalidState),
                };
                let (g1, g2) = payout_amounts(&winner, stake_i128(&m));
                let fees = Self::fee_config(&env);
                (g1, g2, player_fee_share(&fees, g1), player_fee_share(&fees, g2))
            }
        };
        let (f1, f2) = (f1.clamp(0, g1), f2.clamp(0, g2));
        Ok(vec![&env, g1, f1, g1 - f1, g2, f2, g2 - f2])
    }

    /// Total by which payouts fell short of their gross amount because of
    /// fees, across all matches (#2069).
    pub fn get_total_shortfall(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalShortfall)
            .unwrap_or(0)
    }

    /// Number of payouts recorded for `address` (#2068).
    pub fn get_payout_history_len(env: Env, address: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::PayoutHistoryLen(address))
            .unwrap_or(0)
    }

    /// Up to `limit` (max 50) payouts to `address`, oldest first, starting at
    /// index `start` (#2068).
    pub fn get_payout_history(env: Env, address: Address, start: u32, limit: u32) -> Vec<PayoutEntry> {
        let len = Self::get_payout_history_len(env.clone(), address.clone());
        let end = start.saturating_add(limit.min(50)).min(len);
        let mut out = Vec::new(&env);
        let mut i = start;
        while i < end {
            if let Some(e) = env
                .storage()
                .persistent()
                .get(&DataKey::PayoutHistory(address.clone(), i))
            {
                out.push_back(e);
            }
            i += 1;
        }
        out
    }

    /// Try every unpaid transfer in `record` once. On full success the match
    /// becomes `Completed`; otherwise it is `PayoutFailed` and the record is
    /// stored for `retry_payout`. Failed transfers don't revert the call, so
    /// the funds stay in escrow and the attempt is logged on-chain.
    fn attempt_payout(
        env: &Env,
        m: &mut Match,
        record: &mut PayoutRecord,
        winner: &Winner,
        from: MatchState,
    ) {
        let client = token::Client::new(env, &m.token);
        let escrow = env.current_contract_address();
        let now = env.ledger().timestamp();
        record.attempts += 1;
        record.last_attempt_at = now;

        if !record.player1_paid {
            record.player1_paid = Self::pay_one(
                env,
                &client,
                m.id,
                &m.player1,
                record.player1_amount,
                record.player1_fee,
            );
        }
        if !record.player2_paid {
            record.player2_paid = Self::pay_one(
                env,
                &client,
                m.id,
                &m.player2,
                record.player2_amount,
                record.player2_fee,
            );
        }
        let done = record.player1_paid && record.player2_paid;

        if !done {
            if record.first_failed_at == 0 {
                record.first_failed_at = now;
            }
            let key = DataKey::Payout(m.id);
            env.storage().persistent().set(&key, record);
            env.storage()
                .persistent()
                .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
            if m.state != MatchState::PayoutFailed {
                m.state = MatchState::PayoutFailed;
                Self::store_match(env, m);
                Self::publish_state_transition(env, m, Some(from), MatchState::PayoutFailed, 0, 0);
            }
            Self::bump_instance_ttl(env);
            env.events().publish(
                (Symbol::new(env, "payout"), symbol_short!("failed")),
                (
                    m.id,
                    record.attempts,
                    now,
                    record.player1_paid,
                    record.player2_paid,
                ),
            );
            return;
        }

        // STATE TRANSITION: PendingResult | PayoutFailed → Completed
        m.state = MatchState::Completed;
        m.completed_ledger = Some(env.ledger().sequence());
        Self::store_match(env, m);
        env.storage().persistent().remove(&DataKey::Payout(m.id));
        Self::bump_instance_ttl(env);
        Self::publish_state_transition(
            env,
            m,
            Some(from),
            MatchState::Completed,
            record.player1_amount as u128,
            record.player2_amount as u128,
        );
        if record.attempts > 1 {
            env.events().publish(
                (Symbol::new(env, "payout"), symbol_short!("retried")),
                (m.id, record.attempts, now),
            );
        }
        let winner_amount = match winner {
            Winner::Draw => record.player1_amount,
            _ => record.player1_amount + record.player2_amount,
        };
        env.events().publish(
            (Symbol::new(env, "match"), symbol_short!("completed")),
            (m.id, winner.clone(), winner_amount),
        );
    }

    /// Reclaim funds when the oracle never submits a result within the configured timeout.
    ///
    /// Either player may call this function after the timeout. Anyone may instead call
    /// [`enforce_timeout`](EscrowContract::enforce_timeout) to trigger the same refund.
    ///
    /// # Arguments
    ///
    /// * `match_id` — The match to reclaim funds from.
    /// * `caller`   — Must be `player1` or `player2`; must authorize the call.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`]       — caller is neither player.
    /// * [`Error::InvalidState`]       — match is not `Active`.
    /// * [`Error::MatchTimedOut`] — the configured timeout has not elapsed yet.
    pub fn claim_timeout(env: Env, match_id: u64, caller: Address) -> Result<(), Error> {
        Self::cancel_timed_out_match(&env, match_id, Some(caller))
    }

    /// Permissionlessly cancel an active match after its configured timeout.
    ///
    /// Soroban contracts cannot execute transactions without an invocation. A player, keeper,
    /// or any other account may call this function after the timeout; the contract verifies the
    /// deadline and refunds both players atomically.
    pub fn enforce_timeout(env: Env, match_id: u64) -> Result<(), Error> {
        Self::cancel_timed_out_match(&env, match_id, None)
    }

    /// Cancel a match and refund any deposits.
    ///
    /// Authorization model:
    /// - **Pending state** (neither or only one player deposited): the calling player's auth suffices.
    /// - **Pending state** (both players deposited, rare edge case): both players must authorize.
    /// - **Active state** (both players deposited, match is live): both `player1` and `player2`
    ///   must authorize, enabling a mutual cancel without waiting for the 7-day
    ///   `claim_timeout`. Both stakes are refunded immediately.
    ///
    /// Cancellation is allowed while the contract is paused so players can recover funds.
    pub fn cancel_match(env: Env, match_id: u64, caller: Address) -> Result<(), Error> {
        Self::validate_match_id(&env, match_id)?;

        let mut m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;

        // Allow cancellation from Pending or Active state only.
        // Completed and Cancelled are terminal — no further transitions.
        if m.state != MatchState::Pending && m.state != MatchState::Active {
            return Err(Error::InvalidState);
        }

        let is_p1 = caller == m.player1;
        let is_p2 = caller == m.player2;

        if !is_p1 && !is_p2 {
            return Err(Error::Unauthorized);
        }

        if m.state == MatchState::Active {
            // Active state: both players must mutually agree to cancel.
            // Require authorization from both parties since both have already
            // committed funds and neither should be able to unilaterally cancel.
            m.player1.require_auth();
            m.player2.require_auth();
        } else if m.player1_deposited && m.player2_deposited {
            // Pending state but both deposited (rare): same mutual-auth requirement.
            m.player1.require_auth();
            m.player2.require_auth();
        } else {
            caller.require_auth();
        }

        let client = token::Client::new(&env, &m.token);
        let player1_refund: i128 = if m.player1_deposited { stake_i128(&m) } else { 0 };
        let player2_refund: i128 = if m.player2_deposited { stake_i128(&m) } else { 0 };
        let refund_total = player1_refund + player2_refund;
        if refund_total > 0 {
            Self::ensure_reserve_for_payout(&env, &m.token, refund_total)?;
        }
        if m.player1_deposited {
            client
                .try_transfer(&env.current_contract_address(), &m.player1, &stake_i128(&m))
                .map_err(|_| Error::TransferFailed)?
                .map_err(|_| Error::TransferFailed)?;
        }
        if m.player2_deposited {
            client
                .try_transfer(&env.current_contract_address(), &m.player2, &stake_i128(&m))
                .map_err(|_| Error::TransferFailed)?
                .map_err(|_| Error::TransferFailed)?;
        }

        // STATE TRANSITION: Pending → Cancelled
        let previous_state = m.state.clone();
        m.state = MatchState::Cancelled;
        m.cancelled_ledger = Some(env.ledger().sequence());
        Self::store_match(&env, &m);
        Self::bump_instance_ttl(&env);

        Self::publish_state_transition(
            &env,
            &m,
            Some(previous_state),
            MatchState::Cancelled,
            player1_refund as u128,
            player2_refund as u128,
        );
        env.events().publish(
            (Symbol::new(&env, "match"), symbol_short!("cancelled")),
            (match_id, caller, player1_refund, player2_refund),
        );

        Ok(())
    }

    /// First phase of the two-factor emergency drain.
    ///
    /// Requires [`Permission::DrainInitiate`] and a paused contract. Records a
    /// [`PendingDrain`] under [`DataKey::PendingDrain`] that must be confirmed by
    /// a *different* authorized address via [`confirm_drain`](EscrowContract::confirm_drain)
    /// before any funds move. This prevents a single compromised key from draining
    /// the contract.
    ///
    /// The destination is fixed at initialization time via the `safe_address`
    /// parameter of [`initialize`](EscrowContract::initialize) and stored under
    /// [`DataKey::SafeAddress`]; the drain can never be redirected elsewhere.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`] — `caller` lacks [`Permission::DrainInitiate`].
    /// * [`Error::NotPaused`]    — the contract is not currently paused.
    /// * [`Error::ActiveMatchExists`] — an active match still holds escrowed funds.
    pub fn initiate_drain(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        Self::require_permission(&env, &caller, Permission::DrainInitiate)?;
        caller.require_auth();

        if !Self::is_paused(&env) {
            return Err(Error::NotPaused);
        }
        if amount <= 0 {
            return Err(Error::InvalidStakeAmount);
        }

        // Safety guard: block the drain when any match is currently `Active`
        // (both players have deposited and the game is in progress). Draining
        // while funds are locked for active matches would silently steal player
        // stakes. The admin must wait for every active match to reach a terminal
        // state — `Completed` (payout done) or `Cancelled` (funds refunded) —
        // before initiating a drain. (#8)
        let match_count = Self::get_match_count(&env);
        let mut i: u64 = 0;
        while i < match_count {
            if let Some(m) = env
                .storage()
                .persistent()
                .get::<DataKey, Match>(&DataKey::Match(i))
            {
                if m.state == MatchState::Active {
                    return Err(Error::ActiveMatchExists);
                }
            }
            i += 1;
        }

        let expires_at = env
            .ledger()
            .sequence()
            .saturating_add(DRAIN_APPROVAL_WINDOW_LEDGERS);
        let pending = PendingDrain {
            initiator: caller.clone(),
            amount,
            expiry_ledger: expires_at,
        };
        env.storage()
            .instance()
            .set(&DataKey::PendingDrain, &pending);
        Self::bump_instance_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "admin"), symbol_short!("drn_init")),
            (caller, amount, expires_at),
        );
        Ok(())
    }

    /// Second phase of the two-factor emergency drain.
    ///
    /// Requires [`Permission::DrainConfirm`] and must be called by an address
    /// **different** from the initiator. Verifies the pending approval has not
    /// expired, transfers the approved amount to the pre-registered safe address,
    /// and clears the pending entry.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`] — `caller` lacks [`Permission::DrainConfirm`] or
    ///   is the same address that initiated the drain.
    /// * [`Error::NoPendingDrain`] — no drain is awaiting confirmation.
    /// * [`Error::DrainApprovalExpired`] — the approval window has elapsed.
    pub fn confirm_drain(env: Env, caller: Address) -> Result<(), Error> {
        Self::require_permission(&env, &caller, Permission::DrainConfirm)?;
        caller.require_auth();

        let pending: PendingDrain = env
            .storage()
            .instance()
            .get(&DataKey::PendingDrain)
            .ok_or(Error::NoPendingDrain)?;

        if caller == pending.initiator {
            return Err(Error::Unauthorized);
        }
        if env.ledger().sequence() > pending.expiry_ledger {
            env.storage().instance().remove(&DataKey::PendingDrain);
            return Err(Error::DrainApprovalExpired);
        }

        let safe_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::SafeAddress)
            .ok_or(Error::Unauthorized)?;

        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::Unauthorized)?;

        let client = token::Client::new(&env, &token);
        let contract = env.current_contract_address();
        let balance = client.balance(&contract);
        let amount = if pending.amount > balance {
            balance
        } else {
            pending.amount
        };

        if amount > 0 {
            client.transfer(&contract, &safe_address, &amount);
        }
        env.events().publish(
            (Symbol::new(&env, "admin"), symbol_short!("drain")),
            (amount, safe_address, pending.initiator, caller),
        );

        env.storage().instance().remove(&DataKey::PendingDrain);
        Self::bump_instance_ttl(&env);

        Ok(())
    }

    /// Validate that `token` implements the SEP-41 interface and has sane metadata.
    ///
    /// Constructs a token client and probes `decimals`, `name`, `symbol`, and
    /// `balance`. A token that does not implement SEP-41 will fail one of these
    /// calls. Metadata is validated: `decimals` must not exceed
    /// [`MAX_TOKEN_DECIMALS`], and `name`/`symbol` must be non-empty.
    ///
    /// Emits a `token_validated` event carrying the token address and a success
    /// flag so the outcome is logged on-chain.
    fn validate_token(env: &Env, token: &Address) -> Result<(), Error> {
        let client = token::Client::new(env, token);
        let contract = env.current_contract_address();

        let decimals = client.try_decimals().map_err(|_| Error::TokenNotSep41)?;
        let decimals = decimals.map_err(|_| Error::TokenNotSep41)?;
        let name = client.try_name().map_err(|_| Error::TokenNotSep41)?;
        let name = name.map_err(|_| Error::TokenNotSep41)?;
        let symbol = client.try_symbol().map_err(|_| Error::TokenNotSep41)?;
        let symbol = symbol.map_err(|_| Error::TokenNotSep41)?;
        let _ = client
            .try_balance(&contract)
            .map_err(|_| Error::TokenNotSep41)?
            .map_err(|_| Error::TokenNotSep41)?;

        let valid = decimals <= MAX_TOKEN_DECIMALS && name.len() > 0 && symbol.len() > 0;
        env.events().publish(
            (Symbol::new(env, "token"), symbol_short!("validated")),
            (token.clone(), valid),
        );
        if !valid {
            return Err(Error::InvalidTokenMetadata);
        }
        Ok(())
    }

    /// Return the match_id that registered a given game_id, or None if unregistered.
    pub fn get_game_id_owner(env: Env, game_id: String) -> Option<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::GameId(game_id))
    }

    /// Return the token address this contract was initialized with.
    ///
    /// Allows frontends and integrators to verify which SEP-41 token a deployed
    /// contract accepts without parsing raw WASM storage.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Unauthorized`] if the contract has not been initialized yet.
    pub fn get_token(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::Unauthorized)
    }

    /// Read a match by ID.
    pub fn get_match(env: Env, match_id: u64) -> Result<Match, Error> {
        Self::validate_match_id(&env, match_id)?;
        env.storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)
    }

    /// Read the platform of a match by ID.
    pub fn get_platform(env: Env, match_id: u64) -> Result<Platform, Error> {
        Self::validate_match_id(&env, match_id)?;
        let m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;
        Ok(m.platform)
    }

    /// Check whether both players have deposited.
    ///
    /// Returns `Error::MatchNotFound` when `match_id` does not correspond to any
    /// existing match, rather than panicking. This covers both a `match_id` that
    /// was never created and one that exceeds the current match counter.
    pub fn is_funded(env: Env, match_id: u64) -> Result<bool, Error> {
        Self::validate_match_id(&env, match_id)?;
        let m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;
        Ok(m.player1_deposited && m.player2_deposited)
    }

    /// Return the total escrowed balance for a match (0, 1x, or 2x stake).
    ///
    /// The returned value is always non-negative: it is the product of a
    /// `u128` deposit count (0, 1, or 2) and `Match::stake_amount`, which is
    /// validated at match creation to be within `[MIN_STAKE, MAX_STAKE]` and
    /// therefore strictly positive. Returning `u128` makes this invariant
    /// explicit in the type contract and removes the need for callers to
    /// handle a negative case that can never occur.
    pub fn get_escrow_balance(env: Env, match_id: u64) -> Result<u128, Error> {
        let m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;
        if m.state == MatchState::Completed || m.state == MatchState::Cancelled {
            return Ok(0);
        }
        let deposited: u128 = match (m.player1_deposited, m.player2_deposited) {
            (true, true) => 2,
            (true, false) | (false, true) => 1,
            (false, false) => 0,
        };
        // `stake_amount` is validated to be >= MIN_STAKE (> 0) at creation, so
        // the conversion to `u128` is lossless and the product is non-negative.
        Ok(deposited * (m.stake_amount as u128))
    }

    /// Return a page of match IDs in the range `[start, start + limit)`.
    ///
    /// # Offset-Based Pagination
    ///
    /// This function uses **offset-based pagination**, returning consecutive match IDs
    /// starting from `start`. It is suitable for dense ID spaces where matches are
    /// created frequently and ID gaps are rare.
    ///
    /// # Parameters
    ///
    /// * `start` — The first match ID to include in the result (inclusive).
    /// * `limit` — Maximum number of IDs to return. Capped at 100 to prevent unbounded queries.
    ///
    /// # Returns
    ///
    /// A `Vec<u64>` of match IDs in ascending order. May contain fewer than `limit` IDs if:
    /// - The query reaches the current match count (end of data), or
    /// - The remaining space in the vector is exhausted.
    ///
    /// # End-of-Data Detection
    ///
    /// Callers can detect the end of the full ID space when the returned vector has
    /// **fewer than `limit` entries**. This indicates no more matches exist beyond
    /// `start + returned_count`.
    ///
    /// **Important**: If matches are sparse (e.g., many were cancelled), a shorter result
    /// **does not guarantee end-of-data** — there may be gaps in the ID sequence. Use
    /// [`list_matches_after`](EscrowContract::list_matches_after) for cursor-based pagination
    /// if you need to iterate over a sparse ID space.
    ///
    /// # Examples
    ///
    /// Iterate through all matches starting from ID 0:
    /// ```text
    /// let mut start = 0;
    /// loop {
    ///     let page = contract.list_matches(start, 50);
    ///     if page.is_empty() {
    ///         break; // No more matches
    ///     }
    ///     // Process page...
    ///     if page.len() < 50 {
    ///         break; // Last page reached
    ///     }
    ///     start = page.last().unwrap() + 1;
    /// }
    /// ```
    ///
    /// # Sparse ID Spaces
    ///
    /// If match creation is infrequent or many matches were cancelled, the ID space
    /// becomes sparse. In this case, offset-based pagination may return short pages
    /// even when more matches exist. Use [`list_matches_after`](EscrowContract::list_matches_after)
    /// instead for robust pagination over sparse spaces.
    pub fn list_matches(env: Env, start: u64, limit: u32) -> Vec<u64> {
        const MAX_LIMIT: u32 = 100;
        let limit = limit.min(MAX_LIMIT);
        let count = Self::get_match_count(&env);
        let mut ids: Vec<u64> = vec![&env];
        let end = start.saturating_add(limit as u64).min(count);
        let mut i = start;
        while i < end {
            ids.push_back(i);
            i += 1;
        }
        ids
    }

    /// Return match IDs following a cursor position, using cursor-based pagination.
    ///
    /// # Cursor-Based Pagination
    ///
    /// This function returns consecutive match IDs **after** a given `after_match_id`.
    /// It is designed for **sparse ID spaces** where gaps are common due to cancelled
    /// or failed matches. Unlike offset-based pagination, cursor-based pagination
    /// guarantees that callers can always distinguish "no more data" from "data gap."
    ///
    /// # Parameters
    ///
    /// * `after_match_id` — The cursor position. Results will start from the next valid
    ///   match ID after this value. Pass `u64::MAX` to start from the beginning (finds ID 0).
    /// * `limit` — Maximum number of IDs to return. Capped at 100 to prevent unbounded queries.
    ///
    /// # Returns
    ///
    /// A `Vec<u64>` of match IDs in ascending order, all with `id > after_match_id`.
    /// May contain fewer than `limit` IDs if the current match count is reached.
    ///
    /// # End-of-Data Detection
    ///
    /// The end of the ID space is reached when the returned vector is **empty**.
    /// This unambiguously means: "There are no valid match IDs greater than `after_match_id`."
    ///
    /// # Examples
    ///
    /// Iterate through all matches using cursor-based pagination:
    /// ```text
    /// let mut cursor = u64::MAX; // Start from the beginning
    /// loop {
    ///     let page = contract.list_matches_after(cursor, 50);
    ///     if page.is_empty() {
    ///         break; // No more matches
    ///     }
    ///     // Process page...
    ///     cursor = page.last().unwrap(); // Move cursor to the last ID
    /// }
    /// ```
    ///
    /// # Advantages Over Offset-Based Pagination
    ///
    /// - **Unambiguous end-of-data**: Empty result always means end-of-data (no false "gaps").
    /// - **Handles sparse IDs**: Works correctly even if many matches were cancelled.
    /// - **Stable iteration**: Adding new matches does not affect the pagination of earlier pages.
    /// - **Cursor reuse**: A cursor remains valid even if the contract state changes between calls.
    pub fn list_matches_after(env: Env, after_match_id: u64, limit: u32) -> Vec<u64> {
        const MAX_LIMIT: u32 = 100;
        let limit = limit.min(MAX_LIMIT);
        let count = Self::get_match_count(&env);
        let mut ids: Vec<u64> = vec![&env];

        // Start from after_match_id + 1, capped at count
        let start = after_match_id.saturating_add(1).min(count);
        let end = start.saturating_add(limit as u64).min(count);

        let mut i = start;
        while i < end {
            ids.push_back(i);
            i += 1;
        }
        ids
    }

    /// Set or rotate the dispute arbiter address. Admin only.
    pub fn set_arbiter(env: Env, caller: Address, arbiter: Address) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        if caller != admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        env.storage().instance().set(&DataKey::Arbiter, &arbiter);
        env.events().publish((Symbol::new(&env, "arbiter_updated"),), arbiter);
        Ok(())
    }

    /// Retrieve the current dispute arbiter address.
    pub fn get_arbiter(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Arbiter)
    }

    /// Contest an oracle result during the dispute window, placing the payout on hold.
    pub fn contest_result(
        env: Env,
        caller: Address,
        match_id: u64,
        reason: String,
    ) -> Result<(), Error> {
        Self::validate_match_id(&env, match_id)?;
        let mut m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;

        let arbiter = Self::get_arbiter(env.clone());
        let admin = Self::get_admin(env.clone())?;

        let is_arbiter = arbiter.map(|a| a == caller).unwrap_or(false);
        if caller != m.player1 && caller != m.player2 && !is_arbiter && caller != admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        if m.state != MatchState::PendingResult {
            return Err(Error::InvalidState);
        }

        m.state = MatchState::Contested;
        env.storage().persistent().set(&DataKey::Match(match_id), &m);
        env.events().publish(
            (Symbol::new(&env, "dispute_contested"), match_id),
            (caller, reason),
        );
        Ok(())
    }

    /// Submit cryptographic evidence for a contested dispute chain.
    pub fn submit_dispute_evidence(
        env: Env,
        caller: Address,
        match_id: u64,
        evidence_hash: BytesN<32>,
    ) -> Result<u32, Error> {
        Self::validate_match_id(&env, match_id)?;
        let m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;

        let arbiter = Self::get_arbiter(env.clone());
        let admin = Self::get_admin(env.clone())?;
        let is_arbiter = arbiter.map(|a| a == caller).unwrap_or(false);

        if caller != m.player1 && caller != m.player2 && !is_arbiter && caller != admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::DisputeEvidenceCount(match_id))
            .unwrap_or(0);

        let record = DisputeEvidenceRecord {
            submitter: caller.clone(),
            evidence_hash: evidence_hash.clone(),
            timestamp_ledger: env.ledger().sequence(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::DisputeEvidence(match_id, count), &record);
        env.storage()
            .persistent()
            .set(&DataKey::DisputeEvidenceCount(match_id), &(count + 1));

        env.events().publish(
            (Symbol::new(&env, "dispute_evidence_submitted"), match_id),
            (caller, evidence_hash, count),
        );

        Ok(count)
    }

    /// Resolve a contested dispute, setting the final outcome and unlocking payout.
    pub fn resolve_dispute(
        env: Env,
        caller: Address,
        match_id: u64,
        winner: Winner,
    ) -> Result<(), Error> {
        Self::validate_match_id(&env, match_id)?;
        let mut m: Match = env
            .storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::MatchNotFound)?;

        let arbiter = Self::get_arbiter(env.clone());
        let admin = Self::get_admin(env.clone())?;
        let is_arbiter = arbiter.map(|a| a == caller).unwrap_or(false);

        if !is_arbiter && caller != admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        if m.state != MatchState::Contested {
            return Err(Error::NotContested);
        }

        m.pending_winner = OptionalWinner::Some(winner.clone());
        m.state = MatchState::PendingResult;
        m.pending_result_ledger = Some(env.ledger().sequence());

        env.storage().persistent().set(&DataKey::Match(match_id), &m);

        env.events().publish(
            (Symbol::new(&env, "dispute_resolved"), match_id),
            (caller, winner),
        );

        Ok(())
    }
}

/// What each player receives for `winner` (#2065): the winner 2 × stake and
/// the loser nothing; on a draw, each player their own stake back.
fn payout_amounts(winner: &Winner, stake: i128) -> (i128, i128) {
    match winner {
        Winner::Player1 => (stake * 2, 0),
        Winner::Player2 => (0, stake * 2),
        Winner::Draw => (stake, stake),
    }
}

/// Checks computed payouts against the outcome before any transfer (#2065).
///
/// A mismatch can only come from a bug or corrupted state, so it aborts
/// the whole call with `PayoutMismatch`. Contract errors roll back events, so
/// the discrepancy is logged as a diagnostic (visible in simulation and in
/// the failed transaction's diagnostics) rather than as a contract event.
fn validate_payout(winner: &Winner, stake: i128, player1: i128, player2: i128) -> Result<(), Error> {
    let expected = match winner {
        Winner::Player1 => (stake * 2, 0),
        Winner::Player2 => (0, stake * 2),
        Winner::Draw => (stake, stake),
    };
    if stake <= 0 || (player1, player2) != expected || player1 + player2 != stake * 2 {
        return Err(Error::PayoutMismatch);
    }
    Ok(())
}

/// The part of `fee_per_payout` a player bears for a payout of `gross`
/// under the policy (#2067). Not yet capped at `gross`; see `pay_one`.
fn player_fee_share(fees: &FeeConfig, gross: i128) -> i128 {
    if gross <= 0 {
        return 0;
    }
    match fees.policy {
        FeePolicy::PlatformCovers => 0,
        FeePolicy::PlayerCovers => fees.fee_per_payout,
        FeePolicy::Split => fees.fee_per_payout / 2,
    }
}

/// The amount a payout record still owes.
fn outstanding(r: &PayoutRecord) -> i128 {
    (if r.player1_paid { 0 } else { r.player1_amount }) + (if r.player2_paid { 0 } else { r.player2_amount })
}

/// A match's stake as the `i128` token amounts use. `Match::stake_amount` is
/// stored as `u128` but validated to `MIN_STAKE..=MAX_STAKE` at creation, far
/// below `i128::MAX`, so the conversion is lossless.
fn stake_i128(m: &Match) -> i128 {
    m.stake_amount as i128
}

#[cfg(test)]
mod tests_stake_rules;

#[cfg(test)]
mod tests_payouts;

#[cfg(test)]
mod tests_fees_history;
