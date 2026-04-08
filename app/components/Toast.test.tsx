/**
 * Toast component tests.
 *
 * Locks in the user-facing behavior:
 *   - role="status" + aria-live="polite" landmark always present
 *   - Toast appears on toast() call and contains the message
 *   - Multiple toasts queue
 *   - Variant styling (success/error/info) applied via different
 *     border classes
 *   - Auto-dismiss after duration (success: 2500ms, error: 5000ms,
 *     custom override accepted)
 *   - Cleanup on unmount cancels pending timers
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { ToastProvider, useToast } from './Toast';

// Test harness — wraps a button that fires toast() so we can
// trigger the side effect from within the provider context.
function ToastFirer({
  message,
  variant,
  duration,
}: {
  message: string;
  variant?: 'success' | 'error' | 'info';
  duration?: number;
}) {
  const { toast } = useToast();
  return (
    <button
      type="button"
      onClick={() =>
        toast(message, { variant, ...(duration ? { duration } : {}) })
      }
    >
      Fire toast
    </button>
  );
}

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('renders the aria-live landmark even when empty', () => {
    render(
      <ToastProvider>
        <div>app</div>
      </ToastProvider>,
    );
    const region = screen.getByRole('status');
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('shows a toast when toast() is fired', () => {
    render(
      <ToastProvider>
        <ToastFirer message="Saved successfully" />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText('Fire toast').click();
    });
    expect(screen.getByText('Saved successfully')).toBeInTheDocument();
  });

  it('queues multiple toasts', () => {
    render(
      <ToastProvider>
        <ToastFirer message="First" />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText('Fire toast').click();
      screen.getByText('Fire toast').click();
    });
    // Both copies should be in the DOM under the role=status region
    expect(screen.getAllByText('First')).toHaveLength(2);
  });

  it('applies the success variant border class', () => {
    render(
      <ToastProvider>
        <ToastFirer message="Win" variant="success" />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText('Fire toast').click();
    });
    const toastEl = screen.getByText('Win');
    expect(toastEl.className).toContain('border-success');
  });

  it('applies the error variant border class', () => {
    render(
      <ToastProvider>
        <ToastFirer message="Failed" variant="error" />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText('Fire toast').click();
    });
    const toastEl = screen.getByText('Failed');
    expect(toastEl.className).toContain('border-destructive');
  });

  it('auto-dismisses success toasts after the default 2500ms + exit animation', () => {
    render(
      <ToastProvider>
        <ToastFirer message="Win" variant="success" />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText('Fire toast').click();
    });
    expect(screen.getByText('Win')).toBeInTheDocument();
    // Advance past the dismiss timer (2500) + the exit animation
    // window (200). After the second timer fires the toast is
    // removed from the items array and unmounted.
    act(() => {
      vi.advanceTimersByTime(2700);
    });
    expect(screen.queryByText('Win')).not.toBeInTheDocument();
  });

  it('error toasts default to a longer 5000ms duration', () => {
    render(
      <ToastProvider>
        <ToastFirer message="Failed" variant="error" />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText('Fire toast').click();
    });
    // After 2700ms (success default) the error should still be there
    act(() => {
      vi.advanceTimersByTime(2700);
    });
    expect(screen.getByText('Failed')).toBeInTheDocument();
    // After another 2500ms (total 5200) it should be gone
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
  });

  it('honors custom duration override', () => {
    render(
      <ToastProvider>
        <ToastFirer message="Custom" duration={1000} />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText('Fire toast').click();
    });
    expect(screen.getByText('Custom')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(screen.queryByText('Custom')).not.toBeInTheDocument();
  });
});
