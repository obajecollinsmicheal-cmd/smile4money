use soroban_sdk::contracterror;

/// Errors returned by the oracle contract.
///
/// Each variant carries a stable numeric code (the discriminant) that is
/// encoded on-chain and surfaced to clients. Do **not** renumber existing
/// variants — doing so is a breaking change for any client that inspects the
/// raw error code.
///
/// # Error code table
///
/// | Code | Variant            | Meaning                                                  |
/// |------|--------------------|----------------------------------------------------------|
/// |  1   | Unauthorized       | Caller is not the registered admin                       |
/// |  2   | AlreadySubmitted   | A result has already been recorded for this match_id     |
/// |  3   | ResultNotFound     | No result has been submitted for the given match_id      |
/// |  4   | AlreadyInitialized | Contract has already been initialized                    |
/// |  5   | InvalidGameId      | game_id is empty or exceeds the 64-byte maximum          |
/// |  6   | TransferFailed     | Token transfer in withdraw failed                        |
/// |  7   | InvalidAmount      | withdraw amount must be greater than zero                |
/// |  8   | InvalidAdmin       | new_admin is the zero/burn address                       |
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    /// [E001] Caller is not the registered admin (the trusted off-chain oracle service).
    Unauthorized = 1,

    /// [E002] A result has already been recorded for this `match_id`.
    /// Results are immutable once submitted to prevent tampering.
    AlreadySubmitted = 2,

    /// [E003] No result has been submitted for the given `match_id` yet.
    ResultNotFound = 3,

    /// [E004] `initialize` has already been called; the contract cannot be re-initialized.
    AlreadyInitialized = 4,

    /// [E005] `game_id` is empty or exceeds the 64-byte maximum length.
    InvalidGameId = 5,

    /// [E006] Token transfer failed during `withdraw`.
    TransferFailed = 6,

    /// [E007] Invalid amount supplied to `withdraw` (amount must be > 0).
    InvalidAmount = 7,

    /// [E008] `new_admin` is the zero/burn address. Storing it would permanently
    /// brick the contract because the zero address can never sign a transaction.
    InvalidAdmin = 8,
}
