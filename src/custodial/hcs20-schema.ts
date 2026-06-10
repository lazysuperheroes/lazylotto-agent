/**
 * HCS-20 audit topic — Zod schemas (single source of truth).
 *
 * Phase 2 of the once-and-for-all structural fix (R7). Pre-fix the
 * wire format lived in FOUR places that drifted independently:
 *   1. TypeScript interfaces in `hcs20-v2.ts`
 *   2. Writer literal-object construction in `AccountingService.ts`
 *   3. Reader field reads in `hcs20-reader.ts`
 *   4. Hand-maintained doc at `docs/hcs20-v2-schema.md`
 *
 * Every audit round (R1..R6) found at least one drift bug. R6
 * surfaced `parseRefund` not extracting `rakeReversed` (R6-FG-7),
 * `RefundMessage` missing a `token` field so a LAZY refund recorded
 * as HBAR (R6-FG-8), `recordControlEvent` silently dropping
 * `grossAmount` (R6-FG-9), schema-doc drift items (R6-FG-59..62),
 * and more. The schemas in this file are the authoritative
 * contract; the writer parses against them on submit, the reader
 * dispatches via discriminated `op` field, and the doc generator
 * walks them to produce the wire-format reference.
 *
 * Forward compat: the LOOSE schemas (the named exports) are NOT
 * `.strict()` — unknown keys are stripped on `.parse` so a v3 field
 * landing on the topic doesn't crash a v2 reader. The reader's
 * `softValidate` uses the loose variants.
 *
 * The WRITER uses the STRICT variant `Hcs20WriterMessageSchema`
 * (Phase-6 R8-FG-1 closure). It rejects unknown keys, runs
 * cross-field invariants (rakeReversed↔rakeReversedToken pairing,
 * originalDepositTxId.min(1), amount upper-bound), and is the
 * single gate every outbound topic message goes through. A
 * misspelled writer field (`rakeRevsered` vs `rakeReversed`)
 * throws here at submit time, NOT 24h later when the reader gets
 * confused.
 *
 * Doc generator: each field carries a `.describe()` annotation. The
 * `npm run schema:docs` script walks these to produce the autogen
 * reference section in `docs/hcs20-v2-schema.md`.
 */

import { z } from 'zod';

// ── Op name registry (single literal source) ────────────────

export const HCS20_V2_OPS = {
  PLAY_SESSION_OPEN: 'play_session_open',
  PLAY_POOL_RESULT: 'play_pool_result',
  PLAY_SESSION_CLOSE: 'play_session_close',
  PLAY_SESSION_ABORTED: 'play_session_aborted',
  REFUND: 'refund',
  PRIZE_RECOVERY: 'prize_recovery',
  STRATEGY_CHANGE: 'strategy_change',
} as const;

export type Hcs20V2OpName = (typeof HCS20_V2_OPS)[keyof typeof HCS20_V2_OPS];

// ── Shared atoms ────────────────────────────────────────────

const HederaIdField = z
  .string()
  .min(1)
  .describe('Hedera account or token ID (e.g. "0.0.7349994") or token alias ("HBAR" / "LAZY")');

const Iso8601Field = z.string().describe('ISO 8601 timestamp (UTC)');

const NonNegInt = z.number().int().nonnegative();

const ProtocolField = z.literal('hcs-20').describe('HCS-20 protocol identifier');

/**
 * R8-FG-22 / R9-FG-9 (Phase-7 Cluster D split): amounts are
 * stringified to preserve precision but they can still overflow JS
 * Number when read back. The reader-loose schema accepts any
 * non-empty string; the writer-strict variant adds the bounds.
 *
 * Pre-Phase-7 the bound + min(1) lived directly on the shared field.
 * Both writer-strict (`Hcs20WriterMessageSchema`) AND reader-loose
 * (`Hcs20V2MessageSchema`) inherited the constraint, so legacy
 * testnet refunds with `amt: '1.5e308'` (finite, parses to MAX_VALUE)
 * — wire-conforming under the pre-Phase-6 schema — failed BOTH
 * parses. Third-party readers using our exported schemas got parse
 * failure on existing data; cron's softValidate spammed
 * `schema_validation_failure` on every legacy refund.
 *
 * Phase-7 split: `AmountStringField` (loose) accepts any non-empty
 * string and is used in the reader-loose union; `AmountStringFieldStrict`
 * applies the bound + finite check and is used only in writer-strict
 * variants. New emissions are gated; legacy data flows through.
 *
 * 1e15 covers HBAR's 18-decimal max supply (~50 billion HBAR ×
 * 10^8 tinybar = 5e18) divided down to display units; any value
 * larger is wire corruption.
 */
