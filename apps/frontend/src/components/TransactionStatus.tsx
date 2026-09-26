import React from 'react';
import { TxHash } from './TxHash';

export type TransactionStatusType = 'idle' | 'pending' | 'success' | 'error';

interface TransactionStatusProps {
  status: TransactionStatusType;
  successMessage?: string;
  errorMessage?: string;
  txHash?: string | null;
  pendingMessage?: string;
  onDismiss?: () => void;
  testId?: string;
  className?: string;
  /** Optional: render a custom link for the tx hash instead of default TxHash component */
  renderTxHashLink?: (hash: string) => React.ReactNode;
}

/**
 * TransactionStatus Component
 *
 * A reusable, accessible component for displaying transaction status updates.
 * Uses aria-live="polite" and aria-atomic="true" to announce status changes to screen readers.
 *
 * The live region is always present in the DOM but hidden visually when status is 'idle'.
 * This ensures smooth announcements as status updates occur.
 *
 * @example
 * ```tsx
 * <TransactionStatus
 *   status={status}
 *   pendingMessage="Processing your transaction..."
 *   successMessage="Transaction completed!"
 *   errorMessage={errorMsg}
 *   txHash={txHash}
 * />
 * ```
 */
export function TransactionStatus({
  status,
  successMessage = 'Transaction successful!',
  errorMessage = 'Transaction failed',
  txHash = null,
  pendingMessage = 'Processing transaction...',
  onDismiss,
  testId = 'transaction-status',
  className = '',
  renderTxHashLink,
}: TransactionStatusProps) {
  // Only show content when status is not 'idle'
  const isVisible = status !== 'idle';

  // Determine the message and styling based on status
  const getMessage = (): string => {
    switch (status) {
      case 'pending':
        return pendingMessage;
      case 'success':
        return successMessage;
      case 'error':
        return errorMessage;
      default:
        return '';
    }
  };

  const getClassName = (): string => {
    const baseClasses =
      'rounded-lg p-3 text-sm font-medium transition-all duration-200 overflow-hidden';
    const statusClasses = {
      idle: 'hidden',
      pending:
        'dark:bg-blue-900/30 dark:border-blue-800 dark:text-blue-400 border border-blue-200 bg-blue-50 text-blue-800',
      success:
        'dark:bg-emerald-900/30 dark:border-emerald-800 dark:text-emerald-400 border border-emerald-200 bg-emerald-50 text-emerald-800',
      error:
        'dark:bg-red-900/30 dark:border-red-800 dark:text-red-400 border border-red-200 bg-red-50 text-red-800',
    };

    return `${baseClasses} ${statusClasses[status]} ${className}`;
  };

  const message = getMessage();

  return (
    <div
      data-testid={testId}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={getClassName()}
    >
      {isVisible && (
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <p className="mb-2">{message}</p>
            {txHash && (
              <div className="mt-2 text-xs">
                {renderTxHashLink ? (
                  renderTxHashLink(txHash)
                ) : (
                  <a
                    href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="dark:text-blue-300 dark:hover:text-blue-200 break-all font-mono underline hover:no-underline"
                    aria-label={`View transaction ${txHash} on Stellar Expert`}
                  >
                    {txHash.slice(0, 8)}…{txHash.slice(-8)} ↗
                  </a>
                )}
              </div>
            )}
          </div>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="shrink-0 p-1"
              aria-label="Dismiss message"
              data-testid="dismiss-btn"
            >
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default TransactionStatus;
