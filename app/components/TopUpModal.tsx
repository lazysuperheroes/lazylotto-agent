'use client';

import { useCallback } from 'react';
import { Modal } from './Modal';
import { useToast } from './Toast';

// ---------------------------------------------------------------------------
// TopUpModal
// ---------------------------------------------------------------------------
//
// The replacement for the old "Fund Your Account" collapsible section.
// Triggered from:
//   1. The hero metadata strip "Top up" link (when the user has balance)
//   2. The clickable Step 01 in the empty-state ribbon (when they don't)
//
// Single-purpose modal: shows the agent wallet, the user's unique deposit
// memo, and the wallet-specific instructions for adding the memo before
// sending. Anything else (deposit history, dead letters, refunds) lives
// on /account so this stays focused on the one task.
//
// Why a modal instead of an inline section?
//   - The fund-your-account flow is needed once per user per top-up,
//     not "always visible". A modal honours that frequency without
//     occupying ~40% of the dashboard's vertical space.
//   - Pulling it out of the page lets the dashboard's hero own the
//     entire viewport, which is the brave-version brief.

interface TopUpModalProps {
  open: boolean;
  onClose: () => void;
  agentWallet: string;
  depositMemo: string;
  /** Optional pre-message shown above the wallet block. */
  framingNote?: string;
  /** Manual deposit-check trigger — fired by the "Check for deposits" button. */
  onCheckDeposits?: () => void;
  /** Whether a deposit check is currently in flight. */
  checking?: boolean;
}

export function TopUpModal({
  open,
  onClose,
  agentWallet,
  depositMemo,
  framingNote,
  onCheckDeposits,
  checking = false,
}: TopUpModalProps) {
  const { toast } = useToast();

  const handleCopy = useCallback(
    (text: string, label: string) => {
      void navigator.clipboard.writeText(text);
      toast(`${label} copied`);
    },
    [toast],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Top up your agent"
      description="Send HBAR or LAZY to the agent wallet with your unique deposit memo. Hedera mirror nodes can lag a few seconds behind the actual transfer, so give it a moment before checking."
      size="lg"
    >
      <div className="space-y-5">
        {framingNote && (
          <p className="border-l-2 border-brand bg-brand/10 px-4 py-3 type-body text-brand">
            {framingNote}
          </p>
        )}

        {agentWallet && (
          <div>
            <label className="label-caps mb-2 block">Agent wallet</label>
            <div className="flex items-center gap-2 border-2 border-secondary bg-[var(--color-panel)] px-4 py-3">
              <code className="flex-1 break-all font-mono text-sm text-brand">
                {agentWallet}
              </code>
              <button
                type="button"
                onClick={() => handleCopy(agentWallet, 'Agent wallet')}
                className="shrink-0 border border-secondary px-3 py-1.5 label-caps transition-colors hover:border-brand hover:text-brand"
              >
                Copy
              </button>
            </div>
          </div>
        )}

        <div>
          <label className="label-caps mb-2 block">Deposit memo</label>
          <div className="flex items-center gap-2 border-2 border-secondary bg-[var(--color-panel)] px-4 py-3">
            <code className="flex-1 break-all font-mono text-sm text-brand">
              {depositMemo}
            </code>
            <button
              type="button"
              onClick={() => handleCopy(depositMemo, 'Deposit memo')}
              className="shrink-0 border border-secondary px-3 py-1.5 label-caps transition-colors hover:border-brand hover:text-brand"
            >
              Copy
            </button>
          </div>
        </div>

        <p className="border-l-2 border-destructive bg-destructive/10 px-4 py-3 text-xs text-destructive">
          <span className="font-semibold">Important:</span> always include the
          deposit memo. Transfers without the correct memo cannot be
          automatically credited.
        </p>

        <details className="border border-secondary bg-[var(--color-panel)] px-4 py-3 text-xs text-muted">
          <summary className="cursor-pointer font-pixel text-[10px] uppercase tracking-wider text-foreground">
            How do I add the memo in my wallet?
          </summary>
          <div className="mt-3 space-y-3">
            <div>
              <p className="font-semibold text-foreground">HashPack</p>
              <p>
                On the Send screen, tap{' '}
                <span className="text-foreground">Advanced</span> → paste the
                memo into the <span className="text-foreground">Memo</span>{' '}
                field before confirming.
              </p>
            </div>
            <div>
              <p className="font-semibold text-foreground">Blade</p>
              <p>
                On the Send screen, expand{' '}
                <span className="text-foreground">Optional Fields</span> and
                paste the memo into the{' '}
                <span className="text-foreground">Memo</span> field before
                confirming.
              </p>
            </div>
            <div>
              <p className="font-semibold text-foreground">Other wallets</p>
              <p>
                Look for a <span className="text-foreground">Memo</span> or
                <span className="text-foreground"> Note</span> field on the
                send screen. It&apos;s often hidden under an &quot;Advanced&quot;
                or &quot;Optional&quot; toggle.
              </p>
            </div>
          </div>
        </details>

        {/* Footer actions. Justify-end when there's no Check button so
            the Done button doesn't strand alone in justify-between mode;
            justify-between when both are present so Check sits on the
            left and Done on the right. No more <span /> spacer hack. */}
        <div
          className={`flex flex-wrap items-center gap-3 pt-2 ${
            onCheckDeposits ? 'justify-between' : 'justify-end'
          }`}
        >
          {onCheckDeposits && (
            <button
              type="button"
              onClick={onCheckDeposits}
              disabled={checking}
              className="btn-ghost-sm"
            >
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full bg-brand ${
                  checking ? 'animate-pulse' : ''
                }`}
                aria-hidden="true"
              />
              {checking ? 'Checking…' : 'Check for deposits'}
            </button>
          )}
          <button type="button" onClick={onClose} className="btn-ghost-sm">
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