const AmountStringField = z
  .string()
  .min(1)
  .describe('Amount in display units, stringified for precision (loose; reader accepts any non-empty string)');

const AmountStringFieldStrict = z
  .string()
  .min(1)
  .refine(
    (s) => {
      // R9-P1-006: reject whitespace-only — `Number(' ')` is 0,
      // would silently pass the bound check.
      if (s.trim().length === 0) return false;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 && n < 1e15;
    },
    { message: 'amount must be a finite non-negative string parsing to a Number < 1e15' },
  )
  .describe('Amount in display units, stringified for precision (strict: finite, non-negative, < 1e15, no whitespace-only)');

/**
 * R9-FG-9 / Phase-7 Cluster D split: same archetype as
 * AmountStringField. The reader-loose schema accepts ANY string
 * (including empty) for `originalDepositTxId`; the writer-strict
 * variant requires non-empty. Pre-Phase-7 the `.min(1)` lived on
 * the shared field, so legacy refunds with empty
 * `originalDepositTxId` failed reader parse. Strict variant is the
 * writer-side gate (R8-FG-8 closure); loose is the reader-side
 * forward-compat. Reader-side defense against empty-string still
 * lives in `parseRefund` (closes R9-FG-11).
 */
const RefundOriginalDepositTxIdField = z
  .string()
  .describe('On-chain tx id of the refunded deposit (loose; reader accepts empty for legacy)');

const RefundOriginalDepositTxIdFieldStrict = z
  .string()
  .min(1)
  .describe('On-chain tx id of the refunded deposit (strict; non-empty for new emissions)');

/**
 * R6-FG-9 (Phase-6 Cluster A closure): the on-chain anchor for a
 * failed deposit-credit flush. `UserLedger.scheduleDepositCreditFlush`
 * writes this when a deposit succeeded on-chain but the local-store
 * mutation that would credit the user failed. A topic-only auditor
 * uses this anchor + its `grossAmount` field to compute the user's
 * reconstructed balance (subtracts the un-credited amount from the
 * naive deposit total). Must carry grossAmount, token, cause —
 * pre-fix the writer dropped them silently.
 */
const ControlEventKind = z.enum([
  'killswitch_enabled',
  'killswitch_disabled',
  'force_release_override',
  'force_release',
  'play_uncertain_success_pending_triage',
  'deposit_credit_flush_orphaned',
  // x402 commerce: anchors a paid "rake holiday" grant on the topic so a
  // topic-only auditor sees the CAUSE (the off-chain payment) of the 0%-rake
  // deposits that follow. Non-balance-affecting (no grossAmount); the
  // settlement tx rides `idempotencyKey` (dedup) + `cause` (human summary).
  // Additive + flag-gated (X402_RECORD_TO_HCS20) — verify-audit ignores it
  // (no switch case), the reader preserves it generically.
  'x402_rake_holiday_granted',
]);

// ── Prize entries (sub-schema) ──────────────────────────────

const PrizeFungibleSchema = z.object({
  t: z.literal('ft').describe('Discriminant — fungible token prize'),
  tk: HederaIdField.describe('Token id ("HBAR", "LAZY", or "0.0.X")'),
  amt: z.number().describe('Prize amount in display units'),
});

const PrizeNftSchema = z.object({
  t: z.literal('nft').describe('Discriminant — NFT prize'),
  tk: HederaIdField.describe('NFT collection token id'),
  sym: z
    .string()
    .describe('NFT symbol/short name (display-only; excluded from canonical Merkle hash, R5-FG-1)'),
  ser: z.array(z.number().int()).describe('NFT serial numbers awarded'),
});

export const PrizeEntrySchema = z
  .discriminatedUnion('t', [PrizeFungibleSchema, PrizeNftSchema])
  .describe(
    'Tagged prize entry — `t:"ft"` for fungible, `t:"nft"` for NFT. NFT `sym` is display-only; canonical Merkle hash drops it.',
  );

// ── v2 message: play_session_open ───────────────────────────

