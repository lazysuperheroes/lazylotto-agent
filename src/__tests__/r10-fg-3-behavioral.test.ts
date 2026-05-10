/**
 * R10-FG-3 + R11-FG-1 + R11-FG-5 behavioral test — parseRefund
 * categorized null-drops; over-credit invariant locked.
 *
 * Authored 2026-05-09 (Phase-8 closure of R10-FG-3) and rewritten
 * 2026-05-10 (Phase-9 Cluster B) to assert the BUG-shape invariant
 * instead of the SIGNAL-existence shape:
 *
 *   - Phase-8's test asserted "some categorized signal exists" — it
 *     passed against any implementation that incremented some counter,
 *     including the wire-only one that no consumer read (R11-FG-1).
 *   - Phase-9's test asserts the FIVE distinct null-return reasons
 *     each map to a NAMED, DISCRIMINATED counter the dispatcher
 *     increments. verify-audit (`src/scripts/verify-audit.ts`) wires
 *     each non-zero counter into a `refund_dropped_malformed` alert,
 *     so the over-credit invariant is closed end-to-end (counter
 *     incremented → alert fires → operator sees the dropped refund
 *     instead of silent over-credit).
 *
 * The 5 parseRefund null-return reasons (`hcs20-reader.ts`
 * `parseRefund` body):
 *   1. empty `originalDepositTxId`     → refundsDroppedEmptyOriginal
 *   2. missing `from` or `to`           → refundsDroppedMissingParty
 *   3. non-finite `amt`                 → refundsDroppedInvalidAmt
 *   4. missing `refundTxId`             → refundsDroppedMissingRefundTx
 *   (5. valid payload                   → emits NormalizedRefundEvent)
 *
 * If parseRefund's body is reverted to a single bare `return null`
 * for any of these reasons, the corresponding counter stops
 * incrementing and this test flips. If verify-audit's alert
 * consumer is reverted, the over-credit invariant remains open
 * but the test (which scopes to the reader's stats) still flips
 * because it asserts each reason has its own counter — see
 * verify-audit's `refund_dropped_malformed` alert pipeline for the
 * downstream consumer that this test pairs with.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuditTopic, type RawTopicMessage } from '../custodial/hcs20-reader.js';

const NOW = new Date('2026-04-08T00:00:00.000Z').getTime();
const T0 = '2026-04-07T23:59:00.000Z';
const USER = '0.0.7349994';
const AGENT = '0.0.8456987';

function refundMsg(seq: number, payload: Record<string, unknown>): RawTopicMessage {
  return {
    sequence: seq,
    timestamp: T0,
    payload: {
      p: 'hcs-20',
      op: 'refund',
      reason: 'manual_admin',
      performedBy: AGENT,
      ...payload,
    },
  };
}

describe('R10-FG-3 + R11-FG-1 + R11-FG-5: parseRefund null-drops are categorized per reason', () => {
  // revert-proof: R10-FG-3 + R11-FG-1 + R11-FG-5 + R9-FG-11 —
  // bug-shape test, not signal-shape. Asserts that EACH of the four
  // discriminated null-return reasons increments its OWN counter on
  // `result.stats.refundsDropped*`. Reverting the dispatcher's per-
  // reason categorization (hcs20-reader.ts inside the `op === 'refund'`
  // branch) flips one or more of these assertions. R11-FG-1 is closed
  // end-to-end by verify-audit's `refund_dropped_malformed` alert
  // pipeline (consumer-wired) — see `verify-audit.ts`'s
  // `droppedReasons` loop for the consumer.
  it('each null-return reason increments its own categorized counter', async () => {
    const messages: RawTopicMessage[] = [
      // 1. empty originalDepositTxId
      refundMsg(1, {
        from: AGENT,
        to: USER,
        amt: 5,
        token: 'HBAR',
        originalDepositTxId: '',
        refundTxId: '0.0.123@1.1',
      }),
      // 2. missing from
      refundMsg(2, {
        to: USER,
        amt: 5,
        token: 'HBAR',
        originalDepositTxId: '0.0.111@222.333',
        refundTxId: '0.0.123@2.2',
      }),
      // 3. non-finite amt
      refundMsg(3, {
        from: AGENT,
        to: USER,
        amt: 'NaN',
        token: 'HBAR',
        originalDepositTxId: '0.0.111@222.444',
        refundTxId: '0.0.123@3.3',
      }),
      // 4. missing refundTxId
      refundMsg(4, {
        from: AGENT,
        to: USER,
        amt: 5,
        token: 'HBAR',
        originalDepositTxId: '0.0.111@222.555',
      }),
      // 5. valid — must NOT increment any drop counter
      refundMsg(5, {
        from: AGENT,
        to: USER,
        amt: 5,
        token: 'HBAR',
        originalDepositTxId: '0.0.111@222.666',
        refundTxId: '0.0.123@5.5',
      }),
    ];

    const result = await parseAuditTopic(messages, NOW);

    assert.equal(
      result.stats.refundsDroppedEmptyOriginal,
      1,
      'empty originalDepositTxId must increment refundsDroppedEmptyOriginal exactly once',
    );
    assert.equal(
      result.stats.refundsDroppedMissingParty,
      1,
      'missing from/to must increment refundsDroppedMissingParty exactly once',
    );
    assert.equal(
      result.stats.refundsDroppedInvalidAmt,
      1,
      'non-finite amt must increment refundsDroppedInvalidAmt exactly once',
    );
    assert.equal(
      result.stats.refundsDroppedMissingRefundTx,
      1,
      'missing refundTxId must increment refundsDroppedMissingRefundTx exactly once',
    );
    // The 5th (valid) message must NOT bump any drop counter.
    // Per-reason invariant: total drops = 4, and the valid message
    // surfaces a refund event in the events stream.
    const totalDropped =
      result.stats.refundsDroppedEmptyOriginal +
      result.stats.refundsDroppedMissingParty +
      result.stats.refundsDroppedInvalidAmt +
      result.stats.refundsDroppedMissingRefundTx;
    assert.equal(totalDropped, 4, 'valid refund must not bump any drop counter');

    const refundEvents = result.events.filter((e) => e.type === 'refund');
    assert.equal(
      refundEvents.length,
      1,
      'valid refund (only) must surface as a NormalizedRefundEvent',
    );
  });
});
