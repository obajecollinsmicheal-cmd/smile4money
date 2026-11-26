use soroban_sdk::contracterror;

pub use smile4money_common::SharedError;

/// Errors returned by the escrow contract.
///
/// Variants shared with the oracle contract (same semantic meaning, same numeric code)
/// are also defined in [`smile4money_common::SharedError`]. The [`From<SharedError>`]
/// implementation allows propagating shared errors with the `?` operator.
///
/// Each variant carries a stable numeric code (the discriminant) that is
/// encoded on-chain and surfaced to clients. Do **not** renumber existing
/// variants — doing so is a breaking change for any client that inspects the
/// raw error code.
///
/// # Error code table
///
/// | Code | Variant               | Shared? | Meaning                                              |
/// |------|-----------------------|---------|------------------------------------------------------|
/// |  1   | MatchNotFound         |         | No match exists for the given match_id               |
/// |  2   | AlreadyFunded         |         | The calling player has already deposited for this match |
/// |  3   | NotFunded             |         | submit_result called before both players deposited   |
/// |  4   | Unauthorized          | ✓       | Caller is not permitted to perform this action       |
/// |  5   | InvalidState          |         | Operation is not valid in the match's current state  |
/// |  6   | AlreadyExists         |         | A match with this ID already exists (counter collision) |
/// |  7   | AlreadyInitialized    | ✓       | Contract has already been initialized                |
/// |  8   | Overflow              |         | Match ID counter would overflow u64                  |
/// |  9   | ContractPaused        |         | Contract is paused; mutating operations are blocked  |
/// | 10   | InvalidAmount         | ✓       | stake_amount must be greater than zero               |
/// | 11   | InvalidGameId         | ✓       | game_id is empty or exceeds the 64-byte maximum      |
/// | 12   | InvalidPlayers        |         | player1 and player2 must be different addresses      |
/// | 13   | GameIdMismatch        |         | Oracle submitted a result for the wrong game_id      |
/// | 14   | DuplicateGameId       |         | game_id is already linked to another match           |
/// | 15   | TransferFailed        | ✓       | token transfer failed                                |
/// | 16   | MatchCancelled        |         | deposit rejected: match has been cancelled           |
/// | 17   | MatchCompleted        |         | deposit rejected: match has already completed        |
/// | 18   | NotPaused             |         | emergency_drain requires the contract to be paused   |
/// | 19   | InsufficientAllowance |         | player has not approved sufficient token allowance   |
/// | 20   | DisputeWindowActive   |         | finalize_result called before the dispute window has expired |
/// | 21   | MatchTimedOut         |         | match has timed out; enforce_timeout can refund players |
/// | 22   | InvalidToken          |         | the provided token address does not match the initialized token |
/// | 23   | InvalidAdmin          | ✓       | the new admin address is invalid                     |
/// | 24   | StakeTooLow           |         | stake_amount is below the minimum allowed stake      |
/// | 25   | StakeTooHigh          |         | stake_amount exceeds the maximum allowed stake       |
/// | 26   | InsufficientReserve   |         | contract balance too low to cover payout + Stellar minimum reserve |
/// | 27   | InvalidAddress        |         | a player address is invalid (zero address / burn address) |
/// | 28   | DisputeWindowExpired  |         | override_result called after the dispute window expired |
/// | 35   | TimeoutNotReached     |         | active match timeout has not elapsed yet          |
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    /// [E001] No match exists for the given `match_id`.
    MatchNotFound = 1,

    /// [E002] The calling player has already deposited their stake for this match.
    AlreadyFunded = 2,

    /// [E003] `submit_result` was called before both players have deposited.
    NotFunded = 3,

    /// [E004] Caller is not the oracle, admin, or an authorised player for this operation.
    /// **Shared** — same code as [`SharedError::Unauthorized`].
    Unauthorized = 4,

    /// [E005] The requested operation is not valid in the match's current `MatchState`.
    InvalidState = 5,

    /// [E006] A match record already exists at this ID (internal counter collision).
    AlreadyExists = 6,

    /// [E007] `initialize` has already been called; the contract cannot be re-initialized.
    /// **Shared** — same code as [`SharedError::AlreadyInitialized`].
    AlreadyInitialized = 7,

    /// [E008] The match ID counter has reached `u64::MAX` and cannot be incremented safely.
    Overflow = 8,

    /// [E009] The contract is paused by the admin. `create_match`, `deposit`, and
    /// `submit_result` are blocked until `unpause` is called.
    ContractPaused = 9,

    /// [E010] `stake_amount` must be a positive integer greater than zero.
    /// **Shared** — same code as [`SharedError::InvalidAmount`].
    InvalidAmount = 10,

    /// [E011] `game_id` is empty or exceeds the 64-byte maximum length.
    /// **Shared** — same code as [`SharedError::InvalidGameId`].
    InvalidGameId = 11,

    /// [E012] `player1` and `player2` must be different addresses.
    InvalidPlayers = 12,

    /// [E013] The oracle submitted a result whose `game_id` does not match the stored game_id.
    GameIdMismatch = 13,

    /// [E014] The provided `game_id` is already linked to an existing match.
    DuplicateGameId = 14,

    /// [E015] Token transfer failed.
    /// **Shared** — same code as [`SharedError::TransferFailed`].
    TransferFailed = 15,

    /// [E016] Deposit rejected because the match has been cancelled.
    MatchCancelled = 16,

    /// [E017] Deposit rejected because the match has already completed.
    MatchCompleted = 17,

    /// [E018] emergency_drain requires the contract to be paused first.
    NotPaused = 18,

    /// [E019] The player has not approved sufficient token allowance for the contract.
    InsufficientAllowance = 19,

    /// [E020] `finalize_result` was called before the dispute window has fully elapsed.
    DisputeWindowActive = 20,

    /// [E021] The match has timed out; call `enforce_timeout` to refund the players.
    MatchTimedOut = 21,

    /// [E022] The provided token address does not match the token set during `initialize`.
    InvalidToken = 22,

    /// [E023] The new admin address is invalid (e.g. zero address or same as current admin).
    /// **Shared** — same code as [`SharedError::InvalidAdmin`].
    InvalidAdmin = 23,

    /// [E024] `stake_amount` is below the minimum allowed stake (`MIN_STAKE`).
    StakeTooLow = 24,

    /// [E025] `stake_amount` exceeds the maximum allowed stake (`MAX_STAKE`).
    StakeTooHigh = 25,

    /// [E026] The contract's token balance would fall below the required Stellar minimum reserve.
    InsufficientReserve = 26,

    /// [E027] One of the player addresses is invalid (e.g. zero address / burn address).
    InvalidAddress = 27,

    /// [E028] The token is not on the admin-managed allowlist.
    ///
    /// Returned by `create_match` when the requested token has never been
    /// allowlisted, or was allowlisted and later removed. This is the check
    /// that stops a caller from escrowing an arbitrary SEP-41 contract.
    TokenNotAllowlisted = 28,

    /// [E029] `add_token` was called for a token that is already allowlisted.
    ///
    /// A distinct error rather than a silent no-op, so a misconfigured
    /// deployment script fails loudly instead of appearing to have added the
    /// same token twice.
    TokenAlreadyListed = 29,

    /// [E030] `remove_token` was called for a token that is not allowlisted.
    TokenNotListed = 30,

    /// [E031] `remove_token` was called for the contract's default token.
    ///
    /// The default token set at `initialize` cannot be removed. Otherwise the
    /// contract could be left with no acceptable token at all, and every
    /// subsequent `create_match` — including one that omits the token argument
    /// and so falls back to the default — would fail with no way to recover
    /// short of a contract upgrade.
    CannotRemoveDefault = 31,

    /// [E032] `stake_amount` is exactly zero.
    ///
    /// A match staked at zero has no economic value and would produce zero-value
    /// token transfers. This is a distinct variant from [`StakeTooLow`] (which
    /// covers values strictly between 0 and `MIN_STAKE`) so callers can
    /// distinguish "no stake at all" from "stake below the configured minimum".
    InvalidStakeAmount = 32,

    /// [E033] `emergency_drain()` was called while at least one match is in the
    /// `Active` state.
    ///
    /// Draining while funds are locked for active matches would silently steal
    /// player stakes. Wait for all in-flight matches to reach a terminal state
    /// (`Completed` or `Cancelled`) before calling `emergency_drain`.
    ActiveMatchExists = 33,

    /// [E034] `override_result` was called after the dispute window expired.
    DisputeWindowExpired = 34,

    /// [E035] Operation rejected because the match is contested under dispute.
    DisputeActive = 35,

    /// [E036] Caller is not the designated arbiter.
    NotArbiter = 36,

    /// [E037] Match is not in a contested state.
    NotContested = 37,

    /// [E038] The contract has not been initialized.
    NotInitialized = 38,

    /// [E039] `claim_timeout` was called before the match timed out.
    TimeoutNotReached = 39,

    /// [E040] `confirm_drain` was called with no drain pending.
    NoPendingDrain = 40,

    /// [E041] The pending drain's approval window has passed.
    DrainApprovalExpired = 41,

    /// [E042] The drain confirmer is the same address that initiated it.
    SameSignerNotAllowed = 42,

    /// [E043] The token does not implement the SEP-41 interface.
    TokenNotSep41 = 43,

    /// [E044] The token's metadata (decimals, name, symbol) fails validation.
    InvalidTokenMetadata = 44,

    /// [E045] The caller's role does not grant the required permission.
    ///
    /// **Shared** variant, but escrow already uses code 35 (`DisputeActive`),
    /// so it maps to 45 here.
    InsufficientPermission = 45,

    /// [E046] The game ID doesn't match its platform's format: 8 alphanumeric
    /// characters for Lichess, 1-20 digits (no leading zero) for Chess.com.
    InvalidGameIdFormat = 46,

    /// [E047] `set_stake_limits` was given a range that isn't
    /// `0 < min <= max <= MAX_STAKE`.
    InvalidStakeLimits = 47,
}

/// Convert a [`SharedError`] into an escrow [`Error`].
///
/// This enables the `?` operator when calling helper functions that return
/// `Result<_, SharedError>`, propagating them as the equivalent local variant.
impl From<SharedError> for Error {
    fn from(e: SharedError) -> Self {
        match e {
            SharedError::Unauthorized => Error::Unauthorized,
            SharedError::AlreadyInitialized => Error::AlreadyInitialized,
            SharedError::InvalidAmount => Error::InvalidAmount,
            SharedError::InvalidGameId => Error::InvalidGameId,
            SharedError::TransferFailed => Error::TransferFailed,
            SharedError::InvalidAdmin => Error::InvalidAdmin,
            SharedError::InsufficientPermission => Error::InsufficientPermission,
            SharedError::TokenNotSep41 => Error::TokenNotSep41,
            SharedError::InvalidTokenMetadata => Error::InvalidTokenMetadata,
        }
    }
}