export const PlaySessionOpenSchema = z
  .object({
    p: ProtocolField,
    op: z.literal(HCS20_V2_OPS.PLAY_SESSION_OPEN),
    v: z
      .literal(2)
      .describe('Schema version. Session-level fence; future v3 readers can short-circuit unknowns.'),
    sessionId: z.string().min(1).describe('Agent-assigned play-session id (UUID-ish)'),
    user: HederaIdField.describe("User's Hedera account id"),
    agent: HederaIdField.describe("Agent's Hedera account id"),
    agentSeq: NonNegInt.describe(
      'Monotonic per-agent counter recovered at startup via mirror scan; readers detect dropped messages by gap.',
    ),
    strategy: z.string().describe('Strategy preset name active at session-open'),
    boostBps: z.number().int().describe('Boost basis points snapshotted at session-open'),
    expectedPools: NonNegInt.describe('Hint (not guarantee) of pools the session intends to play'),
    ts: Iso8601Field,
  })
  .describe(
    'Written FIRST in a play session. The session-level v fence + agentSeq lets readers detect dropped or v3 messages without parsing every pool.',
  );

// ── v2 message: play_pool_result ────────────────────────────

const StrategyMetaSchema = z
  .object({
    ev: z.number().optional().describe('Computed expected value at decision time'),
    budgetRemaining: z.number().optional().describe('Budget remaining at decision time'),
  })
  .catchall(z.unknown())
  .describe('Agent decision metadata for this pool. Optional — dropped under HCS size pressure.');

export const PlayPoolResultSchema = z
  .object({
    p: ProtocolField,
    op: z.literal(HCS20_V2_OPS.PLAY_POOL_RESULT),
    sessionId: z.string().min(1),
    user: HederaIdField,
    agentSeq: NonNegInt,
    poolId: z.number().int().describe('Contract-side pool id'),
    seq: NonNegInt.describe("This pool's 1-indexed position within the session"),
    entries: NonNegInt.describe('Entries purchased in this pool'),
    spent: z.string().describe('Amount spent in display units (string for big-number precision)'),
    spentToken: HederaIdField.describe('Underlying token spent for this pool'),
    wins: NonNegInt.describe('Count of winning entries (NOT prize value)'),
    prizes: z.array(PrizeEntrySchema).describe('Prizes awarded for this pool'),
    strategyMeta: StrategyMetaSchema.optional(),
    slim: z
      .literal(1)
      .optional()
      .describe(
        'Set when slim-fallback dropped strategyMeta or truncated prize symbols to fit under 1024 bytes (R4-FG-69).',
      ),
    slim_truncated_prizes: NonNegInt.optional().describe(
      'Number of prizes dropped by slim-fallback (R5-FG-110); only present when prize-count cap kicked in.',
    ),
    ts: Iso8601Field,
  })
  .describe(
    'One per pool actually played. Ordered by `seq` within session. The reader recomputes the canonical Merkle root from these and rejects the close on mismatch.',
  );

// ── v2 message: play_session_close ──────────────────────────

const PrizeTransferSchema = z
  .object({
    status: z
      .enum(['succeeded', 'skipped', 'failed', 'recovered'])
      .describe('Prize-transfer outcome at session close'),
    txId: z.string().optional().describe('contractTxId of the transfer call (if attempted)'),
    attempts: z.number().int().optional().describe('Retry attempts (1 = first try)'),
    gasUsed: z.number().int().optional().describe('Final gas used by the successful contract call'),
    lastError: z.string().optional().describe('Truncated last error (failure path only)'),
  })
  .describe('Prize-transfer outcome — the field that would have made the 668 HBAR stuck-prize incident self-explanatory.');

const StrategyDeviationSchema = z
  .object({
    reason: z.string().describe('Why the session deviated from the open-snapshot strategy'),
    field: z.string().optional().describe('Which strategy field deviated (if known)'),
  })
  .describe('Marker for legitimate mid-session deviation from snapshotted strategy (R5-FG-59).');

export const PlaySessionCloseSchema = z
  .object({
    p: ProtocolField,
    op: z.literal(HCS20_V2_OPS.PLAY_SESSION_CLOSE),
    sessionId: z.string().min(1),
    user: HederaIdField,
    agentSeq: NonNegInt,
    poolsPlayed: NonNegInt,
    poolsRoot: z
      .string()
      .describe(
        'sha256 over canonically-sorted pool tuples plus session/user/agent binding (R4-FG-23). Reader rejects close on mismatch.',
      ),
    totalWins: NonNegInt,
    prizeTransfer: PrizeTransferSchema,
    strategyDeviation: StrategyDeviationSchema.optional(),
    ts: Iso8601Field,
  })
  .describe('Written LAST on success. Carries the operator claim about session totals + prize-transfer outcome.');

