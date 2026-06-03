# API Reference

Complete reference for all smart contract functions, types, and errors.

## Escrow Contract

### Initialization

#### `initialize`

Initialize the escrow contract with oracle, admin, and default token addresses.

**Signature:**
```rust
pub fn initialize(env: Env, oracle: Address, admin: Address, token: Address) -> Result<(), Error>
```

**Parameters:**
- `oracle`: Address of the trusted oracle that may call `submit_result`
- `admin`: Address of the contract administrator (pause/unpause, oracle rotation)
- `token`: Address of the default SEP-41 token contract used for staking

**Behavior:**
- Validates `token` by calling a read-only method on it; panics if not a valid token contract
- Sets the oracle, admin, and token addresses in instance storage
- Initializes match counter to `0`
- Sets paused state to `false`
- Panics if already initialized

**Authorization:** None required (callable once only)

**Errors:**
- Panics with `"Contract already initialized"` if called a second time

---

### Admin Functions

#### `pause`

Pause the contract to prevent new matches, deposits, and result submissions.

**Signature:**
```rust
pub fn pause(env: Env) -> Result<(), Error>
```

**Behavior:**
- Sets paused flag to `true`
- Blocks `create_match`, `deposit`, and `submit_result`
- `cancel_match` remains available so players can recover funds
- Emits `("admin", "paused")` event

**Authorization:** Requires admin signature

**Errors:**
- `Error::Unauthorized`: Caller is not the admin

---

#### `unpause`

Resume normal contract operations.

**Signature:**
```rust
pub fn unpause(env: Env) -> Result<(), Error>
```

**Behavior:**
- Sets paused flag to `false`
- Re-enables all contract functions
- Emits `("admin", "unpaused")` event

**Authorization:** Requires admin signature

**Errors:**
- `Error::Unauthorized`: Caller is not the admin

---

#### `update_oracle`

Rotate the trusted oracle address.

**Signature:**
```rust
pub fn update_oracle(env: Env, new_oracle: Address) -> Result<(), Error>
```

**Parameters:**
- `new_oracle`: Replacement oracle address

**Behavior:**
- Replaces the stored oracle address with `new_oracle`
- Emits `("admin", "oracle")` event with the new oracle address

**Authorization:** Requires admin signature

**Errors:**
- `Error::Unauthorized`: Caller is not the admin

**Example:**
```rust
escrow.update_oracle(&new_oracle_addr);
```

---

### Match Management

#### `create_match`

Create a new betting match.

**Signature:**
```rust
pub fn create_match(
    env: Env,
    player1: Address,
    player2: Address,
    stake_amount: i128,
    token: Address,
    game_id: String,
    platform: Platform,
) -> Result<u64, Error>
```

