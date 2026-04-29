use soroban_sdk::{contracttype, Address, String};

/// Represents the lifecycle state of a chess match held in escrow.
///
/// State transitions follow a strict directed graph — only the paths listed
/// below are valid. Any other transition is rejected with
/// [`Error::InvalidState`](crate::errors::Error::InvalidState).
///
/// ```text
/// (none) ──create_match──► Pending
///                              │
///              ┌───────────────┤
///              │               │
///         cancel_match    both deposits
///              │               │
///              ▼               ▼
///          Cancelled        Active
///                              │
///                        submit_result
///                              │
///                              ▼
///                          Completed
/// ```
///
/// `Cancelled` and `Completed` are **terminal states** — once reached, no
/// further transitions are possible.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MatchState {
    /// The match has been created by `create_match` but at least one player
    /// has not yet deposited their stake.
    ///
    /// Valid transitions from `Pending`:
    /// - → [`Active`](MatchState::Active): triggered automatically when both
    ///   players call [`deposit`](crate::EscrowContract::deposit).
    /// - → [`Cancelled`](MatchState::Cancelled): either player calls
    ///   [`cancel_match`](crate::EscrowContract::cancel_match). Any deposit
    ///   already made is refunded.
    Pending,

    /// Both players have deposited their stake and the game is in progress.
    ///
    /// Funds are held in escrow by the contract. The only way to leave this
    /// state is for the trusted oracle to call
    /// [`submit_result`](crate::EscrowContract::submit_result).
    ///
    /// Valid transitions from `Active`:
    /// - → [`Completed`](MatchState::Completed): oracle submits a verified
    ///   result and the payout is executed.
    ///
    /// Note: [`cancel_match`](crate::EscrowContract::cancel_match) is **not**
    /// permitted once a match is `Active`.
    Active,

    /// The oracle has submitted a verified result and the payout has been
    /// executed. This is a **terminal state**.
    ///
    /// The escrowed funds have been transferred to the winner (or split
    /// equally on a draw). No further operations are possible on this match.
    Completed,

    /// The match was cancelled before both players deposited. This is a
    /// **terminal state**.
    ///
    /// Any stake that had already been deposited is refunded to the
    /// respective player at the time of cancellation. A match can only be
    /// cancelled while in the [`Pending`](MatchState::Pending) state.
    Cancelled,
}

/// The chess platform on which the game is being played.
///
/// The platform is recorded at match creation and is used by the oracle to
/// know which external API to query when verifying the game result.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Platform {
    /// [Lichess](https://lichess.org) — a free, open-source chess server.
    Lichess,

    /// [Chess.com](https://www.chess.com) — a commercial chess platform.
    ChessDotCom,
}

/// The outcome of a completed chess match as reported by the trusted oracle.
///
/// This value is supplied to [`submit_result`](crate::EscrowContract::submit_result)
/// and determines how the escrowed funds are distributed:
///
/// | Variant   | Payout                                              |
/// |-----------|-----------------------------------------------------|
/// | `Player1` | Player 1 receives `stake_amount × 2`                |
/// | `Player2` | Player 2 receives `stake_amount × 2`                |
/// | `Draw`    | Each player receives their original `stake_amount`  |
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Winner {
    /// Player 1 won the game.
    ///
    /// The full pot (`stake_amount × 2`) is transferred to `player1`.
    Player1,

    /// Player 2 won the game.
    ///
    /// The full pot (`stake_amount × 2`) is transferred to `player2`.
    Player2,

    /// The game ended in a draw.
    ///
    /// Each player's original `stake_amount` is returned to them. No funds
    /// change hands net of the round-trip.
    Draw,
}