// ── v2 message: play_session_aborted ────────────────────────

export const PlaySessionAbortedSchema = z
  .object({
    p: ProtocolField,
    op: z.literal(HCS20_V2_OPS.PLAY_SESSION_ABORTED),
    sessionId: z.string().min(1),
    user: HederaIdField,
    agentSeq: NonNegInt,
    completedPools: NonNegInt,
    poolsRoot: z
      .string()
      .optional()
      .describe(
        'Merkle root over completedPools tuples (R4-FG-24). Optional only for backward compat with pre-fix aborted messages; new writers MUST emit.',
      ),
    reason: z.string().describe('Free-text abort cause (e.g. "kill_switch", "agent_seq_seed_failed")'),
    lastError: z
      .string()
      .optional()
      .describe('UTF-8 codepoint-safe truncated error (≈200 bytes, R4-FG-55)'),
    strategyDeviation: StrategyDeviationSchema.optional(),
    abortedAt: Iso8601Field,
  })
  .describe('Written instead of close when the session sequence dies mid-stream — positive terminal marker for the reader.');

// ── v2 message: refund ──────────────────────────────────────

export const RefundSchema = z
  .object({
    p: ProtocolField,
    op: z.literal(HCS20_V2_OPS.REFUND),
    tick: z.string().describe('HCS-20 ledger tick (LLCRED)'),
    // R9-FG-9 / Phase-7 Cluster D: loose at field level so the
    // reader-loose union accepts legacy unbounded amounts (forward-
    // compat with pre-Phase-6 testnet refunds). Writer-strict
    // variant overrides with `AmountStringFieldStrict` to apply the
    // R8-FG-22 bound on new emissions only.
    amt: AmountStringField.describe('Refund amount in display units (loose; writer-strict bounds < 1e15)'),
    from: HederaIdField.describe('Refund source (agent/operator account)'),
    to: HederaIdField.describe('User receiving the refund'),
    /**
     * R6-FG-8 (round-6): underlying token of the refund. Pre-fix the
     * refund message had only `tick: LLCRED` and the reader's
     * `resolveTokenField` fallback returned `'HBAR'` — a LAZY-deposit
     * refund silently recorded as HBAR. Adding this field closes the
     * drift. Optional for backward compat; new writers MUST emit.
     */
    token: HederaIdField.optional().describe(
      'Underlying token id ("HBAR" / "LAZY" / "0.0.X"). R6-FG-8: required for new writers; absent on legacy messages — reader falls back to tick→HBAR.',
    ),
    // R9-FG-9 / Phase-7 Cluster D: loose for reader. Writer-strict
    // variant overrides with `RefundOriginalDepositTxIdFieldStrict`
    // to apply `.min(1)` (R8-FG-8 closure on new emissions only).
    // Reader-side empty-string defense lives in `parseRefund`
    // (R9-FG-11 closure).
    originalDepositTxId: RefundOriginalDepositTxIdField,
    refundTxId: z.string().describe('On-chain tx id of the refund transfer (loose; writer-strict requires non-empty)'),
    reason: z
      .string()
      .describe('Refund reason ("stuck_deposit", "operator_initiated", "admin", or free-text)'),
    performedBy: HederaIdField.describe('Operator/admin account that initiated the refund'),
    rakeReversed: AmountStringField
      .optional()
      .describe(
        'F9: rake amount reversed back from operator state when refunding a previously-raked deposit. Reader subtracts this from operator balance. Default 0 when absent. Cross-field invariant: if present, rakeReversedToken MUST also be present (loose; writer-strict bounds < 1e15).',
      ),
    rakeReversedToken: HederaIdField.optional().describe(
      'Token id of the reversed rake (mirrors deposit token).',
    ),
    ts: Iso8601Field,
  })
  .describe('Operator-initiated refund. Closes the v1 reconciliation gap — refunds previously wrote nothing on-chain.');

// ── v2 message: prize_recovery ──────────────────────────────

