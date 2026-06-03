# feat: add claim/burn UI and wallet states

Implements the claim and burn UI component with full wallet state handling.

## What changed
- `claim-burn.tsx` — rewrote component to handle all wallet states (checking, notInstalled, disconnected, wrongNetwork, error, connected), claim/burn toggle, confirmation step, success/error feedback, and balance display
- `App.tsx` — wires up all wallet props (balance, disconnect, refreshBalance) from `useStellarWallet`

## Testing
All 22 tests pass (`npm test` in `apps/frontend`).

## Notes
- Transaction submission (`handleClaim`, `handleBurn`) has placeholder stubs — needs Stellar SDK integration
- Network switching requires manual action in Freighter (no programmatic API)
