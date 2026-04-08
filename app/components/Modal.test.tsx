/**
 * Modal accessibility tests.
 *
 * Locks in the WCAG 2.1 AA invariants the Modal component is
 * supposed to satisfy:
 *   - role="dialog" + aria-modal="true"
 *   - aria-labelledby wired to the title
 *   - aria-describedby wired when description provided
 *   - Escape closes (unless locked)
 *   - Click on backdrop closes (unless locked)
 *   - Click inside dialog does NOT close
 *   - Locked modals reject Escape and backdrop click
 *   - Focus moves into the dialog on open
 *   - First focusable element receives initial focus
 *
 * These are the kinds of regressions that are easy to introduce
 * with a "small refactor" and impossible to catch by eye. Lock them
 * down once and forget about them.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { useState } from 'react';
import { Modal } from './Modal';

// Test harness — useState wrapper so we can verify onClose actually
// fires (the parent typically toggles `open` from `true` → `false`).
function TestHost(props: {
  initiallyOpen?: boolean;
  locked?: boolean;
  description?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(props.initiallyOpen ?? true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Confirm withdrawal"
        description={props.description}
        locked={props.locked}
      >
        {props.children ?? (
          <>
            <input type="text" placeholder="Amount" aria-label="Amount" />
            <button type="button">Cancel</button>
            <button type="submit">Confirm</button>
          </>
        )}
      </Modal>
    </>
  );
}

describe('Modal — accessibility', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders with role=dialog and aria-modal', () => {
    render(<TestHost />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('wires aria-labelledby to the title', () => {
    render(<TestHost />);
    const dialog = screen.getByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const title = document.getElementById(labelledBy!);
    expect(title).toHaveTextContent('Confirm withdrawal');
  });

  it('wires aria-describedby when description is provided', () => {
    render(<TestHost description="Sends 10 HBAR back to your wallet" />);
    const dialog = screen.getByRole('dialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const desc = document.getElementById(describedBy!);
    expect(desc).toHaveTextContent('Sends 10 HBAR back to your wallet');
  });

  it('omits aria-describedby when no description provided', () => {
    render(<TestHost />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).not.toHaveAttribute('aria-describedby');
  });

  it('closes on Escape key (when not locked)', async () => {
    render(<TestHost />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Wait for focus to land inside the dialog (rAF) before
    // dispatching the keyboard event — otherwise the keydown
    // hits document.body and never reaches the dialog's
    // onKeyDown handler.
    await waitFor(() => {
      expect(screen.getByLabelText('Amount')).toHaveFocus();
    });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('does NOT close on Escape when locked', async () => {
    render(<TestHost locked />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('Amount')).toHaveFocus();
    });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    // Wait a beat to make sure no async state change fires
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes on backdrop click (when not locked)', async () => {
    render(<TestHost />);
    const dialog = screen.getByRole('dialog');
    // Backdrop is the parent of the dialog
    const backdrop = dialog.parentElement!;
    fireEvent.click(backdrop);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('does NOT close on backdrop click when locked', () => {
    render(<TestHost locked />);
    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.parentElement!;
    fireEvent.click(backdrop);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does NOT close when clicking inside the dialog', () => {
    render(<TestHost />);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('moves focus into the dialog on open', async () => {
    render(<TestHost />);
    // First focusable inside the dialog is the Amount input
    await waitFor(() => {
      const input = screen.getByLabelText('Amount');
      expect(input).toHaveFocus();
    });
  });
});