export const PrizeRecoverySchema = z
  .object({
    p: ProtocolField,
    op: z.literal(HCS20_V2_OPS.PRIZE_RECOVERY),
    tick: z.string().describe('HCS-20 ledger tick (LLCRED)'),
    v: z.literal(2).describe('Schema version fence'),
    user: HederaIdField,
    agent: HederaIdField,
    prizesTransferred: NonNegInt,
    prizesByToken: z
      .record(z.string(), z.number())
      .describe('Per-token totals from local sessions. R5-FG-89: always emitted, may be `{}`.'),
    contractTxId: z.string().describe('Hedera contract tx id of the successful transferPendingPrizes call'),
    reason: z.string().describe('Operator-recorded reason (or "auto" for scripted)'),
    performedBy: HederaIdField,
    affectedSessions: z.array(z.string()).optional().describe('Local session ids affected, if known'),
    attempts: NonNegInt.optional().describe('Retry attempts before success'),
    gasUsed: NonNegInt.optional().describe('Final gas used by the successful contract call'),
    timestamp: Iso8601Field,
  })
  .describe('Manual operator-initiated recovery of prizes stranded by failed in-flight transferPendingPrizes.');

// ── v2 message: strategy_change ─────────────────────────────

export const StrategyChangeSchema = z
  .object({
    p: ProtocolField,
    op: z.literal(HCS20_V2_OPS.STRATEGY_CHANGE),
    user: HederaIdField,
    previousStrategy: z.string().describe('Strategy preset before the change'),
    newStrategy: z.string().describe('Strategy preset after the change'),
    newStrategyVersion: z.string().describe('Versioned strategy file (e.g. "balanced.0.1.2")'),
    performedBy: z.string().describe('"user" for self-serve, or admin account id'),
    ts: Iso8601Field,
  })
  .describe('Audit anchor for user strategy change. NOT balance-affecting; no tick.');

// ── v2 union ────────────────────────────────────────────────

export const Hcs20V2MessageSchema = z
  .discriminatedUnion('op', [
    PlaySessionOpenSchema,
    PlayPoolResultSchema,
    PlaySessionCloseSchema,
    PlaySessionAbortedSchema,
    RefundSchema,
    PrizeRecoverySchema,
    StrategyChangeSchema,
  ])
  .describe('All v2 audit messages dispatched on the `op` field.');

// ── v1 read-only shapes (legacy testnet support) ────────────
//
// v1 messages are written by pre-v2 agents only. The writer no longer
// emits these; the schemas exist so the reader can validate and so
// the schema doc generator covers the legacy surface.

export const V1MintSchema = z
  .object({
    p: ProtocolField,
    op: z.literal('mint'),
    tick: z.string().describe('HCS-20 tick (LLCRED)'),
    token: HederaIdField.optional().describe(
      'Underlying token id (added 2026-04). Absence = legacy "HBAR" convention.',
    ),
    amt: z.string().describe('Net deposit amount (after rake) in display units'),
    to: HederaIdField,
    memo: z
      .string()
      .optional()
      .describe('Free-form memo; "deposit:<txId>" form carries deposit attribution'),
  })
  .describe('v1 deposit credited to user. Reader extracts depositTxId from memo for dedup.');

export const V1TransferSchema = z
  .object({
    p: ProtocolField,
    op: z.literal('transfer'),
    tick: z.string(),
    token: HederaIdField.optional(),
    amt: z.string(),
    from: HederaIdField,
    to: HederaIdField,
    memo: z
      .string()
      .optional()
      .describe('"rake" or "rake:<depositTxId>" for rake transfers'),
    depositTxId: z
      .string()
      .optional()
      .describe('R5-FG-14: body field for rake-deposit pairing (post-R5)'),
  })
  .describe('v1 transfer — used for rake collection. Reader maps to NormalizedRakeEvent.');

export const V1BurnSchema = z
  .object({
    p: ProtocolField,
    op: z.literal('burn'),
    tick: z.string(),
    token: HederaIdField.optional(),
    amt: z.string(),
    from: HederaIdField,
    memo: z
      .string()
      .optional()
      .describe('"withdraw[al]" or "operator_withdrawal[*]" — disambiguates user vs operator burn'),
    withdrawTxId: z
      .string()
      .optional()
      .describe('F18: body-level idempotency key for burn dedup across reseed'),
  })
  .describe('v1 burn — user withdrawal or operator fee withdrawal.');

