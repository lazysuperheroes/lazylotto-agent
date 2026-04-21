/**
 * Audit page pure helpers.
 *
 * Extracted from app/audit/page.tsx so the small, pure pieces of
 * display logic can be tested in isolation without rendering the
 * whole 1300-line page component. Every function here is deliberately
 * side-effect free — no React, no DOM, no fetch — so vitest can
 * exercise the branches cheaply.
 *
 * If you add a new helper here, keep it pure. Stateful / React-hook
 * stuff lives in page.tsx itself.
 */
import type { V2SessionStatus } from './types';

/**
 * Format a number with up to 4 fraction digits using locale rules.
 * Matches formatAmount on the dashboard helpers so the two pages
 * never disagree about how 17.5 is rendered.
 */
export function formatAmount(amount: number): string {
  return amount.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
}

/**
 * Map HCS-20 tick names to user-friendly token names.
 * LLCRED is the ledger tick for HBAR — no user should ever see it.
 */
export function displayToken(tick?: string): string {
  if (!tick) return '';
  if (tick === 'LLCRED') return 'HBAR';
  return tick;
}

/**
 * Render an ISO consensus timestamp as a short "D MMM, HH:MM" string
 * suitable for audit cards. Falls back to the raw ISO if parsing
 * fails. Timezone follows the user's system locale — this IS the
 * right thing for a "when did my session run" display because
 * users recognise times in their own zone.
 */
export function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Format a per-token amount map as a compact human string.
 *
 *   { HBAR: 30 }             → "30 HBAR"
 *   { HBAR: 30, LAZY: 5 }    → "30 HBAR + 5 LAZY"
 *   { HBAR: 0, LAZY: 5 }     → "5 LAZY"   (zeros dropped)
 *   { }                      → ""
 *
 * Used by the audit SessionCard to render per-token Spent/Won
 * without falling back to a meaningless cross-token sum.
 */
export function formatByToken(byToken: Record<string, number>): string {
  const parts: string[] = [];
  for (const [token, amount] of Object.entries(byToken)) {
    if (!amount) continue;
    parts.push(`${formatAmount(amount)} ${displayToken(token)}`);
  }
  return parts.join(' + ');
}

/**
 * User-facing status label for a v2 NormalizedSession.
 *
 * "Played" replaced "Closed" for the happy path (2026-04-21) because
 * users consistently misread "Closed" as the pool being shut rather
 * than the session completing. Aborted/in-flight/orphaned/corrupt
 * genuinely describe terminal states so they keep their names.
 */
export function statusLabel(status: V2SessionStatus): string {
  switch (status) {
    case 'closed_success': return 'Played';
    case 'closed_aborted': return 'Aborted';
    case 'in_flight': return 'In flight';
    case 'orphaned': return 'Orphaned';
    case 'corrupt': return 'CORRUPT';
  }
}

/**
 * Tailwind classes for the status badge background + text colour.
 * Green for happy path, destructive red for anything bad, muted-info
 * for in-flight. Kept here so the page and any future tests agree on
 * which colour corresponds to which state.
 */
export function statusBadgeClasses(status: V2SessionStatus): string {
  switch (status) {
    case 'closed_success': return 'bg-success/15 text-success';
    case 'closed_aborted': return 'bg-destructive/15 text-destructive';
    case 'in_flight': return 'bg-info/15 text-info';
    case 'orphaned': return 'bg-destructive/15 text-destructive';
    case 'corrupt': return 'bg-destructive/15 text-destructive';
  }
}

/**
 * User-facing label + colour class for a prize transfer outcome.
 * This is the field that would have made the 668 HBAR stuck-prize
 * incident self-explanatory — don't regress the wording without
 * understanding what each state means to the user.
 */
export function prizeTransferLabel(
  status: 'succeeded' | 'skipped' | 'failed' | 'recovered' | undefined,
): { text: string; className: string } {
  switch (status) {
    case 'succeeded': return { text: 'Delivered to your wallet', className: 'text-success' };
    case 'skipped': return { text: 'Nothing to deliver', className: 'text-muted' };
    case 'failed': return { text: 'Delivery failed — operator notified', className: 'text-destructive' };
    case 'recovered': return { text: 'Recovered by operator', className: 'text-brand' };
    default: return { text: 'Unknown', className: 'text-muted' };
  }
}
