/**
 * Audit page helper tests.
 *
 * These helpers are pure display logic — no React, no fetch — so we
 * lock in the behaviour at the function level rather than rendering
 * the whole 1300-line page. The main surfaces being protected:
 *
 *   - "Played" badge for closed_success (renamed from "Closed" on
 *     2026-04-21 because users kept misreading "Closed" as a shut
 *     door rather than a completed session)
 *   - Per-token Spent/Won rendering via formatByToken — the fix
 *     that stops bare numbers leaking into the UI when multi-token
 *     plays land
 *   - Zero-value suppression in formatByToken so a 0-spend token
 *     doesn't clutter the line
 *   - LLCRED → HBAR mapping on displayToken for the legacy tick case
 *   - Prize transfer label wording — would have made the 668 HBAR
 *     stuck-prize incident self-explanatory if it existed then
 */

import { describe, it, expect } from 'vitest';
import {
  formatAmount,
  displayToken,
  formatByToken,
  statusLabel,
  statusBadgeClasses,
  prizeTransferLabel,
} from './helpers';

describe('formatAmount', () => {
  it('renders integers with no fraction digits', () => {
    expect(formatAmount(30)).toBe('30');
  });

  it('preserves decimal places up to 4 digits', () => {
    expect(formatAmount(17.5)).toBe('17.5');
    expect(formatAmount(0.0001)).toBe('0.0001');
  });

  it('drops trailing zeros past the 4-digit cap', () => {
    // 0.12345 → rounded to 4 fraction digits → 0.1235
    // Important: this matches dashboard/helpers formatAmount
    // (the headline/play log lock-step)
    expect(formatAmount(0.12345)).toBe('0.1235');
  });
});

describe('displayToken', () => {
  it('maps LLCRED ledger tick → HBAR for display', () => {
    // LLCRED is the HCS-20 ledger tick — users should never see it.
    expect(displayToken('LLCRED')).toBe('HBAR');
  });

  it('passes through HBAR untouched', () => {
    expect(displayToken('HBAR')).toBe('HBAR');
  });

  it('passes through Hedera token ids untouched', () => {
    expect(displayToken('0.0.8011209')).toBe('0.0.8011209');
  });

  it('passes through other symbols untouched', () => {
    expect(displayToken('LAZY')).toBe('LAZY');
  });

  it('returns empty string for undefined / empty input', () => {
    expect(displayToken(undefined)).toBe('');
    expect(displayToken('')).toBe('');
  });
});

describe('formatByToken', () => {
  it('renders a single HBAR bucket as "N HBAR"', () => {
    expect(formatByToken({ HBAR: 30 })).toBe('30 HBAR');
  });

  it('joins multiple tokens with " + "', () => {
    expect(formatByToken({ HBAR: 30, LAZY: 5 })).toBe('30 HBAR + 5 LAZY');
  });

  it('drops zero-value entries so they do not clutter the line', () => {
    expect(formatByToken({ HBAR: 0, LAZY: 5 })).toBe('5 LAZY');
    expect(formatByToken({ HBAR: 30, LAZY: 0 })).toBe('30 HBAR');
  });

  it('returns empty string for an empty map', () => {
    expect(formatByToken({})).toBe('');
  });

  it('returns empty string when all entries are zero', () => {
    // This is how "0 won" gets suppressed in favour of the caller's
    // fallback path (e.g. "NFT won" when totalPrizeValue is 0).
    expect(formatByToken({ HBAR: 0, LAZY: 0 })).toBe('');
  });

  it('preserves decimal amounts', () => {
    expect(formatByToken({ HBAR: 17.5 })).toBe('17.5 HBAR');
  });

  it('renders Hedera token ids with the id itself (no LLCRED fallback)', () => {
    // Non-HBAR FTs use their token id directly. displayToken's
    // LLCRED → HBAR mapping is the one exception and only fires
    // for the literal string 'LLCRED'.
    expect(formatByToken({ '0.0.8011209': 100 })).toBe('100 0.0.8011209');
  });
});

describe('statusLabel', () => {
  // This is the rename that motivated the 2026-04-21 UX pass —
  // lock it in so nobody accidentally reverts closed_success back
  // to "Closed".
  it('renders closed_success as "Played" (not "Closed")', () => {
    expect(statusLabel('closed_success')).toBe('Played');
  });

  it('renders closed_aborted as "Aborted"', () => {
    expect(statusLabel('closed_aborted')).toBe('Aborted');
  });

  it('renders in_flight as "In flight"', () => {
    expect(statusLabel('in_flight')).toBe('In flight');
  });

  it('renders orphaned as "Orphaned"', () => {
    expect(statusLabel('orphaned')).toBe('Orphaned');
  });

  it('renders corrupt as uppercase "CORRUPT" to stand out', () => {
    expect(statusLabel('corrupt')).toBe('CORRUPT');
  });
});

describe('statusBadgeClasses', () => {
  it('uses success colour for the happy path', () => {
    expect(statusBadgeClasses('closed_success')).toContain('text-success');
  });

  it('uses destructive colour for aborted / orphaned / corrupt', () => {
    expect(statusBadgeClasses('closed_aborted')).toContain('text-destructive');
    expect(statusBadgeClasses('orphaned')).toContain('text-destructive');
    expect(statusBadgeClasses('corrupt')).toContain('text-destructive');
  });

  it('uses info colour for in_flight', () => {
    expect(statusBadgeClasses('in_flight')).toContain('text-info');
  });
});

describe('prizeTransferLabel', () => {
  it('labels succeeded as delivered', () => {
    expect(prizeTransferLabel('succeeded').text).toBe('Delivered to your wallet');
    expect(prizeTransferLabel('succeeded').className).toBe('text-success');
  });

  it('labels skipped as nothing-to-deliver', () => {
    expect(prizeTransferLabel('skipped').text).toBe('Nothing to deliver');
    expect(prizeTransferLabel('skipped').className).toBe('text-muted');
  });

  it('labels failed as destructive with operator-notified wording', () => {
    expect(prizeTransferLabel('failed').text).toContain('Delivery failed');
    expect(prizeTransferLabel('failed').className).toBe('text-destructive');
  });

  it('labels recovered in brand colour so operator recoveries stand out', () => {
    expect(prizeTransferLabel('recovered').text).toBe('Recovered by operator');
    expect(prizeTransferLabel('recovered').className).toBe('text-brand');
  });

  it('falls back to "Unknown" for an undefined transfer status', () => {
    expect(prizeTransferLabel(undefined).text).toBe('Unknown');
  });
});
