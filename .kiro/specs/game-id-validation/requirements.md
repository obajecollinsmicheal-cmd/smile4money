# Requirements Document

## Introduction

The `CreateMatch` form currently accepts a game ID from either Lichess or Chess.com but performs no format validation before the user submits the form. If a user types a malformed ID, the form silently passes client-side checks, only to fail later during the server-side platform validation call. This creates a poor UX with unnecessary network round-trips and delayed feedback.

This feature adds client-side regex validation for game IDs keyed to the selected platform. Errors are surfaced inline — below the Game ID input — on blur and on any submit attempt, mirroring the existing pattern used for other fields in `CreateMatch.tsx`.

## Glossary

- **Validator**: The client-side validation module (`gameIdValidation.ts`) that exposes regex patterns and a `validateGameId` function.
- **CreateMatch**: The React form component (`CreateMatch.tsx`) through which users create a new chess betting match.
- **Game_ID_Input**: The `<input id="game-id">` field inside `CreateMatch`.
- **Inline_Error**: The `<span>` element rendered immediately below the `Game_ID_Input` when validation fails, matching the existing `error-message` pattern used for other fields.
- **Platform**: The chess platform selected by the user — either `lichess` or `chesscom`.
- **Lichess_ID**: An 8-character alphanumeric string that uniquely identifies a Lichess game (e.g. `Abc12345`). Format: `/^[a-zA-Z0-9]{8}$/`.
- **Chess_com_ID**: A numeric string of 7–12 digits that appears as the final path segment of a Chess.com game URL (e.g. `https://www.chess.com/game/live/12345678`). Format: `/^\d{7,12}$/`.
- **Blur Event**: The DOM `blur` event fired when the `Game_ID_Input` loses keyboard focus.

## Requirements

### Requirement 1: Lichess Game ID Format Validation

**User Story:** As a bettor creating a match on Lichess, I want to see an immediate error if I type a game ID that doesn't match Lichess's format, so that I can correct it before wasting time on a network call.

#### Acceptance Criteria

1. THE Validator SHALL expose the Lichess ID pattern as `/^[a-zA-Z0-9]{8}$/`.
2. WHEN the `Game_ID_Input` loses focus and the selected Platform is `lichess`, THE Validator SHALL test the entered value against the Lichess ID pattern.
3. IF the entered value does not match the Lichess ID pattern, THEN THE CreateMatch SHALL display an Inline_Error reading "Lichess game IDs must be exactly 8 alphanumeric characters (e.g. Abc12345)" below the `Game_ID_Input`.
4. WHEN the entered value matches the Lichess ID pattern, THE CreateMatch SHALL display no Inline_Error for the Game_ID_Input format.

### Requirement 2: Chess.com Game ID Format Validation

**User Story:** As a bettor creating a match on Chess.com, I want to see an immediate error if I type a game ID that doesn't match Chess.com's numeric format, so that I can correct it without hitting the server.

#### Acceptance Criteria

1. THE Validator SHALL expose the Chess.com ID pattern as `/^\d{7,12}$/`.
2. WHEN the `Game_ID_Input` loses focus and the selected Platform is `chesscom`, THE Validator SHALL test the entered value against the Chess.com ID pattern.
3. IF the entered value does not match the Chess.com ID pattern, THEN THE CreateMatch SHALL display an Inline_Error reading "Chess.com game IDs must be 7–12 digits (e.g. 12345678)" below the `Game_ID_Input`.
4. WHEN the entered value matches the Chess.com ID pattern, THE CreateMatch SHALL display no Inline_Error for the Game_ID_Input format.

### Requirement 3: Validation Triggered on Blur

**User Story:** As a bettor filling out the form, I want inline feedback as soon as I leave the Game ID field, so that I can correct mistakes before attempting to submit.

#### Acceptance Criteria

1. WHEN a Blur Event fires on the `Game_ID_Input`, THE CreateMatch SHALL run format validation for the currently selected Platform.
2. WHEN a Blur Event fires and the field is empty, THE CreateMatch SHALL display no format-specific Inline_Error (the required-field check is deferred to submit time).
3. WHEN a Blur Event fires and a format error already exists for another field, THE CreateMatch SHALL update only the `gameId` error without clearing other field errors.

### Requirement 4: Validation Triggered on Submit Attempt

**User Story:** As a bettor submitting the form, I want format errors on the Game ID to block submission and surface inline, so that I don't wait for a server round-trip for obviously invalid IDs.

#### Acceptance Criteria

1. WHEN the user submits the form and the `Game_ID_Input` value does not match the active Platform's pattern, THE CreateMatch SHALL prevent form submission and display the Inline_Error.
2. WHEN the user submits the form and the `Game_ID_Input` is empty, THE CreateMatch SHALL prevent form submission and display the existing "Game ID is required" error.
3. WHEN the user submits the form and all fields — including the `Game_ID_Input` — are valid, THE CreateMatch SHALL proceed to server-side platform validation without displaying a format Inline_Error.

### Requirement 5: Error Cleared When Input Becomes Valid

**User Story:** As a bettor correcting a game ID, I want the error message to disappear as soon as I've typed a valid ID, so that the UI gives me immediate positive feedback.

#### Acceptance Criteria

1. WHEN the value of the `Game_ID_Input` changes and the new value matches the active Platform's pattern, THE CreateMatch SHALL remove the `gameId` Inline_Error.
2. WHEN the Platform selection changes, THE CreateMatch SHALL re-evaluate the current `Game_ID_Input` value against the new Platform's pattern and update the Inline_Error accordingly.

### Requirement 6: Error Accessibility

**User Story:** As a bettor using a screen reader, I want format error messages to be announced automatically, so that I receive the same feedback as sighted users.

#### Acceptance Criteria

1. THE Inline_Error element SHALL carry `role="alert"` so that assistive technologies announce it without requiring focus.
2. THE `Game_ID_Input` SHALL have `aria-invalid="true"` when a format Inline_Error is present and `aria-invalid="false"` when no error is present.
3. THE `Game_ID_Input` SHALL have an `aria-describedby` attribute referencing the Inline_Error element's `id` when the error is visible.

### Requirement 7: Validation Logic is Unit-Testable in Isolation

**User Story:** As a developer maintaining the codebase, I want the regex validation logic to live in a pure, side-effect-free module, so that I can write fast unit and property-based tests without mounting any React component.

#### Acceptance Criteria

1. THE Validator SHALL export a `validateGameId(platform: 'lichess' | 'chesscom', gameId: string): string | null` function that returns an error string when validation fails or `null` when the input is valid.
2. THE Validator SHALL export the `LICHESS_GAME_ID_REGEX` and `CHESS_COM_GAME_ID_REGEX` constants.
3. FOR ALL strings `s` of exactly 8 characters drawn from `[a-zA-Z0-9]`, calling `validateGameId('lichess', s)` SHALL return `null`.
4. FOR ALL strings `s` that are 7–12 character strings of digits `[0-9]`, calling `validateGameId('chesscom', s)` SHALL return `null`.
5. FOR ALL strings `s` that do not match the Lichess ID pattern, calling `validateGameId('lichess', s)` SHALL return a non-null error string.
6. FOR ALL strings `s` that do not match the Chess.com ID pattern, calling `validateGameId('chesscom', s)` SHALL return a non-null error string.
