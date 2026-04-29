use soroban_sdk::contracterror;

/// Errors returned by the escrow contract.
///
/// Each variant carries a stable numeric code (the discriminant) that is
/// encoded on-chain and surfaced to clients. Do **not** renumber existing
/// variants — doing so is a breaking change for any client that inspects the
/// raw error code.
///
/// # Error code table
///
/// | Code | Variant            | Meaning                                              |
/// |------|--------------------|------------------------------------------------------|
/// |  1   | MatchNotFound      | No match exists for the given match_id               |
/// |  2   | AlreadyFunded      | The calling player has already deposited for this match |
/// |  3   | NotFunded          | submit_result called before both players deposited   |
/// |  4   | Unauthorized       | Caller is not permitted to perform this action       |
/// |  5   | InvalidState       | Operation is not valid in the match's current state  |
/// |  6   | AlreadyExists      | A match with this ID already exists (counter collision) |
/// |  7   | AlreadyInitialized | Contract has already been initialized                |
/// |  8   | Overflow           | Match ID counter would overflow u64                  |
/// |  9   | ContractPaused     | Contract is paused; mutating operations are blocked  |
/// | 10   | InvalidAmount      | stake_amount must be greater than zero               |
/// | 11   | InvalidGameId      | game_id is empty or exceeds the 64-byte maximum      |
/// | 12   | InvalidPlayers     | player1 and player2 must be different addresses      |
/// | 13   | GameIdMismatch     | Oracle submitted a result for the wrong game_id      |
/// | 14   | DuplicateGameId    | game_id is already linked to another match           |
/// | 15   | TransferFailed     | token transfer failed                                |
/// | 16   | MatchCancelled     | deposit rejected: match has been cancelled           |
/// | 17   | MatchCompleted     | deposit rejected: match has already completed        |
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
    Unauthorized = 4,

    /// [E005] The requested operation is not valid in the match's current `MatchState`.
    /// Valid transitions: Pending → Active (deposit), Pending → Cancelled (cancel_match),
    /// Active → Completed (submit_result).
    InvalidState = 5,

    /// [E006] A match record already exists at this ID (internal counter collision).
    AlreadyExists = 6,

    /// [E007] `initialize` has already been called; the contract cannot be re-initialized.
    AlreadyInitialized = 7,

    /// [E008] The match ID counter has reached `u64::MAX` and cannot be incremented safely.
    Overflow = 8,

    /// [E009] The contract is paused by the admin. `create_match`, `deposit`, and
    /// `submit_result` are blocked until `unpause` is called.
    ContractPaused = 9,

    /// [E010] `stake_amount` must be a positive integer greater than zero.
    InvalidAmount = 10,

    /// [E011] `game_id` is empty or exceeds the 64-byte maximum length.
    InvalidGameId = 11,

    /// [E012] `player1` and `player2` must be different addresses; a player cannot
    /// bet against themselves.
    InvalidPlayers = 12,

    /// [E013] The oracle submitted a result whose `game_id` does not match the
    /// `game_id` stored in the match. Prevents cross-match result injection.
    GameIdMismatch = 13,

    /// [E014] The provided `game_id` is already linked to an existing match.
    /// Each game may only be used in one match.
    DuplicateGameId = 14,
    /// token transfer failed
    TransferFailed = 15,

    /// [E016] Deposit rejected because the match has been cancelled.
    MatchCancelled = 16,

    /// [E017] Deposit rejected because the match has already completed.
    MatchCompleted = 17,

    /// [E018] Oracle contract has no result for this match_id yet.
    /// The oracle service must call oracle_contract.submit_result() before
    /// the escrow can finalise the match.
    OracleResultNotFound = 18,
}

impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Error::MatchNotFound =>
                write!(f, "[E001] MatchNotFound: no match exists for the given match_id"),
            Error::AlreadyFunded =>
                write!(f, "[E002] AlreadyFunded: this player has already deposited their stake"),
            Error::NotFunded =>
                write!(f, "[E003] NotFunded: submit_result called before both players deposited"),
            Error::Unauthorized =>
                write!(f, "[E004] Unauthorized: caller is not permitted to perform this action"),
            Error::InvalidState =>
                write!(f, "[E005] InvalidState: operation not valid in the current match state"),
            Error::AlreadyExists =>
                write!(f, "[E006] AlreadyExists: a match record already exists at this ID"),
            Error::AlreadyInitialized =>
                write!(f, "[E007] AlreadyInitialized: contract has already been initialized"),
            Error::Overflow =>
                write!(f, "[E008] Overflow: match ID counter would exceed u64::MAX"),
            Error::ContractPaused =>
                write!(f, "[E009] ContractPaused: contract is paused; mutating operations are blocked"),
            Error::InvalidAmount =>
                write!(f, "[E010] InvalidAmount: stake_amount must be greater than zero"),
            Error::InvalidGameId =>
                write!(f, "[E011] InvalidGameId: game_id is empty or exceeds the 64-byte limit"),
            Error::InvalidPlayers =>
                write!(f, "[E012] InvalidPlayers: player1 and player2 must be different addresses"),
            Error::GameIdMismatch =>
                write!(f, "[E013] GameIdMismatch: oracle game_id does not match the stored game_id"),
            Error::DuplicateGameId =>
                write!(f, "[E014] DuplicateGameId: game_id is already linked to another match"),
            Error::TransferFailed =>
                write!(f, "[E015] TransferFailed: token transfer failed"),
            Error::MatchCancelled =>
                write!(f, "[E016] MatchCancelled: deposit rejected — match has been cancelled"),
            Error::MatchCompleted =>
                write!(f, "[E017] MatchCompleted: deposit rejected — match has already completed"),
            Error::OracleResultNotFound =>
                write!(f, "[E018] OracleResultNotFound: oracle contract has no result for this match_id yet"),
        }
    }
}