export const V1BatchSchema = z
  .object({
    p: ProtocolField,
    op: z.literal('batch'),
    tick: z.string(),
    sessionId: z.string(),
    operations: z
      .array(
        z.object({
          op: z.string(),
          tick: z.string().optional(),
          amt: z.union([z.string(), z.number()]).optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          memo: z.string().optional(),
        }),
      )
      .describe('Burn sub-ops carrying play-session burns; reader extracts poolId/entries from memo'),
    timestamp: Iso8601Field,
  })
  .describe('v1 play session batch. Replaced by v2 per-message session lifecycle.');

export const V1DeploySchema = z
  .object({
    p: ProtocolField,
    op: z.literal('deploy'),
    tick: z.string(),
    name: z.string().optional(),
    max: z.string().optional(),
    lim: z.string().optional(),
  })
  .describe('Topic deployment marker (one per topic).');

// ── control event (v1, no balance op) ───────────────────────

const TokenReservationSchema = z.object({
  token: HederaIdField,
  amount: z.number(),
});

// ControlEventKind defined at top of file (Phase-6 Cluster A: now
// includes 'deposit_credit_flush_orphaned' for R6-FG-9 closure)

export const ControlEventSchema = z
  .object({
    p: ProtocolField,
    op: z.literal('control'),
    tick: z.string(),
    event: ControlEventKind.describe('Control-event kind'),
    reason: z.string().nullable().optional(),
    by: z.string().describe('Performing operator account id'),
    uncertainTxId: z
      .string()
      .optional()
      .describe('For force_release / play_uncertain_success_pending_triage: the dead-letter id'),
    kind: z.string().optional().describe('For force_release: dead-letter kind label'),
    mirrorResult: z.string().optional().describe('For force_release_override: mirror outcome at override time'),
    userId: HederaIdField.optional().describe('For play_uncertain_success_pending_triage: affected user'),
    tokenReservations: z.array(TokenReservationSchema).optional().describe(
      'For triage events: held token reservations so a topic-only auditor sees the owed-back balance.',
    ),
    idempotencyKey: z
      .string()
      .optional()
      .describe('R3-FG-22: deterministic body-level dedup nonce. Reader collapses (event, idempotencyKey) tuples.'),
    /**
     * R6-FG-9 / Phase-6 Cluster A: gross deposit amount (display units)
     * for `deposit_credit_flush_orphaned` events. Required so a
     * topic-only DR replay can reconstruct the user's balance without
     * Redis. Stringified for precision.
     */
    grossAmount: AmountStringField.optional().describe(
      'For deposit_credit_flush_orphaned: the gross deposit amount that failed to credit (display units). Operator balance reconstruction subtracts this from the naive deposit total.',
    ),
    /**
     * R6-FG-9 / Phase-6 Cluster A: underlying token of the orphaned
     * credit-flush. Without this, verify-audit can't attribute the
     * un-credited amount to the right per-token ledger.
     */
    token: HederaIdField.optional().describe(
      'For deposit_credit_flush_orphaned: token of the un-credited deposit ("HBAR" / "LAZY" / "0.0.X").',
    ),
    /**
     * R6-FG-9 / Phase-6 Cluster A + R9-P4-004 / Phase-7 Cluster D:
     * free-form cause string. `.max(500)` keeps oversized stack
     * traces from blowing the 1024-byte HCS topic cap and triggering
     * `enforceTopicMessageSizeLimit` throws inside `recordControlEvent`
     * — the worst time for that path to fail (deposit already failed
     * to credit; orphan anchor was the operator's last signal).
     */
    cause: z
      .string()
      .max(500)
      .optional()
      .describe('For deposit_credit_flush_orphaned: free-form cause label (Redis blip, store error, etc.). Capped at 500 chars to fit HCS 1024-byte topic limit.'),
    timestamp: Iso8601Field,
  })
  .describe('Operator control event — kill switch toggles, triage anchors, deposit-credit orphans. Not balance-affecting on its own; verify-audit applies grossAmount on deposit_credit_flush_orphaned.');

// ── Read-side combined union (for the doc generator) ────────

export const HCS20_SCHEMAS = {
  // v2
  play_session_open: PlaySessionOpenSchema,
  play_pool_result: PlayPoolResultSchema,
  play_session_close: PlaySessionCloseSchema,
  play_session_aborted: PlaySessionAbortedSchema,
  refund: RefundSchema,
  prize_recovery: PrizeRecoverySchema,
  strategy_change: StrategyChangeSchema,
  // v1
  mint: V1MintSchema,
  transfer: V1TransferSchema,
  burn: V1BurnSchema,
  batch: V1BatchSchema,
  deploy: V1DeploySchema,
  // control
  control: ControlEventSchema,
} as const;