**Parameters:**
- `player1`: Address of the match creator (must sign the transaction)
- `player2`: Address of the opponent
- `stake_amount`: Amount each player must deposit (in the token's smallest unit)
- `token`: Address of the SEP-41 token contract used for this match
- `game_id`: Unique identifier from the chess platform (max 64 bytes)
- `platform`: Chess platform enum (`Lichess` or `ChessDotCom`)

**Returns:**
- `u64`: Unique match ID

**Behavior:**
- Validates `stake_amount > 0`
- Validates `player1 != player2`
- Validates `game_id` length is between 1 and 64 bytes
- Rejects duplicate `game_id` values
- Creates match in `Pending` state
- Increments match counter with overflow check
- Extends TTL to `MATCH_TTL_LEDGERS` (~30 days)
- Emits `("match", "created")` event

**Authorization:** Requires `player1` signature

**Errors:**
- `Error::ContractPaused`: Contract is paused
- `Error::InvalidAmount`: `stake_amount ≤ 0`
- `Error::InvalidPlayers`: `player1 == player2`
- `Error::InvalidGameId`: `game_id` is empty or exceeds 64 bytes
- `Error::DuplicateGameId`: `game_id` is already used in another match
- `Error::AlreadyExists`: Match ID collision (internal counter error)
- `Error::Overflow`: Match counter would exceed `u64::MAX`

**Example:**
```rust
let match_id = escrow.create_match(
    &player1_addr,
    &player2_addr,
    &1_000_0000, // 100 XLM (7 decimals)
    &xlm_token_addr,
    &String::from_str(&env, "lichess_abc123"),
    &Platform::Lichess,
);
```

---

#### `deposit`

Deposit stake into escrow for a match.

**Signature:**
```rust
pub fn deposit(env: Env, match_id: u64, player: Address) -> Result<(), Error>
```

**Parameters:**
- `match_id`: ID of the match to deposit into
- `player`: Address making the deposit (must be `player1` or `player2`)

**Behavior:**
- Validates match exists and is in `Pending` state
- Validates caller is `player1` or `player2`
- Transfers `stake_amount` tokens from `player` to the contract
- Marks the player as deposited
- If both players have deposited, transitions match to `Active` state and emits `("match", "activated")`
- Extends TTL to `MATCH_TTL_LEDGERS`
- Emits `("match", "deposit")` event

**Authorization:** Requires `player` signature

**Errors:**
- `Error::ContractPaused`: Contract is paused
- `Error::MatchNotFound`: Invalid `match_id`
- `Error::MatchCancelled`: Match has been cancelled
- `Error::MatchCompleted`: Match has already completed
- `Error::InvalidState`: Match is not in `Pending` state
- `Error::Unauthorized`: Caller is not `player1` or `player2`
- `Error::AlreadyFunded`: Player has already deposited
- `Error::TransferFailed`: Token transfer failed

**Example:**
```rust
// Player 1 deposits
escrow.deposit(&match_id, &player1_addr);

// Player 2 deposits — match transitions to Active
escrow.deposit(&match_id, &player2_addr);
```

---

#### `cancel_match`

Cancel a pending match and refund any deposits.

**Signature:**
```rust
pub fn cancel_match(env: Env, match_id: u64, caller: Address) -> Result<(), Error>
```

**Parameters:**
- `match_id`: ID of the match to cancel
- `caller`: Address requesting cancellation (must be `player1` or `player2`)

**Behavior:**
- Validates match is in `Pending` state (cancellation is not allowed once `Active`)
- Validates caller is `player1` or `player2`
- If both players have deposited, requires authorization from **both** players
- Refunds `player1` if they deposited
- Refunds `player2` if they deposited
- Transitions to `Cancelled` state
- Extends TTL to `MATCH_TTL_LEDGERS`
- Emits `("match", "cancelled")` event
- Allowed even when the contract is paused (so players can always recover funds)

**Authorization:** Requires `caller` signature; if both players have deposited, requires both `player1` and `player2` signatures

**Errors:**
- `Error::MatchNotFound`: Invalid `match_id`
- `Error::InvalidState`: Match is not `Pending` (already `Active`, `Completed`, or `Cancelled`)
- `Error::Unauthorized`: Caller is not `player1` or `player2`

**Example:**
```rust
// Either player can cancel a pending match
escrow.cancel_match(&match_id, &player2_addr);
```

---

### Result Submission

#### `submit_result`

Submit a verified match result and execute payout.

**Signature:**
```rust
pub fn submit_result(
    env: Env,
    match_id: u64,
    game_id: String,
    winner: Winner,
    caller: Address,
) -> Result<(), Error>
```

**Parameters:**
- `match_id`: ID of the match to finalize
- `game_id`: Chess platform game identifier — must match the `game_id` stored in the match record
- `winner`: Result enum (`Player1`, `Player2`, or `Draw`)
- `caller`: Address submitting the result (must be the registered oracle)

**Behavior:**
- Validates `caller` is the trusted oracle address
- Validates `game_id` matches the match's stored `game_id` (prevents cross-match result injection)
- Validates match is in `Active` state
- Validates both players have deposited
- Executes payout based on `winner`:
  - `Player1`: Transfers `stake_amount × 2` to `player1`
  - `Player2`: Transfers `stake_amount × 2` to `player2`
  - `Draw`: Returns `stake_amount` to each player
- Transitions to `Completed` state
- Extends TTL to `MATCH_TTL_LEDGERS`
- Emits `("match", "completed")` event

**Authorization:** Requires oracle signature

**Errors:**
- `Error::ContractPaused`: Contract is paused
- `Error::Unauthorized`: Caller is not the registered oracle
- `Error::MatchNotFound`: Invalid `match_id`
- `Error::GameIdMismatch`: Provided `game_id` does not match the match's stored `game_id`
- `Error::InvalidState`: Match is not `Active`
- `Error::NotFunded`: Both players have not deposited

**Example:**
```rust
// Oracle submits Player1 win
escrow.submit_result(
    &match_id,
    &String::from_str(&env, "lichess_abc123"),
    &Winner::Player1,
    &oracle_addr,
);
```

---

### Query Functions

#### `get_match`

Retrieve full match details.

**Signature:**
```rust
pub fn get_match(env: Env, match_id: u64) -> Result<Match, Error>
```

**Parameters:**
- `match_id`: ID of the match to query

**Returns:**
- `Match`: Complete match struct

**Errors:**
- `Error::MatchNotFound`: Invalid `match_id`

**Example:**
```rust
let match_data = escrow.get_match(&match_id);
assert_eq!(match_data.state, MatchState::Active);
```

---

#### `is_funded`

Check if both players have deposited.

**Signature:**
```rust
pub fn is_funded(env: Env, match_id: u64) -> Result<bool, Error>
```

**Parameters:**
- `match_id`: ID of the match to check

**Returns:**
- `bool`: `true` if both players have deposited, `false` otherwise

**Errors:**
- `Error::MatchNotFound`: Invalid `match_id`

**Example:**
```rust
if escrow.is_funded(&match_id) {
    // Match is ready to start
}
```

---

#### `get_escrow_balance`

Get total tokens held in escrow for a match.

**Signature:**
```rust
pub fn get_escrow_balance(env: Env, match_id: u64) -> Result<i128, Error>
```

**Parameters:**
- `match_id`: ID of the match to check

**Returns:**
- `i128`: Total escrowed amount (`0`, `stake_amount`, or `2 × stake_amount`)

**Behavior:**
- Returns `0` if match is `Completed` or `Cancelled`
- Returns `stake_amount` if exactly one player has deposited
- Returns `2 × stake_amount` if both players have deposited

**Errors:**
- `Error::MatchNotFound`: Invalid `match_id`

**Example:**
```rust
let balance = escrow.get_escrow_balance(&match_id);
// 0, stake_amount, or 2 * stake_amount
```

---

## Oracle Contract

### Initialization

#### `initialize`

Initialize the oracle contract with the admin address.

**Signature:**
```rust
pub fn initialize(env: Env, admin: Address) -> Result<(), Error>
```

**Parameters:**
- `admin`: Address of the oracle service (the only address that may call `submit_result`)

**Behavior:**
- Sets the admin address in instance storage
- Emits `("oracle", "init")` event with the admin address
- Returns `Error::AlreadyInitialized` if called a second time

**Authorization:** None required (callable once only)

**Errors:**
- `Error::AlreadyInitialized`: Contract has already been initialized

---

### Result Management

#### `submit_result`

Submit a verified match result on-chain.

**Signature:**
```rust
pub fn submit_result(
    env: Env,
    match_id: u64,
    game_id: String,
    result: MatchResult,
) -> Result<(), Error>
```

**Parameters:**
- `match_id`: ID of the match (from the escrow contract)
- `game_id`: Chess platform game identifier (max 64 bytes, must be non-empty)
- `result`: Result enum (`Player1Wins`, `Player2Wins`, or `Draw`)

**Behavior:**
- Validates caller is the admin
- Validates `game_id` is non-empty and at most 64 bytes
- Prevents duplicate submissions for the same `match_id`
- Stores `ResultEntry` in persistent storage with TTL extension
- Emits `("oracle", "result")` event with `(match_id, result, timestamp)`

**Authorization:** Requires admin signature

**Errors:**
- `Error::Unauthorized`: Caller is not the admin
- `Error::InvalidGameId`: `game_id` is empty or exceeds 64 bytes
- `Error::AlreadySubmitted`: A result already exists for this `match_id`

**Example:**
```rust
oracle.submit_result(
    &match_id,
    &String::from_str(&env, "lichess_abc123"),
    &MatchResult::Player1Wins,
);
```

---

#### `get_result`

Retrieve the stored result for a match.

**Signature:**
```rust
pub fn get_result(env: Env, match_id: u64) -> Result<ResultEntry, Error>
```

**Parameters:**
- `match_id`: ID of the match to query

**Returns:**
- `ResultEntry`: Struct containing `game_id` and `result`

**Errors:**
- `Error::ResultNotFound`: No result has been submitted for this `match_id`

**Example:**
```rust
let entry = oracle.get_result(&match_id);
assert_eq!(entry.result, MatchResult::Player1Wins);
```

---

#### `has_result`

Check if a result exists for a match.

**Signature:**
```rust
pub fn has_result(env: Env, match_id: u64) -> bool
```

**Parameters:**
- `match_id`: ID of the match to check

**Returns:**
- `bool`: `true` if a result has been submitted, `false` otherwise

**Example:**
```rust
if oracle.has_result(&match_id) {
    let entry = oracle.get_result(&match_id);
}
```

---

#### `transfer_admin`

Transfer oracle admin rights to a new address.

**Signature:**
```rust
pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), Error>
```

**Parameters:**
- `new_admin`: Address of the new admin

**Behavior:**
- Replaces the stored admin address with `new_admin`
- Emits `("oracle", "adm_xfer")` event with `(old_admin, new_admin)`

**Authorization:** Requires current admin signature

**Errors:**
- `Error::Unauthorized`: Caller is not the current admin

**Example:**
```rust
oracle.transfer_admin(&new_oracle_service_addr);
```

---

## Data Types

### Match

Complete match record stored in the escrow contract.

```rust
pub struct Match {
    pub id: u64,
    pub player1: Address,
    pub player2: Address,
    pub stake_amount: i128,
    pub token: Address,
    pub game_id: String,
    pub platform: Platform,
    pub state: MatchState,
    pub player1_deposited: bool,
    pub player2_deposited: bool,
    pub created_ledger: u32,
}
```

**Fields:**
- `id`: Unique match identifier (auto-assigned)
- `player1`: Match creator address
- `player2`: Opponent address
- `stake_amount`: Amount each player deposits (in token's smallest unit)
- `token`: SEP-41 token contract address
- `game_id`: Chess platform game identifier
- `platform`: Chess platform (`Lichess` or `ChessDotCom`)
- `state`: Current match lifecycle state
- `player1_deposited`: Whether `player1` has deposited
- `player2_deposited`: Whether `player2` has deposited
- `created_ledger`: Ledger sequence number at match creation

---

### MatchState

Match lifecycle states.

```rust
pub enum MatchState {
    Pending,   // Created, awaiting both deposits
    Active,    // Both players deposited, game in progress
    Completed, // Result submitted, payout executed (terminal)
    Cancelled, // Cancelled before activation (terminal)
}
```

---

### Platform

Supported chess platforms.

```rust
pub enum Platform {
    Lichess,
    ChessDotCom,
}
```

---

### Winner

Match outcome for the escrow contract's `submit_result`.

```rust
pub enum Winner {
    Player1, // Player1 receives stake_amount × 2
    Player2, // Player2 receives stake_amount × 2
    Draw,    // Each player receives their original stake_amount
}
```

---

### MatchResult

Match outcome for the oracle contract's `submit_result`.

```rust
pub enum MatchResult {
    Player1Wins,
    Player2Wins,
    Draw,
}
```

---

### ResultEntry

Oracle result record stored in the oracle contract.

```rust
pub struct ResultEntry {
    pub game_id: String,
    pub result: MatchResult,
}
```

---

## Error Codes

### Escrow Contract Errors

```rust
pub enum Error {
    MatchNotFound      = 1,  // No match exists for the given match_id
    AlreadyFunded      = 2,  // Player has already deposited for this match
    NotFunded          = 3,  // submit_result called before both players deposited
    Unauthorized       = 4,  // Caller lacks required authorization
    InvalidState       = 5,  // Operation not allowed in the current match state
    AlreadyExists      = 6,  // Match ID collision (internal counter error)
    AlreadyInitialized = 7,  // Contract already initialized (unused; initialize panics instead)
    Overflow           = 8,  // Match counter would exceed u64::MAX
    ContractPaused     = 9,  // Contract is paused; mutating operations are blocked
    InvalidAmount      = 10, // stake_amount ≤ 0
    InvalidGameId      = 11, // game_id is empty or exceeds 64 bytes
    InvalidPlayers     = 12, // player1 == player2 in create_match
    GameIdMismatch     = 13, // Oracle submitted result for the wrong game_id
    DuplicateGameId    = 14, // game_id is already linked to another match
    TransferFailed     = 15, // Token transfer failed
    MatchCancelled     = 16, // Deposit rejected — match has been cancelled
    MatchCompleted     = 17, // Deposit rejected — match has already completed
}
```

### Oracle Contract Errors

```rust
pub enum Error {
    Unauthorized       = 1, // Caller is not the admin
    AlreadySubmitted   = 2, // A result already exists for this match_id
    ResultNotFound     = 3, // No result submitted for this match_id
    AlreadyInitialized = 4, // Contract already initialized
    InvalidGameId      = 5, // game_id is empty or exceeds 64 bytes
}
```

---

## Events

### Escrow Contract Events

#### `("match", "created")`
Emitted when a new match is created via `create_match`.

**Data:** `(match_id: u64, player1: Address, player2: Address, stake_amount: i128, game_id: String)`

---

#### `("match", "activated")`
Emitted when both players have deposited and the match transitions to `Active`.

**Data:** `match_id: u64`

---

#### `("match", "deposit")`
Emitted on every individual player deposit.

**Data:** `(match_id: u64, player: Address, stake_amount: i128)`

---

#### `("match", "completed")`
Emitted when the oracle submits a result and the payout is executed.

**Data:** `(match_id: u64, winner: Winner, payout_amount: i128)`

---

#### `("match", "cancelled")`
Emitted when a match is cancelled via `cancel_match`.

**Data:** `(match_id: u64, caller: Address)`

---

#### `("admin", "paused")`
Emitted when the contract is paused.

**Data:** `()`

---

#### `("admin", "unpaused")`
Emitted when the contract is unpaused.

**Data:** `()`

---

#### `("admin", "oracle")`
Emitted when the oracle address is rotated via `update_oracle`.

**Data:** `new_oracle: Address`

---

### Oracle Contract Events

#### `("oracle", "init")`
Emitted when the oracle contract is initialized.

**Data:** `admin: Address`

---

#### `("oracle", "result")`
Emitted when a result is submitted via `submit_result`.

**Data:** `(match_id: u64, result: MatchResult, timestamp: u64)`

---

#### `("oracle", "adm_xfer")`
Emitted when admin rights are transferred via `transfer_admin`.

**Data:** `(old_admin: Address, new_admin: Address)`

---

## Constants

### Escrow Contract

```rust
const MATCH_TTL_LEDGERS: u32 = 518_400; // ~30 days at 5 s/ledger
const MAX_GAME_ID_LEN: u32   = 64;      // Maximum game_id byte length
```

### Oracle Contract

```rust
const MATCH_TTL_LEDGERS: u32 = 518_400; // ~30 days at 5 s/ledger
const MAX_GAME_ID_LEN: u32   = 64;      // Maximum game_id byte length
```

---

## Usage Examples

### Complete Match Flow

```rust
// 1. Initialize contracts
escrow.initialize(&oracle_addr, &admin_addr, &xlm_token_addr);
oracle.initialize(&oracle_service_addr);

// 2. Create match
let match_id = escrow.create_match(
    &player1,
    &player2,
    &100_0000000, // 100 XLM (7 decimals)
    &xlm_token,
    &String::from_str(&env, "lichess_game123"),
    &Platform::Lichess,
);

// 3. Players deposit
escrow.deposit(&match_id, &player1);
escrow.deposit(&match_id, &player2); // match transitions to Active

// 4. Verify match is funded
assert!(escrow.is_funded(&match_id));

// 5. Players play the chess game...

// 6. Oracle records result on-chain
oracle.submit_result(
    &match_id,
    &String::from_str(&env, "lichess_game123"),
    &MatchResult::Player1Wins,
);

// 7. Oracle triggers payout on escrow
escrow.submit_result(
    &match_id,
    &String::from_str(&env, "lichess_game123"),
    &Winner::Player1,
    &oracle_addr,
);

// 8. Verify completion
let match_data = escrow.get_match(&match_id);
assert_eq!(match_data.state, MatchState::Completed);
```

### Cancellation Flow

```rust
// Create match
let match_id = escrow.create_match(...);

// Player1 deposits
escrow.deposit(&match_id, &player1);

// Player2 decides not to play — cancels and player1 is refunded
escrow.cancel_match(&match_id, &player2);
```

### Emergency Pause

```rust
// Admin pauses contract
escrow.pause();

// All mutating operations are blocked
assert!(escrow.try_create_match(...).is_err()); // Error::ContractPaused

// cancel_match still works so players can recover funds
escrow.cancel_match(&match_id, &player1);

// Admin unpauses
escrow.unpause();

// Operations resume normally
```

### Oracle Admin Rotation

```rust
// Transfer oracle admin to a new key
oracle.transfer_admin(&new_oracle_service_addr);

// Old admin can no longer submit results
// New admin can submit results immediately
oracle.submit_result(&match_id, &game_id, &MatchResult::Draw);
```
