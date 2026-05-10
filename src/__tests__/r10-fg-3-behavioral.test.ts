/**
 * R10-FG-3 behavioral test — parseRefund silent-null over-credits user.
 *
 * Authored 2026-05-09 BEFORE any fix lands, as part of the dissection
 * exercise verifying the hypothesis that "tests catch prior-round
 * archetypes, not current-round introduction archetypes". This test
 * exists to FAIL against current code.
 *
 * R10-FG-3 says: when a refund message has empty `originalDepositTxId`,
 * `parseRefund` returns null at hcs20-reader.ts:1542 and the dispatcher
 * (lines 619-672) only increments the generic `stats.skippedMessages++`
 * counter. Verify-audit's reducers cannot distinguish a dropped refund
 * from any other skip — `totalRefundedByToken[token]` stays short and
 * the reconstructed user balance OVER-CREDITS by the refund amount.
 *
 * Pre-Phase-7 the truthy `if (originalDepositTxId)` gate let empty-string
 * messages through and the dispatcher double-counted them. R9-FG-11 /
 * Phase-7 Cluster F flipped to "refuse to emit a normalized event",
 * which inverts the failure direction (over-credit instead of
 * double-count) but breaks invariant 3 either way.
 *
 * The behavioral invariant: a refund message that hits the dispatcher
 * MUST produce SOME recoverable signal that downstream reducers /
 * verify-audit / monitoring can act on — either (a) the event surfaces
 * in `result.events` (with a sentinel for the malformed field), or (b)
 * a categorized `stats` counter is incremented that names this specific
 * failure mode (NOT the catch-all `skippedMessages` and NOT the
 * coincidental Zod softValidate output, which only fires when an env
 * variable happens to be set).
 *
 * Hypothesis-verification protocol: this test MUST FAIL right now.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuditTopic, type RawTopicMessage } from '../custodial/hcs20-reader.js';

const NOW = new Date('2026-04-08T00:00:00.000Z').getTime();
const T0 = '2026-04-07T23:59:00.000Z';
const USER = '0.0.7349994';
const AGENT = '0.0.8456987';

describe('R10-FG-3: parseRefund empty-original-deposit must produce a recoverable signal', () => {
  // revert-proof: R10-FG-3 + R9-FG-11 — removing the
  // `stats.refundsDroppedEmptyOriginal` increment in
  // hcs20-reader.ts (or the stats-shape declaration) flips this
  // test. The dispatcher must emit a categorized signal that
  // does NOT depend on softValidate's env gating. R9-FG-11 covered
  // the reader-side empty-string defense at parseRefund line 1542;
  // Phase-9 re-promoted that entry to link here.
  it('refund with empty originalDepositTxId either surfaces an event or a categorized stat', async () => {
    const refundMsg: RawTopicMessage = {
      sequence: 1,
      timestamp: T0,
      payload: {
        p: 'hcs-20',
        op: 'refund',
        from: AGENT,
        to: USER,
        amt: 5,
        token: 'HBAR',
        originalDepositTxId: '', // legacy / malformed — the case under test
        refundTxId: '0.0.123@1234567890.123456789',
        reason: 'manual_admin',
        performedBy: AGENT,
      },
    };

    const result = await parseAuditTopic([refundMsg], NOW);

    const refundEvents = result.events.filter((e) => e.type === 'refund');
    const stats = result.stats as unknown as Record<string, unknown>;

    // Acceptable signals (any one of these makes the dispatcher's
    // dropped-refund recoverable for downstream reducers):
    //   (a) the event surfaces with a sentinel originalDepositTxId
    //   (b) a categorized counter on stats names the failure mode
    //
    // Generic `stats.skippedMessages` does NOT count — it conflates
    // dozens of different skip reasons and reducers can't act on it.
    // `stats.schemaValidationFailures` does NOT count by itself —
    // it's softValidate's coincidental output, only fires when
    // HCS20_SOFT_VALIDATE=1 / NODE_ENV=test, and is observation-only.
    const surfacedAsEvent = refundEvents.length === 1;
    const numericGt0 = (v: unknown) => typeof v === 'number' && v > 0;
    const arrNonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;
    // Accept any reasonable categorization shape — numeric counter,
    // populated array, or an event surfaced with sentinel. Generic
    // `skippedMessages` and softValidate's `schemaValidationFailures`
    // do NOT count (see header comment for rationale).
    const hasCategorizedCounter =
      numericGt0(stats.legacyEmptyOriginalRefund) ||
      numericGt0(stats.refundsDroppedEmptyOriginal) ||
      numericGt0(stats.refundsWithEmptyOriginal) ||
      arrNonEmpty(stats.refundsDroppedEmptyOriginal) ||
      arrNonEmpty(stats.refundsWithEmptyOriginal);

    assert.ok(
      surfacedAsEvent || hasCategorizedCounter,
      `R10-FG-3: refund message with empty originalDepositTxId produced ` +
        `no recoverable signal. parseRefund returns null at ` +
        `hcs20-reader.ts:1542; dispatcher only increments ` +
        `stats.skippedMessages++. result.events has ${refundEvents.length} ` +
        `refund events; result.stats has no categorized counter for this ` +
        `failure mode. Verify-audit's reducers cannot distinguish this ` +
        `from any other skip → user balance OVER-CREDITS by the refund ` +
        `amount. Fix requires either (a) emit event with sentinel for ` +
        `originalDepositTxId, or (b) add a categorized counter.`,
    );
  });
});