export type Hcs20OpName = keyof typeof HCS20_SCHEMAS;

// ── Inferred type re-exports (consumed by hcs20-v2.ts) ──────

export type PlaySessionOpenMessage = z.infer<typeof PlaySessionOpenSchema>;
export type PlayPoolResultMessage = z.infer<typeof PlayPoolResultSchema>;
export type PlaySessionCloseMessage = z.infer<typeof PlaySessionCloseSchema>;
export type PlaySessionAbortedMessage = z.infer<typeof PlaySessionAbortedSchema>;
export type RefundMessage = z.infer<typeof RefundSchema>;
export type PrizeRecoveryMessage = z.infer<typeof PrizeRecoverySchema>;
export type StrategyChangeMessage = z.infer<typeof StrategyChangeSchema>;
export type Hcs20V2Message = z.infer<typeof Hcs20V2MessageSchema>;
export type PrizeEntry = z.infer<typeof PrizeEntrySchema>;

export type V1MintMessage = z.infer<typeof V1MintSchema>;
export type V1TransferMessage = z.infer<typeof V1TransferSchema>;
export type V1BurnMessage = z.infer<typeof V1BurnSchema>;
export type V1BatchMessage = z.infer<typeof V1BatchSchema>;
export type V1DeployMessage = z.infer<typeof V1DeploySchema>;
export type ControlEventMessage = z.infer<typeof ControlEventSchema>;

// ── Strict writer-side union (Phase-6 R8-FG-1 closure) ──────
//
// The reader-facing `Hcs20V2MessageSchema` above is intentionally
// loose: forward-compat for v3 fields. The writer cannot use it
// directly — Zod's default mode strips unknown keys silently, so a
// writer typo (`rakeRevsered: '14'` instead of `rakeReversed`)
// passes parse, gets stripped from the serialized JSON, never
// reaches the topic. Pre-Phase-6 `validateV2Message` was that loose
// path; the Phase-2 thesis "drift surfaces at submit time" was
// false today.
//
// Phase-6 builds a STRICT variant: every option's `.strict()`
// rebuilds the discriminated union with unknownKeys-rejected
// objects. Plus PrizeRecovery + ControlEvent (which previously
// bypassed the writer gate via the legacy `submitMessage` path —
// R8-FG-2). Cross-field invariants (rakeReversed pairing) are
// enforced inside `validateV2Message` after the parse.

const PlaySessionOpenStrictSchema = PlaySessionOpenSchema.strict();
const PlayPoolResultStrictSchema = PlayPoolResultSchema.strict();
const PlaySessionCloseStrictSchema = PlaySessionCloseSchema.strict();
const PlaySessionAbortedStrictSchema = PlaySessionAbortedSchema.strict();
// R9-FG-9 / Phase-7 Cluster D: writer-strict variant overrides
// loose-shared fields with bounded variants. Reader-loose schema
// (RefundSchema) accepts legacy unbounded amounts and empty
// originalDepositTxId for forward-compat with pre-Phase-6 testnet
// data; writer-strict refuses both. The override pattern:
// `.extend({...}).strict()` applies the field swap THEN seals the
// object against unknown keys. A regression that drops the override
// reverts new writer emissions to the legacy unbounded shape.
const RefundStrictSchema = RefundSchema.extend({
  amt: AmountStringFieldStrict,
  rakeReversed: AmountStringFieldStrict.optional(),
  originalDepositTxId: RefundOriginalDepositTxIdFieldStrict,
}).strict();
const PrizeRecoveryStrictSchema = PrizeRecoverySchema.strict();
const StrategyChangeStrictSchema = StrategyChangeSchema.strict();
const ControlEventStrictSchema = ControlEventSchema.extend({
  // R9-P4-003 / Phase-7 Cluster D: also tighten grossAmount in
  // writer-strict so deposit_credit_flush_orphaned can't ship with
  // an unbounded value.
  grossAmount: AmountStringFieldStrict.optional(),
}).strict();

/**
 * Strict, writer-only discriminated union over every op the agent
 * is allowed to emit. Includes ControlEvent + PrizeRecovery so
 * those paths can no longer bypass `validateV2Message` via the
 * legacy `submitMessage` route (R8-FG-2 closure).
 */
