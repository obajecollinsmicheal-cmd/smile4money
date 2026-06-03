# feat: add claim/burn UI with toggle functionality and proper wallet states

## Description

Implement a claim and burn UI with toggle functionality and proper wallet states.

This PR builds the `claim-burn.tsx` component with a modern, accessible UI that handles all wallet connection states, smooth mode transitions between claim and burn, and full responsive layout.

## Changes Made

- ✨ Built `components/claim-burn.tsx` from scratch with full wallet state handling
- 🎨 Added `components/claim-burn.css` with responsive, mobile-first styling
- 🔗 Implemented disconnected / connecting / connected wallet states with appropriate UI for each
- 🔄 Added toggle buttons for claim and burn modes with smooth transitions
- 💰 Balance display with a convenient Max button
- ⚠️ Error handling with inline error messages and auto-hide success feedback (3s)
- ⏳ Loading states with spinner during transaction processing
- ♿ Full ARIA support and keyboard navigation for accessibility
- 🌙 Dark mode and high contrast media query support
- 🧪 Comprehensive test coverage for all states and interactions

## Features

- **Wallet States**: Disconnected prompt, connecting spinner, and connected form — each with its own UI
- **Toggle Functionality**: Claim (📥) and Burn (🔥) toggle with active state styling and smooth transitions
- **Balance Integration**: Displays available XLM balance with a Max button to auto-fill the input
- **Responsive Design**: Mobile-first with breakpoints at 640px and 480px
- **Accessibility**: ARIA roles, `aria-pressed`, `aria-live` regions, and keyboard-navigable controls
- **Visual Feedback**: Animated success/error banners, loading spinner on submit button
- **Modern Styling**: Gradient backgrounds, hover lift effects, dark mode, reduced-motion support

## Testing

- ✅ Wallet disconnected state renders connect button
- ✅ Wallet connecting state renders spinner and message
- ✅ Wallet connected state renders full claim/burn form
- ✅ Toggle switches between claim and burn modes
- ✅ Form validation blocks submission on empty or zero amount
- ✅ Success message auto-hides after 3 seconds
- ✅ Error message displays on failed transaction
- ✅ Max button fills input with available balance
- ✅ Accessibility attributes present and correct

## Requirements Met

- [x] Follow Figma design patterns
- [x] Match UI transitions and wallet states accurately
- [x] Ensure responsiveness across devices
- [x] Implement proper wallet connection flow
- [x] Create toggle buttons for claim and burn
- [x] Maintain state transitions and visual feedback
- [x] Include test coverage for wallet states and UI interactions

## Example Commit

```
feat: add claim/burn UI and wallet states
```

Closes issue #96
