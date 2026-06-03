import React, { useState, useEffect } from 'react';

type Mode = 'claim' | 'burn';
type Status = 'idle' | 'confirm' | 'pending' | 'success' | 'error';

interface ClaimBurnProps {
  walletState: string;
  onConnect?: () => void;
  onClaim?: (amount: string) => Promise<string | void>;
  onBurn?: (amount: string) => Promise<string | void>;
  onSwitchNetwork?: () => void;
  onDisconnect?: () => void;
  onRefreshBalance?: () => void;
  publicKey?: string | null;
  balance?: string | null;
  expectedNetwork?: string;
}

function isValidAmount(value: string): boolean {
  const n = Number(value);
  return value.trim() !== '' && !isNaN(n) && n > 0;
}

export function ClaimBurn({
  walletState,
  onConnect,
  onClaim,
  onBurn,
  onSwitchNetwork,
  onDisconnect,
  onRefreshBalance,
  publicKey,
  balance,
  expectedNetwork = 'testnet',
}: ClaimBurnProps) {
  const [mode, setMode] = useState<Mode>('claim');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'success') {
      const timer = setTimeout(() => setStatus('idle'), 3000);
      return () => clearTimeout(timer);
    }
  }, [status]);

  function resetFeedback() {
    setStatus('idle');
    setTxHash(null);
    setErrorMsg('');
  }

  function handleToggle(newMode: Mode) {
    setMode(newMode);
    resetFeedback();
  }

  function handleAmountChange(e: React.ChangeEvent<HTMLInputElement>) {
    setAmount(e.target.value);
    if (status === 'error' || status === 'success') resetFeedback();
  }

  function handleMax() {
    if (balance != null) {
      setAmount(balance);
      resetFeedback();
    }
  }

  function handleRequestSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!isValidAmount(amount)) return;
    setStatus('confirm');
  }

  async function handleConfirm() {
    setStatus('pending');
    setErrorMsg('');
    setTxHash(null);
    try {
      const action = mode === 'claim' ? onClaim : onBurn;
      const hash = await action?.(amount);
      if (hash) setTxHash(hash);
      setStatus('success');
      setAmount('');
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Transaction failed');
    }
  }

  function handleCancel() {
    setStatus('idle');
  }

  if (walletState === 'checking' || walletState === 'connecting') {
    return (
      <div className="wallet-state" data-testid="wallet-connecting">
        <div className="spinner" />
        <p className="wallet-state-message">Connecting to wallet&hellip;</p>
      </div>
    );
  }

  if (walletState === 'disconnected') {
    return (
      <div className="wallet-state" data-testid="wallet-disconnected">
        <h3 className="wallet-state-title">Connect Your Wallet</h3>
        <p className="wallet-state-message">
          Connect your wallet to claim rewards or burn tokens.
        </p>
        <button className="btn btn-connect" onClick={onConnect} data-testid="connect-wallet-btn">
          Connect Wallet
        </button>
      </div>
    );
  }

  if (walletState === 'wrongNetwork') {
    return (
      <div className="wallet-state" data-testid="wallet-wrong-network">
        <h3 className="wallet-state-title">Wrong Network</h3>
        <p className="wallet-state-message">
          Please switch to <strong>{expectedNetwork}</strong>.
        </p>
        <button
          className="btn btn-switch-network"
          onClick={onSwitchNetwork}
          data-testid="switch-network-btn"
        >
          Switch to {expectedNetwork}
        </button>
      </div>
    );
  }

  if (walletState === 'error') {
    return (
      <div className="wallet-state" data-testid="wallet-error">
        <h3 className="wallet-state-title">Connection Error</h3>
        <button className="btn btn-connect" onClick={onConnect} data-testid="retry-connect-btn">
          Try Again
        </button>
      </div>
    );
  }

  const isPending = status === 'pending';
  const showConfirm = status === 'confirm';
  const valid = isValidAmount(amount);

  return (
    <div className="claim-burn" data-testid="claim-burn">
      <h2 className="claim-burn-title">Claim &amp; Burn</h2>

      <div className="toggle" role="group" aria-label="Select mode">
        <button
          type="button"
          className={`toggle-btn${mode === 'claim' ? ' active' : ''}`}
          onClick={() => handleToggle('claim')}
          aria-pressed={mode === 'claim'}
          data-testid="toggle-claim"
        >
          Claim
        </button>
        <button
          type="button"
          className={`toggle-btn${mode === 'burn' ? ' active' : ''}`}
          onClick={() => handleToggle('burn')}
          aria-pressed={mode === 'burn'}
          data-testid="toggle-burn"
        >
          Burn
        </button>
      </div>

      {publicKey && (
        <div className="wallet-info" data-testid="wallet-info">
          <div className="wallet-info-row">
            <span className="wallet-info-address">
              {publicKey.slice(0, 4)}&hellip;{publicKey.slice(-4)}
            </span>
            {onDisconnect && (
              <button className="btn-disconnect" onClick={onDisconnect} data-testid="disconnect-btn">
                Disconnect
              </button>
            )}
          </div>
          {balance != null && (
            <div className="wallet-balance-row">
              <span className="wallet-balance-value" data-testid="wallet-balance">
                {balance} XLM
              </span>
              {onRefreshBalance && (
                <button
                  className="btn-refresh-balance"
                  onClick={onRefreshBalance}
                  data-testid="refresh-balance-btn"
                  title="Refresh balance"
                >
                  ↻
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {showConfirm && (
        <div className="confirm-overlay" data-testid="confirm-overlay">
          <p className="confirm-text">
            {mode === 'claim' ? 'Claim' : 'Burn'} <strong>{amount}</strong> XLM?
          </p>
          <div className="confirm-buttons">
            <button type="button" className="btn btn-cancel" onClick={handleCancel} data-testid="cancel-btn">
              Cancel
            </button>
            <button type="button" className={`btn btn-${mode}`} onClick={handleConfirm} data-testid="confirm-btn">
              Confirm
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleRequestSubmit} data-testid="claim-burn-form">
        <div className="form-group">
          <label htmlFor="amount-input">Amount (XLM)</label>
          <div className="input-row">
            <input
              id="amount-input"
              type="number"
              min="0"
              step="any"
              value={amount}
              onChange={handleAmountChange}
              disabled={isPending}
              placeholder="0.00"
              data-testid="amount-input"
            />
            {mode === 'burn' && balance != null && (
              <button type="button" className="btn-max" onClick={handleMax} disabled={isPending} data-testid="max-btn">
                Max
              </button>
            )}
          </div>
        </div>

        {!showConfirm && (
          <button type="submit" className={`btn btn-${mode}`} disabled={isPending || !valid} data-testid="submit-btn">
            {isPending
              ? mode === 'claim' ? 'Claiming…' : 'Burning…'
              : mode === 'claim' ? 'Claim' : 'Burn'}
          </button>
        )}
      </form>

      {status === 'success' && (
        <p className="feedback success" role="status" data-testid="success-msg">
          {mode === 'claim' ? 'XLM claimed successfully!' : 'XLM burned successfully!'}
          {txHash && <span className="tx-hash">{txHash}</span>}
        </p>
      )}
      {status === 'error' && (
        <p className="feedback error" role="alert" data-testid="error-msg">
          {errorMsg}
        </p>
      )}
    </div>
  );
}