export const Hcs20WriterMessageSchema = z
  .discriminatedUnion('op', [
    PlaySessionOpenStrictSchema,
    PlayPoolResultStrictSchema,
    PlaySessionCloseStrictSchema,
    PlaySessionAbortedStrictSchema,
    RefundStrictSchema,
    PrizeRecoveryStrictSchema,
    StrategyChangeStrictSchema,
    ControlEventStrictSchema,
  ])
  .describe(
    'Strict union of every writer-emittable HCS-20 op. validateV2Message uses this; unknown keys are REJECTED, not stripped.',
  );

/** Strict-typed message — what writers MUST construct to pass `validateV2Message`. */
export type Hcs20WriterMessage = z.infer<typeof Hcs20WriterMessageSchema>;

// ── Writer helper ───────────────────────────────────────────

/**
 * Validate an outbound writer message before submission. Two layers:
 *
 *   1. **Strict shape** via `Hcs20WriterMessageSchema.parse`. Unknown
 *      keys throw (no silent stripping — the R8-FG-1 closure).
 *      Required fields, type tags, value ranges, and per-field
 *      refines (R8-FG-22 amount bounds, R8-FG-8 originalDepositTxId
 *      non-empty) all gate here.
 *
 *   2. **Cross-field invariants** that Zod can't express inside a
 *      discriminatedUnion option (refines on the option wrap the
 *      schema and break the union). Today: `rakeReversed` and
 *      `rakeReversedToken` must both be present or both absent — a
 *      refund with one but not the other slips dedup at the
 *      operator-balance reducer (R8-FG-5).
 *
 * Throws with the field path on the first violation. Caller's
 * existing catch ladder (PreserveClaimError preservation) is unchanged.
 */
export function validateV2Message<T extends Hcs20WriterMessage>(payload: T): T {
  const parsed = Hcs20WriterMessageSchema.parse(payload) as T;
  // Cross-field invariants. Add new ones here as the schema grows.
  if (parsed.op === 'refund') {
    const refund = parsed as Extract<Hcs20WriterMessage, { op: 'refund' }>;
    const hasReversed = refund.rakeReversed !== undefined;
    const hasToken = refund.rakeReversedToken !== undefined;
    if (hasReversed !== hasToken) {
      throw new Error(
        `[validateV2Message] refund: rakeReversed and rakeReversedToken must both be present or both absent ` +
          `(got rakeReversed=${refund.rakeReversed ?? 'undefined'}, rakeReversedToken=${refund.rakeReversedToken ?? 'undefined'})`,
      );
    }
  }
  // R9-P4-003 / Phase-7 Cluster D: cross-field invariant for
  // `deposit_credit_flush_orphaned` events. Schema declares
  // `grossAmount`, `token`, `userId` as `.optional()` so the
  // reader-loose schema can parse legacy / non-orphan control
  // events that don't carry them. But for THIS specific event
  // kind, all three are load-bearing (verify-audit subtracts
  // grossAmount per token from the user's reconstructed deposit
  // total — without ANY of the three, the subtraction silently
  // skips). Pre-fix a writer regression dropping any of the three
  // passed Zod validation; the alert fired without correction
  // and operator's DR replay was wrong.
  if (parsed.op === 'control') {
    const ctl = parsed as Extract<Hcs20WriterMessage, { op: 'control' }>;
    if (ctl.event === 'deposit_credit_flush_orphaned') {
      if (!ctl.grossAmount || !ctl.token || !ctl.userId) {
        throw new Error(
          `[validateV2Message] control(deposit_credit_flush_orphaned) requires grossAmount, token, userId ` +
            `(got grossAmount=${ctl.grossAmount ?? 'undefined'}, token=${ctl.token ?? 'undefined'}, userId=${ctl.userId ?? 'undefined'})`,
        );
      }
    }
  }
  return parsed;
}

/**
 * Reader-side dispatcher. Returns the parsed + typed message on
 * success, or `null` on parse failure (loose mode — caller falls
 * back to legacy hand-coded parsers). The op string is the
 * discriminant.
 */
export function safeParseByOp<K extends Hcs20OpName>(
  op: K,
  payload: unknown,
): z.infer<(typeof HCS20_SCHEMAS)[K]> | null {
  const schema = HCS20_SCHEMAS[op];
  const result = schema.safeParse(payload);
  return result.success ? (result.data as z.infer<(typeof HCS20_SCHEMAS)[K]>) : null;
}