/// All data stored for a single chess escrow match.
///
/// A `Match` record is created by [`create_match`](crate::EscrowContract::create_match)
/// and persisted in contract storage under [`DataKey::Match`]. It is updated
/// in-place as the match progresses through its lifecycle.
///
/// # Storage
///
/// Match records are stored in **persistent** storage with a TTL of
/// `MATCH_TTL_LEDGERS` (~30 days). The TTL is extended on every write so
/// active matches do not expire mid-game.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Match {
    /// Unique, auto-incrementing identifier for this match.
    ///
    /// Assigned by the contract at creation time from the `MatchCount`
    /// counter. Used as the key in [`DataKey::Match`].
    pub id: u64,

    /// The Stellar address of the first player.
    ///
    /// `player1` must authorize the [`create_match`](crate::EscrowContract::create_match)
    /// call. Must be different from [`player2`](Match::player2).
    pub player1: Address,

    /// The Stellar address of the second player.
    ///
    /// Must be different from [`player1`](Match::player1).
    pub player2: Address,

    /// The amount each player must deposit, in the smallest unit of [`token`](Match::token).
    ///
    /// Must be a positive integer (`> 0`). The total pot held in escrow when
    /// both players have deposited is `stake_amount × 2`.
    pub stake_amount: i128,

    /// The Stellar address of the SEP-41 token contract used for staking.
    ///
    /// Validated at [`initialize`](crate::EscrowContract::initialize) time by
    /// calling a read-only method on the token contract. Both players deposit
    /// and receive payouts in this token.
    pub token: Address,

    /// The platform-specific identifier for the chess game being wagered on.
    ///
    /// Must be non-empty and at most 64 bytes long. Each `game_id` can only
    /// be used in a single match — duplicates are rejected with
    /// [`Error::DuplicateGameId`](crate::errors::Error::DuplicateGameId).
    /// The oracle uses this value to look up the game result on the external
    /// platform API.
    pub game_id: String,

    /// The chess platform on which the game is being played.
    ///
    /// Determines which external API the oracle queries to verify the result.
    /// See [`Platform`] for supported platforms.
    pub platform: Platform,

    /// The current lifecycle state of the match.
    ///
    /// Controls which operations are permitted. See [`MatchState`] for the
    /// full state machine diagram and valid transitions.
    pub state: MatchState,

    /// Whether [`player1`](Match::player1) has deposited their stake.
    ///
    /// Set to `true` by [`deposit`](crate::EscrowContract::deposit) when
    /// called by `player1`. When both `player1_deposited` and
    /// [`player2_deposited`](Match::player2_deposited) are `true`, the match
    /// transitions to [`MatchState::Active`].
    pub player1_deposited: bool,

    /// Whether [`player2`](Match::player2) has deposited their stake.
    ///
    /// Set to `true` by [`deposit`](crate::EscrowContract::deposit) when
    /// called by `player2`. When both [`player1_deposited`](Match::player1_deposited)
    /// and `player2_deposited` are `true`, the match transitions to
    /// [`MatchState::Active`].
    pub player2_deposited: bool,

    /// The ledger sequence number at which this match was created.
    ///
    /// Recorded at [`create_match`](crate::EscrowContract::create_match) time
    /// via `env.ledger().sequence()`. Used for timeout logic, ordering, and
    /// off-chain auditing. At ~5 seconds per ledger, `MATCH_TTL_LEDGERS`
    /// (~518 400 ledgers) corresponds to roughly 30 days.
    pub created_ledger: u32,
}

/// Storage keys used by the escrow contract.
///
/// All contract state is accessed through these keys. The variants map to
/// different storage tiers:
///
/// | Key variant      | Storage tier | Description                                  |
/// |------------------|--------------|----------------------------------------------|
/// | `Match(u64)`     | Persistent   | Full [`Match`] record, keyed by match ID     |
/// | `MatchCount`     | Instance     | Running counter used to assign match IDs     |
/// | `Oracle`         | Instance     | Address of the trusted oracle contract       |
/// | `Admin`          | Instance     | Address of the contract administrator        |
/// | `Paused`         | Instance     | Boolean pause flag                           |
/// | `Token`          | Instance     | Default SEP-41 token address                 |
/// | `GameId(String)` | Persistent   | Deduplication index: game_id → match ID      |
///
/// Instance-tier keys share the contract's instance TTL. Persistent-tier keys
/// have their own TTL extended to `MATCH_TTL_LEDGERS` on every write.
#[contracttype]
pub enum DataKey {
    /// Stores the full [`Match`] record for the given match ID.
    ///
    /// Keyed by the auto-incrementing `u64` match ID assigned at
    /// [`create_match`](crate::EscrowContract::create_match) time.
    /// Stored in **persistent** storage.
    Match(u64),

    /// Running counter that tracks the total number of matches created.
    ///
    /// Incremented atomically by [`create_match`](crate::EscrowContract::create_match)
    /// after each successful match creation. The current value is used as the
    /// ID for the next match. Stored in **instance** storage.
    MatchCount,

    /// The address of the trusted oracle contract.
    ///
    /// Set during [`initialize`](crate::EscrowContract::initialize) and
    /// updatable by the admin via
    /// [`update_oracle`](crate::EscrowContract::update_oracle). Only the
    /// oracle address is authorised to call
    /// [`submit_result`](crate::EscrowContract::submit_result).
    /// Stored in **instance** storage.
    Oracle,

    /// The address of the contract administrator.
    ///
    /// Set during [`initialize`](crate::EscrowContract::initialize). The
    /// admin can pause/unpause the contract and rotate the oracle address.
    /// Stored in **instance** storage.
    Admin,

    /// Boolean flag indicating whether the contract is paused.
    ///
    /// When `true`, [`create_match`](crate::EscrowContract::create_match),
    /// [`deposit`](crate::EscrowContract::deposit), and
    /// [`submit_result`](crate::EscrowContract::submit_result) all return
    /// [`Error::ContractPaused`](crate::errors::Error::ContractPaused).
    /// Managed by [`pause`](crate::EscrowContract::pause) and
    /// [`unpause`](crate::EscrowContract::unpause).
    /// Stored in **instance** storage.
    Paused,

    /// The default SEP-41 token address used for staking.
    ///
    /// Set during [`initialize`](crate::EscrowContract::initialize). Each
    /// [`Match`] also stores its own `token` field, which may differ if
    /// per-match tokens are supported in future versions.
    /// Stored in **instance** storage.
    Token,

    /// Deduplication index mapping a `game_id` string to its match ID.
    ///
    /// Written by [`create_match`](crate::EscrowContract::create_match) to
    /// prevent the same chess game from being used in more than one match.
    /// Before creating a match, the contract checks whether this key already
    /// exists; if it does, the call is rejected with
    /// [`Error::DuplicateGameId`](crate::errors::Error::DuplicateGameId).
    /// Stored in **persistent** storage with the same TTL as the match.
    GameId(String),
}
