import React, { useEffect, useMemo, useState } from 'react';
import '../styles/claim-burn.css';

type Mode = 'claim' | 'burn';
type Phase = 'idle' | 'confirm' | 'pending' | 'success' | 'error';

type WalletStateProp =
  | string
  | { status: string; balance?: string | null; address?: string | null };

interface ClaimBurnProps {
  walletState: WalletStateProp;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onRefreshBalance?: () => void;
  onClaim?: (amount: string) => Promise<string | void>;
  onBurn?: (amount: string) => Promise<string | void>;
  onSwitchNetwork?: () => void;
  publicKey?: string | null;
  balance?: string | null;
  expectedNetwork?: string;
  className?: string;
}

function isValidAmount(value: string): boolean {
  const n = Number(value);
  return value.trim() !== '' && !Number.isNaN(n) && n > 0;
}

function stripTrailingZeros(value: string): string {
  const n = Number(value);
  return Number.isNaN(n) ? value : String(n);
}

export function ClaimBurn({
  walletState,
  onConnect,
  onDisconnect,
  onRefreshBalance,
  onClaim,
  onBurn,
  onSwitchNetwork,
  publicKey,
  balance: balanceProp,
  expectedNetwork = 'testnet',
  className = '',
}: ClaimBurnProps) {
  const [mode, setMode] = useState<Mode>('claim');
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);

  const stateKey =
    typeof walletState === 'string' ? walletState : walletState.status;

  const walletBalance =
    balanceProp ??
    (typeof walletState === 'object' ? walletState.balance ?? null : null);

  const connectedAddress =
    publicKey ??
    (typeof walletState === 'object' ? walletState.address ?? null : null);

  const balanceNum = useMemo(
    () =>
      walletBalance !== null && walletBalance !== undefined
        ? Number(walletBalance)
        : null,
    [walletBalance],
  );

  const exceedsBalance = useMemo(
    () =>
      mode === 'burn' &&
      balanceNum !== null &&
      isValidAmount(amount) &&
      Number(amount) > balanceNum,
    [amount, balanceNum, mode],
  );

  const valid = isValidAmount(amount) && !exceedsBalance;
  const isPending = phase === 'pending';
  const showConfirmation = phase === 'confirm';

  function resetFeedback() {
    setPhase('idle');
    setTxHash(null);
    setErrorMsg('');
  }

  useEffect(() => {
    if (phase === 'success') {
      const timer = window.setTimeout(() => setPhase('idle'), 3000);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [phase]);

  function handleModeChange(newMode: Mode) {
    if (newMode !== mode) {
      setMode(newMode);
      resetFeedback();
      setAmount('');
    }
  }

  function handleAmountChange(e: React.ChangeEvent<HTMLInputElement>) {
    setAmount(e.target.value);
    if (phase !== 'idle') {
      resetFeedback();
    }
  }

  function handleMax() {
    if (walletBalance !== null && walletBalance !== undefined) {
      setAmount(stripTrailingZeros(walletBalance));
      resetFeedback();
    }
  }

  function handleRequestSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!valid) return;
    setPhase('confirm');
  }

  async function handleConfirm() {
    setPhase('pending');
    setErrorMsg('');
    setTxHash(null);

    try {
      const action = mode === 'claim' ? onClaim : onBurn;
      const hash = await action?.(amount);
      if (hash) setTxHash(hash);
      setPhase('success');
      setAmount('');
    } catch (err) {
      setPhase('error');
      setErrorMsg(err instanceof Error ? err.message : 'Transaction failed');
    }
  }

  function handleCancel() {
    setPhase('idle');
  }

  if (stateKey === 'checking') {
    return (
      <div className="wallet-state" data-testid="wallet-connecting">
        <div className="spinner" />
        <p className="wallet-state-message">Checking Freighter status…</p>
      </div>
    );
  }

  if (stateKey === 'connecting') {
    return (
      <div className="wallet-state" data-testid="wallet-connecting">
        <div className="spinner" />
        <p className="wallet-state-message">Connecting to Freighter…</p>
      </div>
    );
  }

  if (stateKey === 'notInstalled') {
    return (
      <div className="wallet-state" data-testid="wallet-not-installed">
        <div className="wallet-state-icon">💼</div>
        <h3 className="wallet-state-title">Freighter Not Found</h3>
        <p className="wallet-state-message">
          Please install the{' '}
          <a href="https://freighter.app" target="_blank" rel="noopener noreferrer">
            Freighter wallet extension
          </a>{' '}
          to continue.
        </p>
      </div>
    );
  }

  if (stateKey === 'disconnected') {
    return (
      <div className="wallet-state" data-testid="wallet-disconnected">
        <div className="wallet-state-icon">💼</div>
        <h3 className="wallet-state-title">Connect Your Wallet</h3>
        <p className="wallet-state-message">
          Connect your Freighter wallet to claim rewards or burn tokens.
        </p>
        <button
          type="button"
          className="btn btn-connect"
          onClick={onConnect}
          data-testid="connect-wallet-btn"
        >
          Connect Wallet
        </button>
      </div>
    );
  }

  if (stateKey === 'wrongNetwork') {
    return (
      <div className="wallet-state" data-testid="wallet-wrong-network">
        <div className="wallet-state-icon">🌐</div>
        <h3 className="wallet-state-title">Wrong Network</h3>
        <p className="wallet-state-message">
          Please switch your Freighter wallet to <strong>{expectedNetwork}</strong>.
        </p>
        <button
          type="button"
          className="btn btn-switch-network"
          onClick={onSwitchNetwork}
          data-testid="switch-network-btn"
        >
          Switch to {expectedNetwork}
        </button>
      </div>
    );
  }

  if (stateKey === 'error') {
    return (
      <div className="wallet-state" data-testid="wallet-error">
        <div className="wallet-state-icon">⚠️</div>
        <h3 className="wallet-state-title">Connection Error</h3>
        <p className="wallet-state-message">
          {errorMsg || 'An error occurred while connecting to your wallet.'}
        </p>
        <button
          type="button"
          className="btn btn-connect"
          onClick={onConnect}
          data-testid="retry-connect-btn"
        >
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className={`claim-burn ${className}`.trim()} data-testid="claim-burn">
      <h2 className="claim-burn-title">Claim &amp; Burn</h2>

      <div className="toggle" role="group" aria-label="Select mode">
        <button
          type="button"
          className={`toggle-btn${mode === 'claim' ? ' active' : ''}`}
          onClick={() => handleModeChange('claim')}
          aria-pressed={mode === 'claim'}
          data-testid="toggle-claim"
        >
          Claim
        </button>
        <button
          type="button"
          className={`toggle-btn${mode === 'burn' ? ' active' : ''}`}
          onClick={() => handleModeChange('burn')}
          aria-pressed={mode === 'burn'}
          data-testid="toggle-burn"
        >
          Burn
        </button>
      </div>

      {connectedAddress && (
        <div className="wallet-info" data-testid="wallet-info">
          <div className="wallet-info-row">
            <span className="wallet-info-label">Connected</span>
            <span className="wallet-info-address">
              {connectedAddress.slice(0, 4)}&hellip;{connectedAddress.slice(-4)}
            </span>
            <button
              type="button"
              className="btn-refresh-balance"
              onClick={onRefreshBalance}
              data-testid="refresh-balance-btn"
              title="Refresh balance"
            >
              ↻
            </button>
            {onDisconnect && (
              <button
                type="button"
                className="btn btn-connect"
                onClick={onDisconnect}
                style={{ marginLeft: '0.5rem' }}
              >
                Disconnect
              </button>
            )}
          </div>
          {walletBalance !== null && walletBalance !== undefined && (
            <div className="wallet-balance-row">
              <span className="wallet-balance-label">Balance</span>
              <span className="wallet-balance-value" data-testid="wallet-balance">
                {stripTrailingZeros(walletBalance)} XLM
              </span>
            </div>
          )}
        </div>
      )}

      {showConfirmation ? (
        <div className="confirm-overlay" data-testid="confirm-overlay">
          <p className="confirm-text">
            {mode === 'claim' ? 'Claim' : 'Burn'} <strong>{amount}</strong> XLM?
          </p>
          <div className="confirm-actions">
            <button
              type="button"
              className="btn btn-cancel"
              onClick={handleCancel}
              data-testid="cancel-btn"
            >
              Cancel
            </button>
            <button
              type="button"
              className={`btn btn-${mode}`}
              onClick={handleConfirm}
              data-testid="confirm-btn"
              disabled={isPending}
            >
              {isPending ? 'Processing...' : 'Confirm'}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleRequestSubmit} data-testid="claim-burn-form">
          <label htmlFor="amount">Amount (XLM)</label>
          <div className="input-row">
            <input
              id="amount"
              type="number"
              min="0"
              step="any"
              value={amount}
              onChange={handleAmountChange}
              placeholder="0.00"
              disabled={isPending}
              data-testid="amount-input"
            />
            {mode === 'burn' && walletBalance !== null && walletBalance !== undefined && (
              <button
                type="button"
                className="btn-max"
                onClick={handleMax}
                disabled={isPending}
                data-testid="max-btn"
              >
                Max
              </button>
            )}
          </div>
          <button
            type="submit"
            className={`btn btn-${mode}`}
            disabled={isPending || !valid}
            data-testid="submit-btn"
          >
            {mode === 'claim' ? 'Claim' : 'Burn'}
          </button>
          {exceedsBalance && (
            <p className="feedback error" role="alert" data-testid="error-msg">
              Amount exceeds balance.
            </p>
          )}
        </form>
      )}

      <div aria-live="polite" aria-atomic="true">
        {phase === 'success' && (
          <div className="feedback success" role="status" data-testid="success-msg">
            <p>{mode === 'claim' ? 'XLM claimed successfully!' : 'XLM burned successfully!'}</p>
            {txHash && (
              <p className="tx-hash" data-testid="tx-hash">
                TX: {txHash.slice(0, 8)}&hellip;{txHash.slice(-6)}
              </p>
            )}
          </div>
        )}
        {phase === 'error' && (
          <p className="feedback error" role="alert" data-testid="error-msg">
            {errorMsg}
          </p>
        )}
      </div>
    </div>
  );
}
