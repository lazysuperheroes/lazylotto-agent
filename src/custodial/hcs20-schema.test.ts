/**
 * Phase-2 R7: schema-as-source-of-truth regression tests.
 *
 * These tests lock the wire format contract. A change to any v2
 * shape that breaks an external auditor reading the topic will fail
 * one of these tests, NOT slip through to production and resurface
 * as a round-7 audit finding.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HCS20_SCHEMAS,
  Hcs20V2MessageSchema,
  Hcs20WriterMessageSchema,
  PlaySessionOpenSchema,
  PlayPoolResultSchema,
  PlaySessionCloseSchema,
  PlaySessionAbortedSchema,
  RefundSchema,
  PrizeRecoverySchema,
  StrategyChangeSchema,
  validateV2Message,
  safeParseByOp,
  type Hcs20WriterMessage,
} from './hcs20-schema.js';

describe('Phase-2 R7: HCS-20 v2 schema-as-source-of-truth', () => {
  describe('PlaySessionOpenSchema', () => {
    const valid = {
      p: 'hcs-20',
      op: 'play_session_open',
      v: 2,
      sessionId: 'sess_1',
      user: '0.0.7349994',
      agent: '0.0.4567890',
      agentSeq: 0,
      strategy: 'balanced',
      boostBps: 100,
      expectedPools: 5,
      ts: '2026-05-08T10:00:00.000Z',
    } as const;

    // smoke-only: exercises the canonical valid shape.
    it('accepts a fully-populated valid message', () => {
      assert.doesNotThrow(() => PlaySessionOpenSchema.parse(valid));
    });

    // revert-proof: removing the `op: z.literal('play_session_open')` constraint
    // from PlaySessionOpenSchema flips this safeParse from failure to success.
    it('rejects a wrong op literal', () => {
      const bad = { ...valid, op: 'play_session_kickoff' };
      assert.ok(!PlaySessionOpenSchema.safeParse(bad).success);
    });

    // revert-proof: dropping the `p: z.literal('hcs-20')` constraint flips
    // this safeParse from failure to success.
    it('rejects a wrong protocol literal', () => {
      const bad = { ...valid, p: 'hcs-30' };
      assert.ok(!PlaySessionOpenSchema.safeParse(bad).success);
    });

    // revert-proof: changing `v: z.literal(2)` to `z.number()` (or removing the
    // fence) flips this safeParse — the v3 fence is the forward-compat hook.
    it('rejects a wrong v fence (forward-compat fence)', () => {
      const bad = { ...valid, v: 3 };
      assert.ok(!PlaySessionOpenSchema.safeParse(bad).success);
    });

    // revert-proof: removing `.nonnegative()` from agentSeq lets a -1 (the
    // pre-seed sentinel) leak into the wire format and breaks reader gap
    // detection.
    it('rejects a negative agentSeq', () => {
      const bad = { ...valid, agentSeq: -1 };
      assert.ok(!PlaySessionOpenSchema.safeParse(bad).success);
    });
  });

  describe('PlayPoolResultSchema', () => {
    const valid = {
      p: 'hcs-20',
      op: 'play_pool_result',
      sessionId: 'sess_1',
      user: '0.0.7349994',
      agentSeq: 1,
      poolId: 42,
      seq: 1,
      entries: 10,
      spent: '50',
      spentToken: 'HBAR',
      wins: 0,
      prizes: [],
      ts: '2026-05-08T10:00:01.000Z',
    } as const;

    // smoke-only: exercises the canonical valid pool-result shape.
    it('accepts a minimal valid message', () => {
      assert.doesNotThrow(() => PlayPoolResultSchema.parse(valid));
    });

    // smoke-only: documents the fungible PrizeEntry shape.
    it('accepts a fungible prize', () => {
      const ok = {
        ...valid,
        wins: 1,
        prizes: [{ t: 'ft', tk: 'HBAR', amt: 100 }],
      };
      assert.doesNotThrow(() => PlayPoolResultSchema.parse(ok));
    });

    // smoke-only: documents the NFT PrizeEntry shape.
    it('accepts an NFT prize with serials', () => {
      const ok = {
        ...valid,
        wins: 1,
        prizes: [{ t: 'nft', tk: '0.0.1234', sym: 'LSH', ser: [1, 2, 3] }],
      };
      assert.doesNotThrow(() => PlayPoolResultSchema.parse(ok));
    });

    // revert-proof: dropping `slim: z.literal(1).optional()` from the schema
    // would force the slim-fallback writer path to hit the schema gate and
    // strip the slim flag — silently re-corrupting the audit trail.
    it('accepts the slim:1 stamp from the slim-fallback path', () => {
      const ok = { ...valid, slim: 1 as const };
      assert.doesNotThrow(() => PlayPoolResultSchema.parse(ok));
    });

    // revert-proof: removing `slim_truncated_prizes` from the schema strips
    // the field on writer parse, hiding the R5-FG-110 truncation marker.
    it('accepts slim_truncated_prizes from R5-FG-110', () => {
      const ok = { ...valid, slim: 1 as const, slim_truncated_prizes: 5 };
      assert.doesNotThrow(() => PlayPoolResultSchema.parse(ok));
    });

    // revert-proof: relaxing the discriminatedUnion('t', ...) to a plain
    // z.object would let unknown prize shapes pass and corrupt the canonical
    // Merkle hash by feeding it inputs the hasher doesn't expect.
    it('rejects a prize with an unknown discriminant', () => {
      const bad = { ...valid, prizes: [{ t: 'erc1155', tk: 'X', amt: 1 }] };
      assert.ok(!PlayPoolResultSchema.safeParse(bad).success);
    });
  });

  describe('PlaySessionCloseSchema', () => {
    const valid = {
      p: 'hcs-20',
      op: 'play_session_close',
      sessionId: 'sess_1',
      user: '0.0.7349994',
      agentSeq: 5,
      poolsPlayed: 3,
      poolsRoot: 'sha256:abc123',
      totalWins: 1,
      prizeTransfer: { status: 'succeeded', txId: '0.0.X@1234.0', attempts: 1 },
      ts: '2026-05-08T10:00:10.000Z',
    } as const;

    // smoke-only: exercises the canonical valid close shape.
    it('accepts a successful close', () => {
      assert.doesNotThrow(() => PlaySessionCloseSchema.parse(valid));
    });

    // revert-proof: relaxing the prizeTransfer.status enum from
    // ['succeeded','skipped','failed','recovered'] to z.string() lets the
    // 668-HBAR-style stuck-prize incidents go unflagged on the topic.
    it('rejects an unknown prizeTransfer.status', () => {
      const bad = {
        ...valid,
        prizeTransfer: { status: 'mostly_succeeded' },
      };
      assert.ok(!PlaySessionCloseSchema.safeParse(bad).success);
    });

    // revert-proof: dropping strategyDeviation from the schema strips R5-FG-59
    // markers on writer parse, hiding legitimate mid-session strategy changes
    // from external auditors.
    it('accepts strategyDeviation marker (R5-FG-59)', () => {
      const ok = {
        ...valid,
        strategyDeviation: { reason: 'budget_exhausted', field: 'budgetTotal' },
      };
      assert.doesNotThrow(() => PlaySessionCloseSchema.parse(ok));
    });
  });

  describe('PlaySessionAbortedSchema', () => {
    const valid = {
      p: 'hcs-20',
      op: 'play_session_aborted',
      sessionId: 'sess_1',
      user: '0.0.7349994',
      agentSeq: 5,
      completedPools: 2,
      reason: 'kill_switch',
      abortedAt: '2026-05-08T10:00:20.000Z',
    } as const;

    // smoke-only: exercises the canonical valid aborted shape.
    it('accepts a minimal aborted', () => {
      assert.doesNotThrow(() => PlaySessionAbortedSchema.parse(valid));
    });

    // revert-proof: removing `poolsRoot` from the aborted schema reopens the
    // R4-FG-24 attack — operator writes aborted with completedPools=0 and the
    // reader can't detect spend that already happened.
    it('accepts the optional poolsRoot (R4-FG-24)', () => {
      const ok = { ...valid, poolsRoot: 'sha256:abc' };
      assert.doesNotThrow(() => PlaySessionAbortedSchema.parse(ok));
    });

    // smoke-only: documents the lastError shape.
    it('accepts a truncated lastError', () => {
      const ok = { ...valid, lastError: 'INSUFFICIENT_GAS...' };
      assert.doesNotThrow(() => PlaySessionAbortedSchema.parse(ok));
    });
  });

  describe('RefundSchema', () => {
    const valid = {
      p: 'hcs-20',
      op: 'refund',
      tick: 'LLCRED',
      amt: '285',
      from: '0.0.4567890',
      to: '0.0.7349994',
      originalDepositTxId: '0.0.X@1775596937.272650838',
      refundTxId: '0.0.X@1775597000.000000000',
      reason: 'operator_initiated',
      performedBy: '0.0.4567890',
      ts: '2026-05-08T11:00:00.000Z',
    } as const;

    // smoke-only: documents legacy refund shape (pre-R6-FG-8).
    it('accepts a baseline refund (no rake reversal, no token field)', () => {
      assert.doesNotThrow(() => RefundSchema.parse(valid));
    });

    // revert-proof: R6-FG-8 + R8-FG-10 — removing the `token` field
    // from RefundSchema, OR replacing the field's parse with a
    // silent-strip default, would flip this assertion. Phase-6
    // Cluster A made this behavioral: we validate the parsed
    // result CARRIES the token, not just that the parse succeeds
    // (the pre-Phase-6 placebo was `assert.doesNotThrow` only,
    // which passed even when the schema stripped the field).
    it('R6-FG-8: parsed refund preserves explicit `token` field (behavioral, not placebo)', () => {
      const ok = { ...valid, token: 'LAZY' };
      const parsed = RefundSchema.parse(ok);
      assert.equal((parsed as { token?: string }).token, 'LAZY');
    });

    // revert-proof: dropping rakeReversed/rakeReversedToken from the schema
    // strips the F9 reversal anchor on writer parse, breaking operator-balance
    // reconstruction for refund-of-raked-deposit cases.
    it('F9: accepts rakeReversed + rakeReversedToken pair', () => {
      const ok = { ...valid, token: 'HBAR', rakeReversed: '14', rakeReversedToken: 'HBAR' };
      assert.doesNotThrow(() => RefundSchema.parse(ok));
    });

    // revert-proof: R8-FG-8 / R9-FG-9 / R9-FG-11 — Phase-7 Cluster D split.
    // Reader-loose schema NOW accepts empty originalDepositTxId
    // (forward-compat for legacy testnet refunds). Writer-strict
    // schema (via validateV2Message) MUST reject. Test asserts BOTH
    // halves: loose accepts, strict rejects. R9-FG-11 covers the
    // reader-side defense the writer-strict gate complements.
    it('R9-FG-9 / R8-FG-8 split: reader-loose accepts empty originalDepositTxId; writer-strict rejects', () => {
      const bad = { ...valid, originalDepositTxId: '' };
      // Reader-loose: accepts (forward-compat).
      assert.ok(RefundSchema.safeParse(bad).success, 'reader-loose must accept legacy empty');
      // Writer-strict: rejects via Hcs20WriterMessageSchema (ditto via validateV2Message).
      assert.throws(
        () => validateV2Message(bad as unknown as Hcs20WriterMessage),
        /originalDepositTxId/i,
      );
    });

    // revert-proof: R8-FG-22 / R9-FG-9 — Phase-7 Cluster D split.
    // Reader-loose accepts unbounded; writer-strict rejects via the
    // AmountStringFieldStrict bound at the writer-side override.
    it('R9-FG-9 / R8-FG-22 split: reader-loose accepts unbounded amt; writer-strict rejects', () => {
      const bad = { ...valid, amt: '1e308' };
      assert.ok(RefundSchema.safeParse(bad).success, 'reader-loose must accept unbounded legacy');
      assert.throws(
        () => validateV2Message(bad as unknown as Hcs20WriterMessage),
        /amount|< 1e15|finite/i,
      );
    });

    // revert-proof: R8-FG-22 / R9-FG-9 split — NaN-producing string
    // also writer-strict reject.
    it('R9-FG-9 / R8-FG-22 split: reader-loose accepts non-numeric amt; writer-strict rejects', () => {
      const bad = { ...valid, amt: 'not-a-number' };
      assert.ok(RefundSchema.safeParse(bad).success, 'reader-loose accepts any non-empty string');
      assert.throws(
        () => validateV2Message(bad as unknown as Hcs20WriterMessage),
        /amount|finite|< 1e15/i,
      );
    });

    // revert-proof: R9-P1-006 / Phase-7 Cluster D — strict variant
    // rejects whitespace-only strings (Number(' ') === 0 silently
    // passed pre-Phase-7).
    it('R9-P1-006: writer-strict rejects whitespace-only amt', () => {
      const bad = { ...valid, amt: '   ' };
      assert.throws(
        () => validateV2Message(bad as unknown as Hcs20WriterMessage),
        /whitespace|amount/i,
      );
    });
  });

  describe('PrizeRecoverySchema', () => {
    const valid = {
      p: 'hcs-20',
      op: 'prize_recovery',
      tick: 'LLCRED',
      v: 2,
      user: '0.0.7349994',
      agent: '0.0.4567890',
      prizesTransferred: 3,
      prizesByToken: { HBAR: 668 },
      contractTxId: '0.0.X@1775598000.000000000',
      reason: 'auto',
      performedBy: '0.0.4567890',
      timestamp: '2026-05-08T12:00:00.000Z',
    } as const;

    // smoke-only: documents canonical prize-recovery shape.
    it('accepts a baseline recovery', () => {
      assert.doesNotThrow(() => PrizeRecoverySchema.parse(valid));
    });

    // revert-proof: making prizesByToken optional in the schema reopens the
    // R5-FG-89 ambiguity — readers can't tell "writer doesn't know the field"
    // from "writer chose to omit detail".
    it('R5-FG-89: accepts an empty prizesByToken object', () => {
      const ok = { ...valid, prizesByToken: {} };
      assert.doesNotThrow(() => PrizeRecoverySchema.parse(ok));
    });
  });

  describe('StrategyChangeSchema', () => {
    const valid = {
      p: 'hcs-20',
      op: 'strategy_change',
      user: '0.0.7349994',
      previousStrategy: 'balanced',
      newStrategy: 'aggressive',
      newStrategyVersion: 'aggressive.0.2.0',
      performedBy: 'user',
      ts: '2026-05-08T13:00:00.000Z',
    } as const;

    // smoke-only: exercises canonical strategy_change shape.
    it('accepts a self-serve strategy change', () => {
      assert.doesNotThrow(() => StrategyChangeSchema.parse(valid));
    });
  });

  describe('Hcs20V2MessageSchema (discriminated union)', () => {
    // revert-proof: R6-Phase-2 — replacing the discriminatedUnion('op', ...)
    // with a plain union strips the op-based dispatch and lets
    // unknown ops pass with arbitrary shape — the writer gate
    // becomes a no-op.
    it('routes a play_session_open via the op discriminant', () => {
      const result = Hcs20V2MessageSchema.parse({
        p: 'hcs-20',
        op: 'play_session_open',
        v: 2,
        sessionId: 'sess_1',
        user: '0.0.1',
        agent: '0.0.2',
        agentSeq: 0,
        strategy: 's',
        boostBps: 0,
        expectedPools: 1,
        ts: '2026-05-08T00:00:00.000Z',
      });
      assert.equal(result.op, 'play_session_open');
    });

    // revert-proof: R6-Phase-2 — replacing the discriminated union
    // with z.any() at the writer gate would let unknown ops slip
    // through.
    it('rejects an unknown op', () => {
      const result = Hcs20V2MessageSchema.safeParse({
        p: 'hcs-20',
        op: 'lottery_jackpot',
        sessionId: 'x',
      });
      assert.ok(!result.success);
    });
  });

  describe('validateV2Message (writer-side gate)', () => {
    // smoke-only: documents the writer's parse-and-pass behavior.
    it('returns the parsed payload for a valid open', () => {
      const msg: Hcs20WriterMessage = {
        p: 'hcs-20',
        op: 'play_session_open',
        v: 2,
        sessionId: 'sess_1',
        user: '0.0.1',
        agent: '0.0.2',
        agentSeq: 0,
        strategy: 's',
        boostBps: 0,
        expectedPools: 1,
        ts: '2026-05-08T00:00:00.000Z',
      };
      const out = validateV2Message(msg);
      assert.equal(out.op, 'play_session_open');
    });

    // revert-proof: R6-Phase-2 — removing validateV2Message's call
    // to schema.parse (and returning `payload` directly) flips this
    // assert.throws; every writer-side typo would silently land on
    // the topic again, defeating the schema-as-source-of-truth gate.
    it('throws when a required field is missing', () => {
      const bad = {
        p: 'hcs-20',
        op: 'play_session_open',
        v: 2,
        sessionId: 'sess_1',
        // user missing
        agent: '0.0.2',
        agentSeq: 0,
        strategy: 's',
        boostBps: 0,
        expectedPools: 1,
        ts: '2026-05-08T00:00:00.000Z',
      };
      assert.throws(() => validateV2Message(bad as unknown as Hcs20WriterMessage));
    });

    // revert-proof: R8-FG-1 — Phase-6 Cluster A. The strict writer
    // schema MUST reject unknown keys (typo defense). Pre-fix the
    // loose `Hcs20V2MessageSchema.parse` SILENTLY STRIPPED them,
    // so a writer typo `rakeRevsered: '14'` passed parse and the
    // field never reached the topic. If `Hcs20WriterMessageSchema`
    // is ever swapped back to the loose variant, this test fails.
    it('R8-FG-1: rejects unknown keys (strict writer schema)', () => {
      const refundWithTypo = {
        p: 'hcs-20',
        op: 'refund',
        tick: 'LLCRED',
        amt: '100',
        from: '0.0.1',
        to: '0.0.2',
        originalDepositTxId: 'a',
        refundTxId: 'b',
        reason: 'r',
        performedBy: '0.0.1',
        ts: '2026-05-08T00:00:00.000Z',
        // Typo: was `rakeReversed`, now never reaches operator-balance reducer
        rakeRevsered: '14',
      };
      assert.throws(
        () => validateV2Message(refundWithTypo as unknown as Hcs20WriterMessage),
        /unrecognized|unknown|rakeRevsered/i,
      );
    });

    // revert-proof: R8-FG-5 — cross-field invariant. A refund with
    // rakeReversed but no rakeReversedToken slips dedup at the
    // operator-balance reducer (verify-audit drops the reversal,
    // operator balance reads HIGHER than reality). The runtime
    // cross-field check inside validateV2Message catches this.
    it('R8-FG-5: rakeReversed without rakeReversedToken is rejected', () => {
      const bad = {
        p: 'hcs-20',
        op: 'refund',
        tick: 'LLCRED',
        amt: '100',
        from: '0.0.1',
        to: '0.0.2',
        originalDepositTxId: 'a',
        refundTxId: 'b',
        reason: 'r',
        performedBy: '0.0.1',
        ts: '2026-05-08T00:00:00.000Z',
        rakeReversed: '14',
        // rakeReversedToken intentionally absent
      };
      assert.throws(
        () => validateV2Message(bad as unknown as Hcs20WriterMessage),
        /rakeReversed.*rakeReversedToken|both be present/i,
      );
    });

    // revert-proof: R8-FG-2 — control + prize_recovery now route
    // through validateV2Message. Pre-Phase-6 they bypassed via the
    // legacy `submitMessage` path. The strict union must accept
    // both ops as valid writer messages.
    it('R8-FG-2: accepts ControlEventMessage in the writer union', () => {
      const ev: Hcs20WriterMessage = {
        p: 'hcs-20',
        op: 'control',
        tick: 'LLCRED',
        event: 'killswitch_enabled',
        reason: 'test',
        by: '0.0.1',
        timestamp: '2026-05-08T00:00:00.000Z',
      };
      assert.doesNotThrow(() => validateV2Message(ev));
    });

    // revert-proof: R8-FG-2 — same archetype as the ControlEvent
    // case: prize_recovery used to bypass via legacy submitMessage.
    it('R8-FG-2: accepts PrizeRecoveryMessage in the writer union', () => {
      const ev: Hcs20WriterMessage = {
        p: 'hcs-20',
        op: 'prize_recovery',
        tick: 'LLCRED',
        v: 2,
        user: '0.0.1',
        agent: '0.0.2',
        prizesTransferred: 1,
        prizesByToken: { HBAR: 100 },
        contractTxId: '0.0.X@1.0',
        reason: 'auto',
        performedBy: '0.0.2',
        timestamp: '2026-05-08T00:00:00.000Z',
      };
      assert.doesNotThrow(() => validateV2Message(ev));
    });

    // revert-proof: R9-P4-003 / Phase-7 Cluster D — cross-field
    // invariant for `deposit_credit_flush_orphaned`. Schema fields
    // are `.optional()` (so loose reader accepts non-orphan control
    // events without them). Writer-strict cross-field check requires
    // grossAmount + token + userId all present for THIS event kind.
    // Pre-Phase-7 a writer regression dropping any of the three
    // passed Zod validation; the alert fired without correction.
    it('R9-P4-003: deposit_credit_flush_orphaned requires grossAmount + token + userId', () => {
      const baseOrphan = {
        p: 'hcs-20',
        op: 'control',
        tick: 'LLCRED',
        event: 'deposit_credit_flush_orphaned',
        by: '0.0.2',
        userId: '0.0.1',
        grossAmount: '100',
        token: 'HBAR',
        timestamp: '2026-05-08T00:00:00.000Z',
      };
      // Valid: all present.
      assert.doesNotThrow(() => validateV2Message(baseOrphan as Hcs20WriterMessage));
      // Missing grossAmount.
      assert.throws(
        () => validateV2Message({ ...baseOrphan, grossAmount: undefined } as unknown as Hcs20WriterMessage),
        /grossAmount|required/i,
      );
      // Missing token.
      assert.throws(
        () => validateV2Message({ ...baseOrphan, token: undefined } as unknown as Hcs20WriterMessage),
        /token|required/i,
      );
      // Missing userId.
      assert.throws(
        () => validateV2Message({ ...baseOrphan, userId: undefined } as unknown as Hcs20WriterMessage),
        /userId|required/i,
      );
    });

    // revert-proof: R6-FG-9 — control event extension for
    // `deposit_credit_flush_orphaned`. Pre-fix the writer dropped
    // grossAmount/token/cause; now they're schema fields. If the
    // enum value is removed from ControlEventKind, this test fails.
    it('R6-FG-9: deposit_credit_flush_orphaned carries grossAmount + token + cause', () => {
      const ev: Hcs20WriterMessage = {
        p: 'hcs-20',
        op: 'control',
        tick: 'LLCRED',
        event: 'deposit_credit_flush_orphaned',
        by: '0.0.2',
        userId: '0.0.1',
        uncertainTxId: 'abc',
        grossAmount: '100',
        token: 'HBAR',
        cause: 'redis blip',
        idempotencyKey: 'deposit-flush-orphan:abc',
        timestamp: '2026-05-08T00:00:00.000Z',
      };
      const out = validateV2Message(ev);
      assert.equal((out as { grossAmount?: string }).grossAmount, '100');
      assert.equal((out as { token?: string }).token, 'HBAR');
      assert.equal((out as { cause?: string }).cause, 'redis blip');
    });
  });

  describe('safeParseByOp (reader-side dispatch)', () => {
    // smoke-only: documents the loose-mode happy path.
    it('returns a parsed message on success', () => {
      const result = safeParseByOp('refund', {
        p: 'hcs-20',
        op: 'refund',
        tick: 'LLCRED',
        amt: '10',
        from: '0.0.1',
        to: '0.0.2',
        originalDepositTxId: 'a',
        refundTxId: 'b',
        reason: 'r',
        performedBy: '0.0.1',
        ts: '2026-05-08T00:00:00.000Z',
      });
      assert.ok(result !== null);
      assert.equal(result?.op, 'refund');
    });

    // revert-proof: changing safeParseByOp to throw instead of returning null
    // would crash the reader's loose mode on any v3 / drift message.
    it('returns null on parse failure (loose mode)', () => {
      const result = safeParseByOp('refund', { p: 'hcs-20', op: 'refund' });
      assert.equal(result, null);
    });
  });

  describe('HCS20_SCHEMAS registry', () => {
    // revert-proof: removing a v2 entry from HCS20_SCHEMAS deletes its row
    // from the autogen schema doc and silently breaks the doc-generator
    // contract.
    it('contains every v2 op declared in the union', () => {
      const expected = [
        'play_session_open',
        'play_pool_result',
        'play_session_close',
        'play_session_aborted',
        'refund',
        'prize_recovery',
        'strategy_change',
      ];
      for (const op of expected) {
        assert.ok(op in HCS20_SCHEMAS, `missing schema registry entry: ${op}`);
      }
    });

    // revert-proof: removing v1 / control entries from HCS20_SCHEMAS strips
    // legacy + control doc generation.
    it('also registers v1 + control schemas for the doc generator', () => {
      const expected = ['mint', 'transfer', 'burn', 'batch', 'deploy', 'control'];
      for (const op of expected) {
        assert.ok(op in HCS20_SCHEMAS, `missing schema registry entry: ${op}`);
      }
    });
  });
});
