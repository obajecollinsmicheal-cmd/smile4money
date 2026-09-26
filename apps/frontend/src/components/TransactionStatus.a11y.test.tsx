import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import { TransactionStatus } from './TransactionStatus';

describe('TransactionStatus Accessibility with axe', () => {
  const runAxeTests = async (container: Element, testName: string) => {
    const results = await axe.run(container);
    if (results.violations.length > 0) {
      console.log(`Violations in ${testName}:`, results.violations);
    }
    expect(results.violations.length).toBe(0);
  };

  it('should have no accessibility violations when pending', async () => {
    const { container } = render(
      <TransactionStatus status="pending" pendingMessage="Processing..." />,
    );
    await runAxeTests(container, 'pending state');
  });

  it('should have no accessibility violations when success', async () => {
    const { container } = render(
      <TransactionStatus
        status="success"
        successMessage="Transaction successful!"
        txHash="abc123def456"
      />,
    );
    await runAxeTests(container, 'success state');
  });

  it('should have no accessibility violations when error', async () => {
    const { container } = render(
      <TransactionStatus
        status="error"
        errorMessage="Transaction failed"
      />,
    );
    await runAxeTests(container, 'error state');
  });

  it('should have no accessibility violations when idle', async () => {
    const { container } = render(<TransactionStatus status="idle" />);
    await runAxeTests(container, 'idle state');
  });

  it('should have no accessibility violations with dismiss button', async () => {
    const { container } = render(
      <TransactionStatus
        status="success"
        successMessage="Success!"
        onDismiss={() => {}}
      />,
    );
    await runAxeTests(container, 'success with dismiss button');
  });

  it('should properly announce status updates via live region', async () => {
    const { container, rerender } = render(
      <TransactionStatus status="idle" />,
    );

    // Check for aria-live and aria-atomic attributes
    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).toBeInTheDocument();
    expect(liveRegion).toHaveAttribute('aria-atomic', 'true');
    expect(liveRegion).toHaveAttribute('role', 'status');

    // Verify no violations with live region in place
    await runAxeTests(container, 'idle with live region');

    // Update to pending and verify no violations
    rerender(<TransactionStatus status="pending" pendingMessage="Processing..." />);
    await runAxeTests(container, 'pending transition');

    // Update to success and verify no violations
    rerender(
      <TransactionStatus
        status="success"
        successMessage="Success!"
        txHash="abc123"
      />,
    );
    await runAxeTests(container, 'success transition');
  });

  it('should verify live region attributes are correct', () => {
    const { container } = render(
      <TransactionStatus status="success" successMessage="Done!" />,
    );

    const liveRegion = container.querySelector('[role="status"]');
    expect(liveRegion).toBeInTheDocument();
    expect(liveRegion).toHaveAttribute('aria-live', 'polite');
    expect(liveRegion).toHaveAttribute('aria-atomic', 'true');

    // Verify live region is not hidden from accessibility tree
    expect(liveRegion).not.toHaveAttribute('aria-hidden', 'true');
  });
});
