'use client';

import { Modal } from '../components/Modal';
import { formatAmount, tokenSymbol } from './helpers';
import type { StatusResponse, TokenBalanceEntry } from './types';

// ---------------------------------------------------------------------------
// WithdrawModal
// ---------------------------------------------------------------------------
//
// Self-contained Withdraw form. Extracted from app/dashboard/page.tsx
// during the #212 refactor — was an inline ~200-line IIFE block in the
// page render.
//
// Owns NO state. The dashboard page passes value/handlers via props so
// the page is still the source of truth for withdrawAmount + token. This
// keeps the post-submit balance patch logic on the page side without
// having to thread setStatus through the modal API.
//
// Velocity gating:
//   - Reads `velocity` from the user's status response (per-token cap +
//     remaining counter)
//   - Computes `overCap` and disables the submit button + shows a
//     destructive helper line when the requested amount > remaining
//   - The Max button respects the cap so a fat-finger Max click can't
//     blow past the daily allowance
//
// Tone:
//   - Modal uses the default brand border, not destructive. The
//     previous version wore a red border constantly which read as
//     "everything is angry." The destructive accent now lives ONLY
//     on the input field when the user enters an amount over the
//     velocity cap — so the red only appears at the moment of an
//     actual mistake, not as ambient chrome.

export interface WithdrawModalProps {
  open: boolean;
  onClose: () => void;
  status: StatusResponse | null;
  withdrawToken: string;
  setWithdrawToken: (token: string) => void;
  withdrawAmount: string;
  setWithdrawAmount: (amount: string) => void;
  withdrawLoading: boolean;
  onSubmit: () => void;
  /** Sorted [tokenKey, entry] pairs from status.balances.tokens. */
  balanceEntries: [string, TokenBalanceEntry][];
}

export function WithdrawModal({
  open,
  onClose,
  status,
  withdrawToken,
  setWithdrawToken,
  withdrawAmount,
  setWithdrawAmount,
  withdrawLoading,
  onSubmit,
  balanceEntries,
}: WithdrawModalProps) {
  const velocity = status?.velocity?.[withdrawToken];
  const amountNum = Number(withdrawAmount);
  const overCap =
    velocity?.remaining != null &&
    Number.isFinite(amountNum) &&
    amountNum > 0 &&
    amountNum > velocity.remaining;

  const tokenEntry = balanceEntries.find(([k]) => k === withdrawToken);
  const available = tokenEntry?.[1].available ?? 0;
  const cap = velocity?.remaining;
  const maxAmount = cap != null ? Math.min(available, cap) : available;

  return (
    <Modal
      open={open}
      onClose={onClose}
      locked={withdrawLoading}
      title="Cash out"
      description="Funds will be sent to your registered Hedera account."
    >
      <div className="mb-5">
        <label htmlFor="withdraw-token" className="label-caps mb-2 block">
          Token
        </label>
        <select
          id="withdraw-token"
          value={withdrawToken}
          onChange={(e) => setWithdrawToken(e.target.value)}
          disabled={withdrawLoading}
          className="w-full border-2 border-secondary bg-[var(--color-panel)] px-4 py-3 text-sm text-foreground transition-colors focus:border-brand disabled:opacity-50"
        >
          {balanceEntries.map(([key, entry]) => (
            <option key={key} value={key}>
              {tokenSymbol(key)} (available: {formatAmount(entry.available)})
            </option>
          ))}
        </select>
      </div>

      <div className="mb-3">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <label htmlFor="withdraw-amount" className="label-caps">
            Amount
          </label>
          {/* Max button — fills in the full available balance, respecting
              the daily velocity cap if one is set. Standard dApp convention;
              reduces fat-finger precision errors when withdrawing the
              full pot. */}
          {maxAmount > 0 && (
            <button
              type="button"
              onClick={() => setWithdrawAmount(String(maxAmount))}
              disabled={withdrawLoading}
              className="font-pixel text-[10px] uppercase tracking-wider text-brand transition-colors hover:text-foreground disabled:opacity-50"
            >
              Max ({formatAmount(maxAmount)})
            </button>
          )}
        </div>
        <input
          id="withdraw-amount"
          type="number"
          min="0"
          step="any"
          inputMode="decimal"
          autoComplete="off"
          value={withdrawAmount}
          onChange={(e) => setWithdrawAmount(e.target.value)}
          disabled={withdrawLoading}
          placeholder="0.00"
          aria-invalid={overCap || undefined}
          aria-describedby={velocity?.cap != null ? 'withdraw-velocity' : undefined}
          className={`w-full border-2 px-4 py-3 font-mono text-sm text-foreground placeholder:text-muted transition-colors disabled:opacity-50 ${
            overCap
              ? 'border-destructive bg-destructive/10 focus:border-destructive'
              : 'border-secondary bg-[var(--color-panel)] focus:border-brand'
          }`}
        />
      </div>

      {/* Daily velocity cap counter — shown only when a cap is set */}
      {velocity?.cap != null && (
        <p
          id="withdraw-velocity"
          className={`mb-5 type-caption ${overCap ? 'text-destructive' : ''}`}
        >
          Daily limit: {formatAmount(velocity.usedToday)} /{' '}
          {formatAmount(velocity.cap)} {tokenSymbol(withdrawToken)} used
          {velocity.remaining != null && (
            <>
              {' '}
              — <span className="text-foreground num-tabular">{formatAmount(velocity.remaining)}</span> remaining today
            </>
          )}
        </p>
      )}

      {overCap && (
        <p className="mb-5 border-l-2 border-destructive bg-destructive/10 px-4 py-3 text-xs text-destructive">
          Amount exceeds your remaining daily limit. Try a smaller
          amount or wait for the 24-hour rolling window to refresh.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onClose}
          disabled={withdrawLoading}
          className="btn-ghost-sm"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={withdrawLoading || !withdrawAmount || overCap}
          className="btn-primary-sm"
        >
          {withdrawLoading ? 'Withdrawing…' : 'Confirm withdraw'}
        </button>
      </div>
    </Modal>
  );
}
