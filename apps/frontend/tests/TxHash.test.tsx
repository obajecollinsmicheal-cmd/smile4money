import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TxHash } from '../src/components/TxHash';

describe('TxHash', () => {
  beforeEach(() => {
    const clipboard = (navigator as unknown as { clipboard?: { writeText?: unknown } }).clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      });
    } else {
      vi.spyOn(clipboard, 'writeText' as never).mockResolvedValue(undefined);
    }
  });

  it('renders truncated hash and copy button', () => {
    render(<TxHash hash="abcdef0123456789abcdef0123456789" />);
    expect(screen.getByTestId('tx-hash-value')).toHaveTextContent('abcdef01…23456789');
    const copyButton = screen.getByRole('button', { name: 'Copy transaction hash' });
    expect(copyButton).toHaveAttribute('aria-label', 'Copy transaction hash');
  });

  it('copies hash to clipboard and shows copied tooltip', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(<TxHash hash="abcdef0123456789abcdef0123456789" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy transaction hash' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('abcdef0123456789abcdef0123456789'));
    expect(screen.getByTestId('tx-hash-copied')).toBeInTheDocument();
  });
});
