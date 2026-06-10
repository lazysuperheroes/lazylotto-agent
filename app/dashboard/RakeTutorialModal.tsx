'use client';

import { useState, type ReactNode } from 'react';

/**
 * First-run explainer for the rake. Shown once per signed-in user (the
 * dashboard persists a `lazylotto:seenRakeTutorial` flag, cleared on sign-out so
 * the next user sees it). The goal is simple: a new depositor should understand
 * WHY a small cut is taken — the platform pays every network fee for their plays
 * — so they don't feel like they lost money on deposit. Independent of x402; the
 * optional last step just points at the rake holiday when it's live.
 */
export function RakeTutorialModal({
  rakePercent,
  x402Enabled,
  onClose,
}: {
  rakePercent: number;
  x402Enabled: boolean;
  onClose: () => void;
}) {
  const steps: Array<{ title: string; body: ReactNode }> = [
    {
      title: "What's the rake?",
      body: (
        <>
          When you deposit, the platform keeps a small{' '}
          <span className="font-semibold text-brand">{rakePercent}%</span> — the{' '}
          <em>rake</em>. It&apos;s taken once, on the way in. There&apos;s no fee
          per play and no fee to withdraw.
        </>
      ),
    },
    {
      title: 'Where it goes',
      body: (
        <>
          Every time the agent plays for you, the platform pays the Hedera
          network fees — you never pay gas per submission. The rake is what funds
          that. You still keep{' '}
          <span className="font-semibold text-brand">100% of anything you win</span>.
        </>
      ),
    },
    ...(x402Enabled
      ? [
          {
            title: 'Prefer 0%?',
            body: (
              <>
                You can pay once for a 30-day{' '}
                <span className="font-semibold text-brand">rake holiday</span> and
                your deposits are credited at 0% rake. Look for the{' '}
                <span className="whitespace-nowrap">💎 button</span> on your
                dashboard.
              </>
            ),
          },
        ]
      : []),
  ];

  const [i, setI] = useState(0);
  const isLast = i === steps.length - 1;
  const step = steps[i]!;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md border-2 border-brand bg-[var(--color-panel)] p-6 text-foreground shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <p className="label-caps-brand">Good to know</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted transition-colors hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <h2 className="mb-3 font-heading text-xl text-foreground">{step.title}</h2>
        <p className="type-body min-h-[4.5rem] text-muted">{step.body}</p>

        <div className="mt-5 flex items-center justify-between">
          {/* Step dots */}
          <div className="flex gap-1.5" aria-hidden="true">
            {steps.map((_, idx) => (
              <span
                key={idx}
                className={`h-1.5 w-1.5 ${idx === i ? 'bg-brand' : 'bg-secondary'}`}
              />
            ))}
          </div>

          <div className="flex items-center gap-3">
            {i > 0 && (
              <button
                type="button"
                onClick={() => setI((n) => n - 1)}
                className="text-sm text-muted underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                Back
              </button>
            )}
            {isLast ? (
              <button type="button" onClick={onClose} className="btn-primary-sm">
                Got it
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setI((n) => n + 1)}
                className="btn-primary-sm"
              >
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
