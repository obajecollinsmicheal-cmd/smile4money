import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TransactionStatus, type TransactionStatusType } from './TransactionStatus';

describe('TransactionStatus Component', () => {
  describe('aria-live region presence', () => {
    it('should render with aria-live="polite" attribute', () => {
      const { container } = render(<TransactionStatus status="idle" />);
      const liveRegion = container.querySelector('[aria-live="polite"]');
      expect(liveRegion).toBeInTheDocument();
    });

    it('should render with aria-atomic="true" attribute', () => {
      const { container } = render(<TransactionStatus status="idle" />);
      const liveRegion = container.querySelector('[aria-atomic="true"]');
      expect(liveRegion).toBeInTheDocument();
    });

    it('should have role="status" for screen reader context', () => {
      const { container } = render(<TransactionStatus status="idle" />);
      const liveRegion = container.querySelector('[role="status"]');
      expect(liveRegion).toBeInTheDocument();
    });

    it('should be in the DOM even when status is idle (not hidden from accessibility tree)', () => {
      const { container } = render(<TransactionStatus status="idle" />);
      const liveRegion = container.querySelector('[aria-live="polite"]');
      expect(liveRegion).toBeInTheDocument();
    });
  });

  describe('status messages', () => {
    it('should display pending message when status is pending', () => {
      render(<TransactionStatus status="pending" pendingMessage="Processing..." />);
      expect(screen.getByText('Processing...')).toBeInTheDocument();
    });

    it('should display success message when status is success', () => {
      render(
        <TransactionStatus
          status="success"
          successMessage="Transaction completed successfully!"
        />,
      );
      expect(screen.getByText('Transaction completed successfully!')).toBeInTheDocument();
    });

    it('should display error message when status is error', () => {
      render(
        <TransactionStatus
          status="error"
          errorMessage="Something went wrong"
        />,
      );
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });

    it('should not display any message when status is idle', () => {
      render(
        <TransactionStatus
          status="idle"
          successMessage="Success"
          errorMessage="Error"
          pendingMessage="Pending"
        />,
      );
      expect(screen.queryByText('Success')).not.toBeInTheDocument();
      expect(screen.queryByText('Error')).not.toBeInTheDocument();
      expect(screen.queryByText('Pending')).not.toBeInTheDocument();
    });
  });

  describe('transaction hash display', () => {
    it('should display transaction hash when provided with success status', () => {
      const txHash = 'abc123def456ghi789jkl012mno345pqr678stu';
      render(<TransactionStatus status="success" txHash={txHash} />);
      expect(screen.getByText(/abc123.*stu/)).toBeInTheDocument();
    });

    it('should truncate long hash for display', () => {
      const txHash = 'abc123def456ghi789jkl012mno345pqr678stu';
      render(<TransactionStatus status="success" txHash={txHash} />);
      const link = screen.getByRole('link');
      expect(link.textContent).toMatch(/^abc123.*stu/);
    });

    it('should not display hash when status is idle', () => {
      const txHash = 'abc123def456ghi789jkl012mno345pqr678stu';
      render(<TransactionStatus status="idle" txHash={txHash} />);
      expect(screen.queryByText(/abc123.*stu/)).not.toBeInTheDocument();
    });

    it('should render transaction hash link with correct href', () => {
      const txHash = 'abc123def456ghi789jkl012mno345pqr678stu';
      render(<TransactionStatus status="success" txHash={txHash} />);
      const link = screen.getByRole('link');
      expect(link).toHaveAttribute(
        'href',
        `https://stellar.expert/explorer/testnet/tx/${txHash}`,
      );
    });

    it('should support custom tx hash link renderer', () => {
      const txHash = 'abc123def456ghi789jkl012mno345pqr678stu';
      const customRenderer = vi.fn((hash) => <div>Custom: {hash}</div>);
      render(
        <TransactionStatus
          status="success"
          txHash={txHash}
          renderTxHashLink={customRenderer}
        />,
      );
      expect(customRenderer).toHaveBeenCalledWith(txHash);
      expect(screen.getByText(/Custom: abc123/)).toBeInTheDocument();
    });
  });

  describe('dismiss functionality', () => {
    it('should render dismiss button when onDismiss callback is provided', () => {
      const onDismiss = vi.fn();
      render(<TransactionStatus status="success" onDismiss={onDismiss} />);
      expect(screen.getByTestId('dismiss-btn')).toBeInTheDocument();
    });

    it('should not render dismiss button when onDismiss is not provided', () => {
      render(<TransactionStatus status="success" />);
      expect(screen.queryByTestId('dismiss-btn')).not.toBeInTheDocument();
    });

    it('should call onDismiss when dismiss button is clicked', async () => {
      const onDismiss = vi.fn();
      const user = userEvent.setup();
      render(<TransactionStatus status="success" onDismiss={onDismiss} />);
      await user.click(screen.getByTestId('dismiss-btn'));
      expect(onDismiss).toHaveBeenCalledOnce();
    });

    it('should have accessible dismiss button label', () => {
      const onDismiss = vi.fn();
      render(<TransactionStatus status="success" onDismiss={onDismiss} />);
      expect(screen.getByLabelText('Dismiss message')).toBeInTheDocument();
    });
  });

  describe('styling and visibility', () => {
    it('should apply idle class when status is idle (making content hidden)', () => {
      const { container } = render(<TransactionStatus status="idle" />);
      const statusDiv = container.firstChild as HTMLElement;
      expect(statusDiv.className).toContain('hidden');
    });

    it('should apply pending class when status is pending', () => {
      const { container } = render(<TransactionStatus status="pending" />);
      const statusDiv = container.firstChild as HTMLElement;
      expect(statusDiv.className).toContain('blue');
    });

    it('should apply success class when status is success', () => {
      const { container } = render(<TransactionStatus status="success" />);
      const statusDiv = container.firstChild as HTMLElement;
      expect(statusDiv.className).toContain('emerald');
    });

    it('should apply error class when status is error', () => {
      const { container } = render(<TransactionStatus status="error" />);
      const statusDiv = container.firstChild as HTMLElement;
      expect(statusDiv.className).toContain('red');
    });

    it('should merge custom className with status classes', () => {
      const { container } = render(
        <TransactionStatus status="success" className="custom-class" />,
      );
      const statusDiv = container.firstChild as HTMLElement;
      expect(statusDiv.className).toContain('custom-class');
      expect(statusDiv.className).toContain('emerald');
    });
  });

  describe('accessibility attributes', () => {
    it('should have proper ARIA labels on links', () => {
      const txHash = 'abc123def456ghi789jkl012mno345pqr678stu';
      render(<TransactionStatus status="success" txHash={txHash} />);
      expect(
        screen.getByLabelText(`View transaction ${txHash} on Stellar Expert`),
      ).toBeInTheDocument();
    });

    it('should have proper label on dismiss button', () => {
      render(<TransactionStatus status="success" onDismiss={() => {}} />);
      expect(screen.getByLabelText('Dismiss message')).toBeInTheDocument();
    });

    it('should announce status changes as polite announcements', () => {
      const { rerender, container } = render(<TransactionStatus status="idle" />);
      let liveRegion = container.querySelector('[aria-live="polite"]');
      expect(liveRegion).toHaveAttribute('aria-live', 'polite');

      rerender(<TransactionStatus status="pending" pendingMessage="Processing..." />);
      liveRegion = container.querySelector('[aria-live="polite"]');
      expect(liveRegion).toHaveAttribute('aria-live', 'polite');
      expect(liveRegion).toHaveTextContent('Processing...');
    });

    it('should announce all content atomically when status changes', () => {
      const { rerender, container } = render(
        <TransactionStatus
          status="success"
          successMessage="Success!"
          txHash="abc123"
        />,
      );
      const liveRegion = container.querySelector('[aria-atomic="true"]');
      expect(liveRegion).toHaveAttribute('aria-atomic', 'true');

      rerender(
        <TransactionStatus status="error" errorMessage="Error!" />,
      );
      const updated = container.querySelector('[aria-atomic="true"]');
      expect(updated).toHaveAttribute('aria-atomic', 'true');
    });
  });

  describe('data testing', () => {
    it('should use custom testId when provided', () => {
      render(<TransactionStatus status="success" testId="custom-test-id" />);
      expect(screen.getByTestId('custom-test-id')).toBeInTheDocument();
    });

    it('should use default testId when not provided', () => {
      render(<TransactionStatus status="success" />);
      expect(screen.getByTestId('transaction-status')).toBeInTheDocument();
    });
  });

  describe('integration scenarios', () => {
    it('should handle status transitions from pending to success', () => {
      const { rerender } = render(
        <TransactionStatus status="pending" pendingMessage="Waiting..." />,
      );
      expect(screen.getByText('Waiting...')).toBeInTheDocument();

      rerender(
        <TransactionStatus
          status="success"
          successMessage="Done!"
          txHash="abc123"
        />,
      );
      expect(screen.queryByText('Waiting...')).not.toBeInTheDocument();
      expect(screen.getByText('Done!')).toBeInTheDocument();
    });

    it('should handle status transitions from pending to error', () => {
      const { rerender } = render(
        <TransactionStatus status="pending" pendingMessage="Waiting..." />,
      );
      expect(screen.getByText('Waiting...')).toBeInTheDocument();

      rerender(
        <TransactionStatus status="error" errorMessage="Failed!" />,
      );
      expect(screen.queryByText('Waiting...')).not.toBeInTheDocument();
      expect(screen.getByText('Failed!')).toBeInTheDocument();
    });

    it('should handle reset to idle state', () => {
      const { rerender } = render(
        <TransactionStatus status="success" successMessage="Success!" />,
      );
      expect(screen.getByText('Success!')).toBeInTheDocument();

      rerender(<TransactionStatus status="idle" />);
      expect(screen.queryByText('Success!')).not.toBeInTheDocument();
    });
  });
});
