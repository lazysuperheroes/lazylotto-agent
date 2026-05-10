/**
 * HCS-20 audit topic reader.
 *
 * Walks a stream of decoded HCS-20 messages (already pulled from a
 * mirror node and JSON-parsed) and produces normalized audit events
 * + reconstructed play sessions. Handles both v1 (legacy `op:'batch'`)
 * and v2 (`play_session_open` / `play_pool_result` / `play_session_close`
 * sequence) shapes via a single dispatcher and two pure parsers.
 *
 * The state machine for play session reconstruction lives here too:
 * given a stream of v2 messages, group them by sessionId and walk
 * each group through `OPEN → IN_PROGRESS → CLOSED | ABORTED | ORPHANED`
 * with explicit invariant checks (poolsRoot match, agentSeq monotonicity,
 * timeout-based orphan detection).
 *
 * Designed to be:
 *   - Pure (no I/O, no Hedera SDK calls — just data in, data out)
 *   - Testable (drop-in JSON fixtures)
 *   - Reusable (called from both /api/user/audit and /api/admin/audit)
 *   - Forward compatible (v3 messages get parsed-or-skipped, never crash)
 */

import {
  type NormalizedSession,
  type NormalizedPool,
  type SessionStatus,
  type PrizeEntry,
  type PlaySessionOpenMessage,
  type PlayPoolResultMessage,
  type PlaySessionCloseMessage,
  type PlaySessionAbortedMessage,
  computePoolsRoot,
  SESSION_INFLIGHT_TIMEOUT_MS,
  HCS20_SCHEMAS,
  type Hcs20OpName,
} from './hcs20-v2.js';

// ── Input shape ─────────────────────────────────────────────────

/**
 * A single HCS-20 message as it comes back from the mirror node,
 * already JSON-decoded. Both audit endpoints already do this
 * decoding before calling the reader.
 */
export interface RawTopicMessage {
  /** Mirror node sequence number (consensus order). */
  sequence: number;
  /** Consensus timestamp (ISO string). */
  timestamp: string;
  /** Decoded JSON payload — shape depends on op. */
  payload: Record<string, unknown>;
}

// ── Output shapes ────────────────────────────────────────────────

/**
 * One audit event in the normalized form. Both v1 and v2 messages
 * map to this shape, so downstream code (audit page, reconciler,
 * CLI verifier) never has to branch on schema version.
 */
export type NormalizedEvent =
  | NormalizedDepositEvent
  | NormalizedRakeEvent
  | NormalizedWithdrawalEvent
  | NormalizedOperatorWithdrawalEvent
  | NormalizedRefundEvent
  | NormalizedPrizeRecoveryEvent
  | NormalizedStrategyChangeEvent
  | NormalizedDeployEvent
  | NormalizedControlEvent
  | NormalizedSessionEvent
  | NormalizedUnknownEvent;

interface BaseEvent {
  sequence: number;
  timestamp: string;
}

export interface NormalizedDepositEvent extends BaseEvent {
  type: 'deposit';
  user: string;
  amount: number;
  token: string;
  memo?: string;
}

export interface NormalizedRakeEvent extends BaseEvent {
  type: 'rake';
  user: string;
  agent: string;
  amount: number;
  token: string;
  /**
   * R5-FG-14: optional deposit txId so a topic-only auditor can pair
   * `mint(rakeAmount>0)` with the rake transfer (conservation
   * invariant 1) and `verify-audit.ts` can flag a missing pair as a
   * critical alert. Pre-fix the rake event carried only `memo:'rake'`.
   * Legacy v1 rakes pre-R5 emit no depositTxId — those still parse
   * but are exempt from the pairing check at the caller.
   */
  depositTxId?: string;
}

export interface NormalizedWithdrawalEvent extends BaseEvent {
  type: 'withdrawal';
  user: string;
  amount: number;
  token: string;
  /**
   * On-chain withdraw transaction id, when the burn message includes
   * one. F18 (2026-05-06 audit A-13 / DR-10): reducers use this to
   * dedup duplicate burns emitted by Lambda-crash + reseed
   * (recordWithdrawal had no body-level idempotency before F18).
   * Optional for backward compat with pre-F18 burns.
   */
  withdrawTxId?: string;
}

export interface NormalizedOperatorWithdrawalEvent extends BaseEvent {
  type: 'operator_withdrawal';
  agent: string;
  amount: number;
  token: string;
  /** Same as NormalizedWithdrawalEvent.withdrawTxId. */
  withdrawTxId?: string;
}

export interface NormalizedRefundEvent extends BaseEvent {
  type: 'refund';
  agent: string;
  user: string;
  amount: number;
  token: string;
  originalDepositTxId: string;
  refundTxId: string;
  reason: string;
  performedBy: string;
  /**
   * R6-FG-7 (round-6): the rake amount reversed back from operator
   * state when refunding a previously-raked deposit. Pre-fix
   * `parseRefund` did not extract this, so verify-audit's reducers
   * treated every refund as `rakeReversed=0` even when the writer
   * emitted a non-zero value — operator balance reconstruction
   * ran short by exactly the sum of un-credited reversals. Default
   * 0 when absent (legacy refunds predate the field).
   */
  rakeReversed?: number;
  /** Token of the reversed rake (mirrors deposit token). */
  rakeReversedToken?: string;
}

export interface NormalizedPrizeRecoveryEvent extends BaseEvent {
  type: 'prize_recovery';
  user: string;
  agent: string;
  prizesTransferred: number;
  prizesByToken?: Record<string, number>;
  contractTxId: string;
  reason: string;
  performedBy: string;
  attempts?: number;
  gasUsed?: number;
  affectedSessions?: string[];
}

export interface NormalizedDeployEvent extends BaseEvent {
  type: 'deploy';
  tick: string;
  name?: string;
  max?: string;
}

/**
 * Strategy change audit anchor. Not a balance-moving op — purely a
 * marker so external auditors can reconstruct which strategy was
 * active for any given play session by finding the most recent
 * strategy_change message before that session's open message.
 */
export interface NormalizedStrategyChangeEvent extends BaseEvent {
  type: 'strategy_change';
  user: string;
  previousStrategy: string;
  newStrategy: string;
  newStrategyVersion: string;
  performedBy: string;
}

export interface NormalizedControlEvent extends BaseEvent {
  type: 'control';
  event: string;
  reason?: string;
  by: string;
  /**
   * F20 (2026-05-06 audit DR-06): preserve the load-bearing fields
   * that `recordControlEvent` writes for force-release and
   * play-uncertain triage anchors. Without these, `verify-audit.ts`
   * cannot tell what kind of action a `force_release` event covered
   * or which user's reservations are awaiting manual reconstruction.
   */
  uncertainTxId?: string;
  kind?: string;
  mirrorResult?: string;
  userId?: string;
  tokenReservations?: Array<{ token: string; amount: number }>;
  /**
   * R4-FG-7 (round-4 high): R3-FG-22 stamps a deterministic
   * `idempotencyKey` on triage anchors so verifier + force-release
   * siblings produce the same on-chain message body for the same
   * uncertainTxId. The reader exposes the key here AND deduplicates
   * the SECOND control event with the same key — without this,
   * R3-FG-22 was wire-only decoration and consumers (verify-audit,
   * monitoring panel, audit page) double-counted reservations.
   */
  idempotencyKey?: string;
  /**
   * R6-FG-9 / Phase-6 Cluster C: gross deposit amount + token + cause
   * for `event === 'deposit_credit_flush_orphaned'`. The writer
   * stamps these fields on the topic; verify-audit consumes them
   * during reconstruction to subtract un-credited amounts from the
   * naive deposit total. Pre-Phase-6 the reader silently dropped them
   * even though the writer (post-R5-FG-45) emitted them.
   */
  grossAmount?: string;
  token?: string;
  cause?: string;
}

/**
 * The "session" event is special — it represents a fully
 * reconstructed play session, not a single on-chain message. It's
 * emitted ONCE per session after the reader's state machine has
 * walked all the messages with that sessionId. The `status` field
 * tells consumers what to render.
 */
export interface NormalizedSessionEvent extends BaseEvent {
  type: 'session';
  session: NormalizedSession;
}

export interface NormalizedUnknownEvent extends BaseEvent {
  type: 'unknown';
  op: string;
  payload: Record<string, unknown>;
}

/** Aggregate output of the reader. */
export interface AuditReaderResult {
  events: NormalizedEvent[];
  sessions: NormalizedSession[];
  /** Stats for diagnostics. */
  stats: {
    totalMessages: number;
    v1Messages: number;
    v2Messages: number;
    unknownMessages: number;
    skippedMessages: number;
    sessionsByStatus: Record<SessionStatus, number>;
    /** agentSeq gaps detected. Each entry is `[agent, gap_after_seq]`. */
    agentSeqGaps: { agent: string; afterSeq: number }[];
    /**
     * R2-FG-18 (round-2 S-08 / TR-09): agentSeq DUPLICATES detected.
     * Each entry lists the agent, the colliding seq, and the session
     * ids that claimed it. Two messages with the same `agentSeq` from
     * the same agent indicate either:
     *   (a) seed mis-set (e.g. mirror lag → SETNX seeded with a value
     *       that overlapped existing on-chain history), or
     *   (b) a compromised submitter forged a duplicate to mask a real
     *       session.
     * Either way, downstream balance reconstruction is suspect — the
     * verifier surfaces this as a critical alert.
     */
    agentSeqDuplicates: { agent: string; seq: number; sessions: string[] }[];
    /**
     * Phase-2 R7: schema-validation failures detected by the soft
     * loose-mode pass. Each entry is `(op, count, sample)` so a
     * dashboard can surface "the writer emitted N messages of op=X
     * that didn't match the schema". Soft mode means we still parse
     * and emit normalized events via the legacy hand-coded extractors
     * — the schemas are a regression DETECTOR for now, not the
     * source of truth for the read path. After one soak cycle the
     * legacy parsers can be removed and the schema becomes the only
     * gate.
     */
    schemaValidationFailures: {
      op: string;
      count: number;
      firstError?: string;
    }[];
    /**
     * R10-FG-3 / Phase-8 Cluster B + R11-FG-5 / Phase-9 Cluster B:
     * refund messages dropped at `parseRefund` because the on-chain
     * payload was malformed. `parseRefund` returns null for FIVE
     * distinct reasons; pre-Phase-9 only the empty-`originalDepositTxId`
     * branch was categorized, so the other four (missing from/to,
     * non-finite amt, missing refundTxId) fell through to the
     * catch-all `skippedMessages` and verify-audit's reducers couldn't
     * distinguish them — same OVER-CREDIT signature R10-FG-3 named.
     *
     * Phase-9 splits the counter into per-reason fields so verify-audit's
     * alert array can fire one alert per category. Consumers wire
     * each non-zero counter into a categorized alert (mirror
     * `schemaValidationFailures` pattern).
     */
    refundsDroppedEmptyOriginal: number;
    /** R11-FG-5: missing `from` or `to` field on the refund payload. */
    refundsDroppedMissingParty: number;
    /** R11-FG-5: `amt` field absent or not a finite number. */
    refundsDroppedInvalidAmt: number;
    /** R11-FG-5: missing `refundTxId` field on the refund payload. */
    refundsDroppedMissingRefundTx: number;
  };
}

// ── Soft schema validation (Phase-2 R7) ─────────────────────────
//
// Run each incoming message against its op-specific Zod schema and
// surface failures as a stat. Pure observation — does NOT short-
// circuit the existing dispatch. Lets us catch writer/schema drift
// at the read site without flipping a behavior change in the same
// release. After soak, the legacy hand-coded extractors at the
// bottom of this file get retired in favor of the schemas.

interface SchemaSoftReport {
  failures: Map<string, { count: number; firstError?: string }>;
  recordFailure: (op: string, error: string) => void;
}

function makeSchemaSoftReport(): SchemaSoftReport {
  const failures = new Map<string, { count: number; firstError?: string }>();
  return {
    failures,
    recordFailure(op, error) {
      const entry = failures.get(op);
      if (entry) {
        entry.count++;
      } else {
        failures.set(op, { count: 1, firstError: error });
      }
    },
  };
}

/**
 * R8-FG-15 / Phase-6 Cluster C: env-gated soft validation.
 *
 * Pre-fix `softValidate` ran unconditionally on every message. Zod
 * `safeParse` is ~5-50µs per call; for a 10k-message topic walk
 * (testnet has been writing v2 for weeks) this added ~50-500ms per
 * audit-page render. The user audit page invokes the reader
 * synchronously per request — direct user-facing latency cost for
 * what is operationally a CI/CRON-only signal.
 *
 * The gate: enable only when `HCS20_SOFT_VALIDATE=1` (cron +
 * verify-audit set this) OR `process.env.NODE_ENV === 'test'` (so
 * the existing test fixtures keep their assertions). Default off
 * for hot user paths.
 */
function isSoftValidateEnabled(): boolean {
  return (
    process.env.HCS20_SOFT_VALIDATE === '1' ||
    process.env.NODE_ENV === 'test' ||
    // R8-FG-15: also enable in CLI tests run via tsx without NODE_ENV.
    // node:test sets process.env.NODE_TEST_CONTEXT in its workers.
    typeof process.env.NODE_TEST_CONTEXT === 'string'
  );
}

/**
 * R9-FG-3 / Phase-7 Cluster A: one-time boot warning when soft-validate
 * is disabled in production. Pre-fix the env was never set anywhere
 * and operators had no signal — the schema-drift detector silently
 * shipped dead. This warn lights up on Vercel deploys missing the
 * env var so the operator sees the gap during the first cold start.
 *
 * Fires once per Lambda warm cycle. The `__softValidateBootWarned`
 * flag pins to globalThis so HMR / multi-import doesn't re-fire it.
 */
function maybeFireBootWarning(): void {
  const g = globalThis as { __softValidateBootWarned?: boolean };
  if (g.__softValidateBootWarned) return;
  if (process.env.VERCEL === '1' && !isSoftValidateEnabled()) {
    console.warn(
      '[hcs20-reader] HCS20_SOFT_VALIDATE not set on Vercel — schema-drift detection ' +
        'is disabled. `result.stats.schemaValidationFailures` will be empty regardless ' +
        'of writer drift. Set HCS20_SOFT_VALIDATE=1 on cron + verify-audit paths or ' +
        'check the deploy checklist (docs/mainnet-deploy-checklist.md).',
    );
  }
  g.__softValidateBootWarned = true;
}

function softValidate(
  op: string,
  payload: Record<string, unknown>,
  report: SchemaSoftReport,
): void {
  if (!isSoftValidateEnabled()) return;
  // R8-FG-18 / Phase-6 Cluster C: unknown ops must surface as a
  // signal too. Pre-fix `if (!(op in HCS20_SCHEMAS)) return;` silently
  // dropped them; an attacker injection or v3 message left no
  // trace in `schemaValidationFailures`. Now we record under the
  // sentinel `<unknown>` so dashboards see the count.
  if (!(op in HCS20_SCHEMAS)) {
    report.recordFailure('<unknown>', `op="${op}" has no registered schema`);
    return;
  }
  const schema = HCS20_SCHEMAS[op as Hcs20OpName];
  const result = schema.safeParse(payload);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path = firstIssue?.path.join('.') ?? '<root>';
    report.recordFailure(op, `${path}: ${firstIssue?.message ?? 'schema mismatch'}`);
  }
}

// ── Legacy Merkle cutover (R5-FG-2) ─────────────────────────────

/**
 * R5-FG-2 (P1-004 + P3-005 + P4-010 + P6-005): the legacy unbound
 * Merkle fallback at `bucket.close.poolsRoot` validation is a forever
 * opt-out for an attacker with operator-key access — bound check
 * fails, legacy succeeds, status reads as `closed_success` with only
 * a buried warning. After R4-FG-23 was deployed, every legitimate
 * writer signs with the bound form; any session emitted AFTER that
 * deployment with a legacy unbound root is forged and must be
 * `corrupt`, not "passes with warning".
 *
 * The cutover defaults to the R4 deploy time (2026-05-08T00:00:00Z,
 * matching the R4-2 commit). Operators can override via
 * `LEGACY_MERKLE_CUTOFF_TIMESTAMP` (any Date.parse-able value) to
 * accommodate replay of pre-cutover archives.
 */
const DEFAULT_LEGACY_MERKLE_CUTOFF_ISO = '2026-05-08T00:00:00.000Z';

function getLegacyMerkleCutoffMs(): number {
  const raw = process.env.LEGACY_MERKLE_CUTOFF_TIMESTAMP;
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.parse(DEFAULT_LEGACY_MERKLE_CUTOFF_ISO);
}

function isPostLegacyCutoff(messageTimestamp: string | undefined): boolean {
  if (!messageTimestamp) return false;
  const ts = Date.parse(messageTimestamp);
  if (!Number.isFinite(ts)) return false;
  return ts > getLegacyMerkleCutoffMs();
}

// ── Main entry point ────────────────────────────────────────────

/**
 * Parse a stream of HCS-20 topic messages and return normalized
 * events + reconstructed sessions. Pure function — no I/O.
 *
 * @param messages - Decoded topic messages in consensus order. The
 *   reader assumes the input is already sorted by sequence number;
 *   it does NOT re-sort.
 * @param now - Current time (used for in-flight session timeout).
 *   Defaults to Date.now() but tests can pass a fixed value.
 */
export async function parseAuditTopic(
  messages: RawTopicMessage[],
  now: number = Date.now(),
): Promise<AuditReaderResult> {
  // R9-FG-3 / Phase-7 Cluster A: surface boot warning once per
  // Lambda warm cycle if soft-validate is disabled in production.
  maybeFireBootWarning();

  // Phase 1: classify each message and emit non-session events.
  // Pool/open/close/aborted messages are stashed in sessionBuckets
  // for phase 2.
  const events: NormalizedEvent[] = [];
  const sessionBuckets = new Map<
    string,
    {
      open?: PlaySessionOpenMessage & { sequence: number; timestamp: string };
      pools: (PlayPoolResultMessage & { sequence: number; timestamp: string })[];
      close?: PlaySessionCloseMessage & { sequence: number; timestamp: string };
      aborted?: PlaySessionAbortedMessage & { sequence: number; timestamp: string };
      // v1 batch fallback — when we see an op:'batch' for the same
      // sessionId, treat it as a complete legacy session and surface
      // it through the same NormalizedSession path.
      v1Batch?: {
        sequence: number;
        timestamp: string;
        burns: { poolId: number; entries: number; spent: number }[];
        from?: string;
      };
      // All agentSeq values seen for messages tagged with this
      // session, regardless of which v2 op the message was. The
      // owning agent is resolved in phase 2 from open.agent.
      sessionAgentSeqs: number[];
    }
  >();
  // Global per-agent agentSeq tracking, populated in phase 2 once
  // we know each session's owning agent. The architecture review
  // (architect agent) recommended dropping `agent` from non-open
  // messages to keep size under 1024 bytes; this two-phase
  // approach restores gap-detection without paying the size cost
  // on every pool/close message.
  // R2-FG-18: agent → seq → list of session ids that claimed that
  // seq. A `Set<number>` would silently collapse duplicates; the
  // bug it hides (two sessions claiming the same seq) is exactly
  // the pathological case we need to surface.
  const seenAgentSeqByAgent = new Map<string, Map<number, string[]>>();
  // R4-FG-7: dedup control events on idempotencyKey. R3-FG-22 stamps
  // 'play-triage:<txId>' on both the verifier and force-release
  // sibling triage anchors. Without this Set, both anchors emit as
  // separate NormalizedControlEvents and downstream consumers
  // double-count.
  const seenControlIdempotencyKeys = new Set<string>();

  // R4-FG-58 (round-4 medium): reader-side dedup of refund anchors on
  // `refundTxId`. F18 added burn dedup via `seenWithdrawTxIdsByKind`;
  // refunds were the sibling miss. A verifier-side `recordRefund` retry
  // after a partial failure (Lambda freeze post-submit-pre-stamp) emits
  // a SECOND refund anchor with the same `refundTxId`; without this
  // dedup the reader summed `rakeReversed` twice and operator balance
  // reconstruction showed double-rake-reversal vs actual.
  const seenRefundTxIds = new Set<string>();
  // R5-FG-94 (P3-012): track the FIRST-seen rakeReversed amount per
  // refundTxId so we can sanity-check duplicates against the keeper.
  // If a duplicate's rakeReversed differs from the kept event, the
  // operator-key is suspect — emit a warning. Pre-fix the dedup
  // SILENTLY skipped without checking content equality.
  const seenRefundRakeReversed = new Map<string, number>();
  // R5-FG-14 / R5-FG-24 (P1-011 + P12-310): reader-side dedup for
  // rake transfers on `(from, depositTxId)`. A retry of `recordDeposit`
  // (replay-deposit, mid-flight Lambda freeze) can emit two rake
  // transfers for one logical deposit; without dedup the reader
  // double-counts `totalRakeCollected` while `totalRakeReversed`
  // matches one of them. Legacy rakes with no depositTxId are NOT
  // deduped (no key to dedup on); operators reading pre-R5 topics
  // accept the legacy ambiguity.
  const seenRakeKeys = new Set<string>();
  // R5-FG-95 (P3-013): dedup control events by (idempotencyKey, kind)
  // tuple so a double-emit (504 retry, two admin sessions racing) is
  // collapsed at the reader. Without this, a `force_release`
  // idempotencyKey-bearing event could appear twice if the writer-
  // side dedup fails AND verify-audit double-counts.
  const seenControlEventKeys = new Set<string>();
  // R5-FG-106 (P11-010): bound seenRefundTxIds to a recent window
  // (60 days). Pre-fix the Set grew unbounded across reader runs on
  // cold-loaded large topics. The 60-day window matches the per-tx
  // refund claim TTL (30 days) plus a safety margin.
  const REFUND_DEDUP_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
  // R5-FG-23 (P3-004 + P3-012): reader-side dedup of refund anchors
  // by `originalDepositTxId`. R4-FG-58 added dedup by `refundTxId`;
  // R4-FG-59 closed the orthogonal "different refundTxIds for same
  // originalDepositTxId" case in verify-audit only. The reader fed
  // to /api/admin/audit, /api/user/audit, and the audit page UI did
  // NOT track this — two refund anchors for the same originalDepositTxId
  // (one in-flight, one verifier with a fresh refundTxId) both
  // passed through, summing rakeReversed twice.
  const seenRefundedOriginals = new Set<string>();
  // R5-FG-24 (P1-003): reader-side dedup of v1 `mint` (deposit) anchors
  // by `depositTxId` extracted from `memo:'deposit:<txId>'`. Pre-fix
  // an operator-driven /api/admin/replay-deposit retry that re-fired
  // recordDeposit produced TWO mint anchors with identical body →
  // reconstructed user balance showed DOUBLE the actual deposit.
  const seenDepositTxIds = new Set<string>();
  const stats: AuditReaderResult['stats'] = {
    totalMessages: messages.length,
    v1Messages: 0,
    v2Messages: 0,
    unknownMessages: 0,
    skippedMessages: 0,
    sessionsByStatus: {
      closed_success: 0,
      closed_aborted: 0,
      in_flight: 0,
      orphaned: 0,
      corrupt: 0,
    },
    agentSeqGaps: [],
    agentSeqDuplicates: [],
    schemaValidationFailures: [],
    // R10-FG-3 + R11-FG-5: see field docstrings on
    // AuditReaderResult.stats.refundsDropped* fields.
    refundsDroppedEmptyOriginal: 0,
    refundsDroppedMissingParty: 0,
    refundsDroppedInvalidAmt: 0,
    refundsDroppedMissingRefundTx: 0,
  };
  const schemaReport = makeSchemaSoftReport();

  for (const msg of messages) {
    const op = String(msg.payload.op ?? 'unknown');
    softValidate(op, msg.payload, schemaReport);

    // ── v2 messages ────────────────────────────────────────
    if (
      op === 'play_session_open' ||
      op === 'play_pool_result' ||
      op === 'play_session_close' ||
      op === 'play_session_aborted'
    ) {
      stats.v2Messages++;
      const sessionId = String(msg.payload.sessionId ?? '');
      if (!sessionId) {
        stats.skippedMessages++;
        continue;
      }

      const bucket = sessionBuckets.get(sessionId) ?? { pools: [], sessionAgentSeqs: [] };
      sessionBuckets.set(sessionId, bucket);

      // Stash the agentSeq under the session bucket. We attribute
      // it to a specific agent in phase 2 once we have the open
      // message (only the open carries `agent` to keep per-message
      // size down).
      if (typeof msg.payload.agentSeq === 'number') {
        bucket.sessionAgentSeqs.push(msg.payload.agentSeq);
      }

      if (op === 'play_session_open') {
        bucket.open = {
          ...(msg.payload as unknown as PlaySessionOpenMessage),
          sequence: msg.sequence,
          timestamp: msg.timestamp,
        };
      } else if (op === 'play_pool_result') {
        bucket.pools.push({
          ...(msg.payload as unknown as PlayPoolResultMessage),
          sequence: msg.sequence,
          timestamp: msg.timestamp,
        });
      } else if (op === 'play_session_close') {
        bucket.close = {
          ...(msg.payload as unknown as PlaySessionCloseMessage),
          sequence: msg.sequence,
          timestamp: msg.timestamp,
        };
      } else if (op === 'play_session_aborted') {
        bucket.aborted = {
          ...(msg.payload as unknown as PlaySessionAbortedMessage),
          sequence: msg.sequence,
          timestamp: msg.timestamp,
        };
      }
      continue;
    }

    // ── refund (v2) ────────────────────────────────────────
    if (op === 'refund') {
      stats.v2Messages++;
      const parsed = parseRefund(msg);
      // R10-FG-3 + R11-FG-5 + R12-FG-4 / Phase-9.5 Cluster F:
      // tagged-union dispatch. parseRefund returns either a
      // NormalizedRefundEvent (has `type: 'refund'`) or a
      // ParseRefundFailure (has `reason` only). Discriminate via
      // `type` because NormalizedRefundEvent itself carries a
      // `reason: string` field for the refund's user-facing reason —
      // `'reason' in parsed` is true for BOTH variants and would
      // mis-discriminate.
      //
      // Pre-Phase-9.5 the dispatcher re-derived the categorization
      // from the raw payload AFTER bare-null returns from parseRefund
      // — a refund with both empty `originalDepositTxId` AND empty
      // `refundTxId` would increment ONLY refundsDroppedEmptyOriginal
      // (per-counter arithmetic was wrong), and a future 6th reason
      // added to parseRefund would fall through all four dispatcher
      // branches and re-open the R11-FG-1 over-credit signature. The
      // exhaustive switch turns any future 6th reason into a
      // TypeScript error.
      if (!('type' in parsed)) {
        stats.skippedMessages++;
        switch (parsed.reason) {
          case 'empty-original-deposit-tx-id':
            stats.refundsDroppedEmptyOriginal++;
            break;
          case 'missing-from-or-to':
            stats.refundsDroppedMissingParty++;
            break;
          case 'invalid-amt':
            stats.refundsDroppedInvalidAmt++;
            break;
          case 'missing-refund-tx-id':
            stats.refundsDroppedMissingRefundTx++;
            break;
          default: {
            // Exhaustiveness check. If a new ParseRefundFailureReason
            // is added without a corresponding dispatcher branch,
            // this assertion fails at compile time.
            const _exhaustive: never = parsed.reason;
            void _exhaustive;
          }
        }
        continue;
      }
      const ev = parsed;
      // R4-FG-58 (round-4 medium): skip duplicate refund anchors with
      // the same refundTxId. A retry of `recordRefund` after a partial
      // failure can emit two anchors for one logical refund; without
      // dedup the reader double-credits `rakeReversed` and reconstructed
      // operator balance shows twice the actual reversal.
      const evRakeReversed = (ev as { rakeReversed?: number }).rakeReversed ?? 0;
      if (seenRefundTxIds.has(ev.refundTxId)) {
        // R5-FG-94: sanity-check the duplicate's rakeReversed
        // matches the kept event. A mismatch suggests an operator-
        // key forge or writer regression — emit a warning at the
        // session level via stats.
        const prevRake = seenRefundRakeReversed.get(ev.refundTxId) ?? 0;
        if (prevRake !== evRakeReversed) {
          stats.unknownMessages++; // surfaced as anomaly count
        }
        stats.skippedMessages++;
        continue;
      }
      // R5-FG-23 (P3-004): also dedup by originalDepositTxId.
      // R4-FG-58 closed the same-refundTxId case; this closes the
      // "different refundTxIds for same originalDepositTxId" case
      // (in-flight processRefund + verifier with a fresh refundTxId
      // both emit anchors → double-counted rakeReversed).
      if (
        ev.originalDepositTxId &&
        seenRefundedOriginals.has(ev.originalDepositTxId)
      ) {
        stats.skippedMessages++;
        continue;
      }
      // R5-FG-106: skip the dedup tracker entirely for events
      // older than the 60-day window. Older events are still
      // emitted (they're already on the topic and historically
      // valid), just not tracked for duplicate detection — the
      // refund per-tx claim has a 30-day TTL so a 60-day window
      // is enough to catch any in-window double.
      const evTs = Date.parse(ev.timestamp);
      const trackForDedup =
        Number.isFinite(evTs) && now - evTs <= REFUND_DEDUP_WINDOW_MS;
      if (trackForDedup) {
        seenRefundTxIds.add(ev.refundTxId);
        seenRefundRakeReversed.set(ev.refundTxId, evRakeReversed);
        if (ev.originalDepositTxId) seenRefundedOriginals.add(ev.originalDepositTxId);
      }
      events.push(ev);
      continue;
    }

    // ── prize_recovery (already v2) ────────────────────────
    if (op === 'prize_recovery') {
      stats.v2Messages++;
      const ev = parsePrizeRecovery(msg);
      if (ev) events.push(ev);
      else stats.skippedMessages++;
      continue;
    }

    // ── strategy_change (v2 audit anchor) ──────────────────
    if (op === 'strategy_change') {
      stats.v2Messages++;
      const ev = parseStrategyChange(msg);
      if (ev) events.push(ev);
      else stats.skippedMessages++;
      continue;
    }

    // ── deploy (v1, no shape change) ───────────────────────
    if (op === 'deploy') {
      stats.v1Messages++;
      events.push({
        sequence: msg.sequence,
        timestamp: msg.timestamp,
        type: 'deploy',
        tick: String(msg.payload.tick ?? ''),
        ...(msg.payload.name ? { name: String(msg.payload.name) } : {}),
        ...(msg.payload.max ? { max: String(msg.payload.max) } : {}),
      });
      continue;
    }

    // ── control (v1, no shape change) ──────────────────────
    if (op === 'control') {
      stats.v1Messages++;
      // R4-FG-7: dedup verifier + force-release sibling triage anchors
      // by R3-FG-22's deterministic idempotencyKey. The first anchor
      // emits; the second is silently dropped + counted as skipped so
      // downstream consumers don't double-count reservations.
      const idempotencyKey =
        typeof msg.payload.idempotencyKey === 'string'
          ? msg.payload.idempotencyKey
          : undefined;
      // R5-FG-95 (P3-013): dedup on (idempotencyKey, kind) tuple
      // instead of idempotencyKey alone. Pre-fix two distinct event
      // kinds sharing an idempotencyKey (rare but possible — e.g.
      // a writer regression that reused a key across kinds) would
      // collapse to one. Tuple key keeps cross-kind events separate.
      const eventKind = String(msg.payload.event ?? '');
      const tupleKey = idempotencyKey ? `${eventKind}|${idempotencyKey}` : undefined;
      if (tupleKey && seenControlEventKeys.has(tupleKey)) {
        stats.skippedMessages++;
        continue;
      }
      // Legacy single-key tracker also bumped for back-compat with
      // existing tests that mock the dedup behavior.
      if (idempotencyKey && seenControlIdempotencyKeys.has(idempotencyKey)) {
        stats.skippedMessages++;
        continue;
      }
      if (tupleKey) seenControlEventKeys.add(tupleKey);
      if (idempotencyKey) seenControlIdempotencyKeys.add(idempotencyKey);
      const tokenReservations = Array.isArray(msg.payload.tokenReservations)
        ? (msg.payload.tokenReservations as Array<unknown>)
            .filter(
              (r): r is { token: string; amount: number } =>
                typeof r === 'object' &&
                r !== null &&
                typeof (r as { token: unknown }).token === 'string' &&
                typeof (r as { amount: unknown }).amount === 'number',
            )
        : undefined;
      events.push({
        sequence: msg.sequence,
        timestamp: msg.timestamp,
        type: 'control',
        event: String(msg.payload.event ?? ''),
        ...(msg.payload.reason
          ? { reason: String(msg.payload.reason) }
          : {}),
        by: String(msg.payload.by ?? ''),
        // F20: preserve every field `recordControlEvent` writes so
        // `verify-audit.ts` can surface override / triage events.
        ...(typeof msg.payload.uncertainTxId === 'string'
          ? { uncertainTxId: msg.payload.uncertainTxId }
          : {}),
        ...(typeof msg.payload.kind === 'string'
          ? { kind: msg.payload.kind }
          : {}),
        ...(typeof msg.payload.mirrorResult === 'string'
          ? { mirrorResult: msg.payload.mirrorResult }
          : {}),
        // R6-FG-9 / Phase-6 Cluster C: extract grossAmount/token/cause
        // for the deposit_credit_flush_orphaned event so verify-audit
        // can subtract un-credited deposits during reconstruction.
        ...(typeof msg.payload.grossAmount === 'string'
          ? { grossAmount: msg.payload.grossAmount }
          : {}),
        ...(typeof msg.payload.token === 'string' && eventKind === 'deposit_credit_flush_orphaned'
          ? { token: msg.payload.token }
          : {}),
        ...(typeof msg.payload.cause === 'string'
          ? { cause: msg.payload.cause }
          : {}),
        ...(typeof msg.payload.userId === 'string'
          ? { userId: msg.payload.userId }
          : {}),
        ...(tokenReservations ? { tokenReservations } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      continue;
    }

    // ── v1 balance ops (mint, burn, transfer) ──────────────
    if (op === 'mint') {
      stats.v1Messages++;
      const ev = parseV1Mint(msg);
      if (!ev) {
        stats.skippedMessages++;
        continue;
      }
      // R5-FG-24 (P1-003): dedup v1 mint anchors on memo's
      // `deposit:<txId>` extracted form. /api/admin/replay-deposit
      // operator retry that re-fires recordDeposit emits two mint
      // anchors with identical body — without dedup the reconstructed
      // user balance shows DOUBLE the actual deposit. Legacy mints
      // without `deposit:` memo pass through unfiltered.
      const memo = ev.memo;
      const depositTxId =
        memo && memo.startsWith('deposit:') && memo.length > 'deposit:'.length
          ? memo.slice('deposit:'.length)
          : undefined;
      if (depositTxId) {
        if (seenDepositTxIds.has(depositTxId)) {
          stats.skippedMessages++;
          continue;
        }
        seenDepositTxIds.add(depositTxId);
      }
      events.push(ev);
      continue;
    }
    if (op === 'transfer') {
      stats.v1Messages++;
      const ev = parseV1Transfer(msg);
      if (!ev) {
        stats.skippedMessages++;
        continue;
      }
      // R5-FG-14: dedup rake events on (from, depositTxId). Legacy
      // events with no depositTxId pass through unfiltered.
      if (ev.type === 'rake' && ev.depositTxId) {
        const rakeKey = `${ev.user}|${ev.depositTxId}`;
        if (seenRakeKeys.has(rakeKey)) {
          stats.skippedMessages++;
          continue;
        }
        seenRakeKeys.add(rakeKey);
      }
      events.push(ev);
      continue;
    }
    if (op === 'burn') {
      stats.v1Messages++;
      const ev = parseV1Burn(msg);
      if (ev) events.push(ev);
      else stats.skippedMessages++;
      continue;
    }

    // ── v1 batch (play session) ────────────────────────────
    if (op === 'batch') {
      stats.v1Messages++;
      const sessionId = String(msg.payload.sessionId ?? '');
      if (!sessionId) {
        stats.skippedMessages++;
        continue;
      }
      const burns: { poolId: number; entries: number; spent: number }[] = [];
      const operations =
        (msg.payload.operations as Record<string, unknown>[] | undefined) ?? [];
      let from: string | undefined;
      for (const subOp of operations) {
        if (subOp.op !== 'burn') continue;
        const memo = String(subOp.memo ?? '');
        // Parse "play:pool-N:M-entries" or "play:pool N:M-entries"
        const m = memo.match(/play[:_-]pool[\s:_-]*(\d+)[:_-](\d+)/);
        const poolId = m ? Number(m[1]) : -1;
        const entries = m ? Number(m[2]) : 0;
        burns.push({
          poolId,
          entries,
          spent: Number(subOp.amt) || 0,
        });
        if (typeof subOp.from === 'string') from = subOp.from as string;
      }
      const bucket = sessionBuckets.get(sessionId) ?? { pools: [], sessionAgentSeqs: [] };
      bucket.v1Batch = {
        sequence: msg.sequence,
        timestamp: msg.timestamp,
        burns,
        ...(from ? { from } : {}),
      };
      sessionBuckets.set(sessionId, bucket);
      continue;
    }

    // ── unknown / forward compat ───────────────────────────
    stats.unknownMessages++;
    events.push({
      sequence: msg.sequence,
      timestamp: msg.timestamp,
      type: 'unknown',
      op,
      payload: msg.payload,
    });
  }

  // Phase 2: walk each session bucket through the state machine,
  // and attribute its agentSeqs to the owning agent (resolved from
  // open.agent if available).
  const sessions: NormalizedSession[] = [];
  for (const [sessionId, bucket] of sessionBuckets) {
    const session = await reconstructSession(sessionId, bucket, now);
    sessions.push(session);
    stats.sessionsByStatus[session.status]++;
    events.push({
      sequence: session.firstSeq,
      timestamp: session.openedAt ?? session.closedAt ?? '',
      type: 'session',
      session,
    });

    // Attribute the session's agentSeqs to the agent. If we don't
    // have an open message we don't know which agent the session
    // belonged to — fall back to the literal '__unknown_agent__'
    // bucket so the gaps still surface even for orphaned sessions.
    const agent = bucket.open?.agent ?? '__unknown_agent__';
    if (!seenAgentSeqByAgent.has(agent)) {
      seenAgentSeqByAgent.set(agent, new Map());
    }
    const seqMap = seenAgentSeqByAgent.get(agent)!;
    for (const seq of bucket.sessionAgentSeqs) {
      const sessions = seqMap.get(seq) ?? [];
      sessions.push(session.sessionId);
      seqMap.set(seq, sessions);
    }
  }

  // R5-FG-46 (P12-308): post-process sessions referenced by
  // `prize_recovery` events. Pre-fix the reader emitted both
  // `closed_success_with_prizeTransfer.outcome='failed'` AND a
  // separate `prize_recovery` event; verify-audit's per-user
  // reconstruction skipped `prize_recovery` (`// deploy/prize_recovery
  // /unknown not credited per-user`). An auditor saw a session with
  // `prizeTransfer.status='failed'` and concluded the user never got
  // their prize, even after the recovery script succeeded. Now: when
  // a `prize_recovery` event references `affectedSessions`, flip
  // those sessions' `prizeTransfer.status` from `failed` to
  // `recovered` and surface a `recovered_via_prize_recovery` warning.
  const sessionByIdForRecovery = new Map(sessions.map((s) => [s.sessionId, s]));
  for (const ev of events) {
    if (ev.type !== 'prize_recovery') continue;
    const affected = ev.affectedSessions ?? [];
    for (const sid of affected) {
      const sess = sessionByIdForRecovery.get(sid);
      if (!sess || !sess.prizeTransfer) continue;
      if (sess.prizeTransfer.status === 'failed') {
        sess.prizeTransfer = { ...sess.prizeTransfer, status: 'recovered' };
        sess.warnings.push(
          `recovered_via_prize_recovery: prize transfer initially failed (txId=${sess.prizeTransfer.txId ?? 'unknown'}), recovered by operator via recover-stuck-prizes script`,
        );
      }
    }
  }

  // Phase 3: detect agentSeq gaps + R2-FG-18 duplicates. For each
  // agent, sort the seen values, check for gaps, and flag any seq
  // claimed by >1 session.
  for (const [agent, seqMap] of seenAgentSeqByAgent) {
    if (agent === '__unknown_agent__') continue;
    const seqs = Array.from(seqMap.keys()).sort((a, b) => a - b);
    // Duplicates first (independent of gap detection).
    for (const seq of seqs) {
      const sessions = seqMap.get(seq)!;
      if (sessions.length > 1) {
        stats.agentSeqDuplicates.push({ agent, seq, sessions });
      }
    }
    if (seqs.length < 2) continue;
    for (let i = 1; i < seqs.length; i++) {
      const prev = seqs[i - 1]!;
      const curr = seqs[i]!;
      if (curr > prev + 1) {
        stats.agentSeqGaps.push({ agent, afterSeq: prev });
      }
    }
  }

  // Sort events by sequence so consumers always see consensus order
  events.sort((a, b) => a.sequence - b.sequence);
  sessions.sort((a, b) => a.firstSeq - b.firstSeq);

  // Flush the soft schema-validation report into stats so dashboards
  // and CI can surface writer/schema drift. Soft mode — the existing
  // dispatch already produced normalized events; this is observation
  // only.
  for (const [op, entry] of schemaReport.failures.entries()) {
    stats.schemaValidationFailures.push({
      op,
      count: entry.count,
      ...(entry.firstError ? { firstError: entry.firstError } : {}),
    });
  }

  return { events, sessions, stats };
}

// ── Session state machine ──────────────────────────────────────

async function reconstructSession(
  sessionId: string,
  bucket: {
    open?: PlaySessionOpenMessage & { sequence: number; timestamp: string };
    pools: (PlayPoolResultMessage & { sequence: number; timestamp: string })[];
    close?: PlaySessionCloseMessage & { sequence: number; timestamp: string };
    aborted?: PlaySessionAbortedMessage & { sequence: number; timestamp: string };
    v1Batch?: {
      sequence: number;
      timestamp: string;
      burns: { poolId: number; entries: number; spent: number }[];
      from?: string;
    };
  },
  now: number,
): Promise<NormalizedSession> {
  const warnings: string[] = [];

  // ── v1 fallback path ────────────────────────────────────
  // If we only have a v1 batch (no v2 messages), reconstruct from
  // burn sub-ops. The v2 path won't fire for legacy sessions on
  // pre-migration topics. The session is always treated as
  // closed_success because v1 had no failure-tracking signal.
  if (bucket.v1Batch && !bucket.open && bucket.pools.length === 0) {
    const v1 = bucket.v1Batch;
    const totalSpent = v1.burns.reduce((s, b) => s + b.spent, 0);
    return {
      sessionId,
      user: v1.from ?? '',
      status: 'closed_success',
      pools: v1.burns.map((b, i) => ({
        poolId: b.poolId,
        seq: i + 1,
        entries: b.entries,
        spent: b.spent,
        spentToken: 'HBAR',
        wins: 0,
        prizes: [],
        ts: v1.timestamp,
      })),
      totalSpent,
      totalSpentByToken: { HBAR: totalSpent },
      totalWins: 0,
      totalPrizeValue: 0,
      totalPrizeValueByToken: {},
      totalNftCount: 0,
      warnings: ['v1 legacy session — wins not tracked on chain (this is a pre-migration session)'],
      firstSeq: v1.sequence,
      lastSeq: v1.sequence,
      openedAt: v1.timestamp,
      closedAt: v1.timestamp,
    };
  }

  // ── v2 path ─────────────────────────────────────────────
  // Sort pools by seq just in case the input wasn't strictly ordered.
  bucket.pools.sort((a, b) => a.seq - b.seq);

  // Aggregate the totals we actually saw
  const pools: NormalizedPool[] = bucket.pools.map((p) => ({
    poolId: p.poolId,
    seq: p.seq,
    entries: p.entries,
    spent: Number(p.spent) || 0,
    spentToken: p.spentToken,
    wins: p.wins,
    prizes: p.prizes,
    ts: p.timestamp,
  }));

  let totalSpent = 0;
  const totalSpentByToken: Record<string, number> = {};
  let totalWins = 0;
  let totalPrizeValue = 0;
  const totalPrizeValueByToken: Record<string, number> = {};
  let totalNftCount = 0;
  // R8-FG-16 / Phase-6 Cluster C: surface slim-truncation count.
  // The writer's slimPoolResult helper drops prizes (cap=10 by descending
  // amount) when a pool message exceeds 1024 bytes and stamps
  // `slim_truncated_prizes:N` so a topic-only auditor knows prizes
  // were dropped. Pre-fix the reader never read this field — the
  // session reported `totalPrizeValue` smaller than what actually
  // landed on chain. The R5-FG-110 fix shipped writer-side; this
  // is the reader-side closure.
  let truncatedPrizesDropped = 0;

  for (const pool of bucket.pools) {
    const slim = (pool as unknown as { slim_truncated_prizes?: number }).slim_truncated_prizes;
    if (typeof slim === 'number' && slim > 0) {
      truncatedPrizesDropped += slim;
    }
  }

  for (const pool of pools) {
    totalSpent += pool.spent;
    totalSpentByToken[pool.spentToken] =
      (totalSpentByToken[pool.spentToken] ?? 0) + pool.spent;
    totalWins += pool.wins;
    for (const prize of pool.prizes) {
      if (prize.t === 'ft') {
        totalPrizeValue += prize.amt;
        totalPrizeValueByToken[prize.tk] =
          (totalPrizeValueByToken[prize.tk] ?? 0) + prize.amt;
      } else {
        totalNftCount += prize.ser.length;
      }
    }
  }

  // Determine status
  let status: SessionStatus;
  let openedAt: string | undefined;
  let closedAt: string | undefined;
  let user = '';
  let agent: string | undefined;
  let strategy: string | undefined;
  let boostBps: number | undefined;
  let prizeTransfer: PlaySessionCloseMessage['prizeTransfer'] | undefined;
  // R5-FG-59: extract strategyDeviation from close OR aborted.
  const strategyDeviation =
    bucket.close?.strategyDeviation ?? bucket.aborted?.strategyDeviation;
  let firstSeq = Number.MAX_SAFE_INTEGER;
  let lastSeq = -1;

  if (bucket.open) {
    user = bucket.open.user;
    agent = bucket.open.agent;
    strategy = bucket.open.strategy;
    boostBps = bucket.open.boostBps;
    openedAt = bucket.open.timestamp;
    firstSeq = Math.min(firstSeq, bucket.open.sequence);
    lastSeq = Math.max(lastSeq, bucket.open.sequence);
  }
  for (const p of bucket.pools) {
    if (!user) user = p.user;
    firstSeq = Math.min(firstSeq, p.sequence);
    lastSeq = Math.max(lastSeq, p.sequence);
  }
  if (bucket.close) {
    if (!user) user = bucket.close.user;
    closedAt = bucket.close.timestamp;
    prizeTransfer = bucket.close.prizeTransfer;
    firstSeq = Math.min(firstSeq, bucket.close.sequence);
    lastSeq = Math.max(lastSeq, bucket.close.sequence);
  }
  if (bucket.aborted) {
    if (!user) user = bucket.aborted.user;
    closedAt = bucket.aborted.abortedAt;
    firstSeq = Math.min(firstSeq, bucket.aborted.sequence);
    lastSeq = Math.max(lastSeq, bucket.aborted.sequence);
  }
  if (firstSeq === Number.MAX_SAFE_INTEGER) firstSeq = 0;

  // ── State machine ───────────────────────────────────────
  if (!bucket.open) {
    // Pools without open. Could be (a) we missed the open due to
    // mirror node lag, (b) it never happened (orphan fragment),
    // (c) the open was emitted on a previous topic before migration.
    status = 'orphaned';
    warnings.push('Pool messages observed without a matching play_session_open');
  } else if (bucket.close) {
    // Validate the close: pools count + Merkle root
    if (bucket.pools.length !== bucket.close.poolsPlayed) {
      warnings.push(
        `Pool count mismatch: open expected ${bucket.open.expectedPools}, ` +
          `close claims ${bucket.close.poolsPlayed}, observed ${bucket.pools.length}`,
      );
      status = 'corrupt';
    } else {
      // R4-FG-23 (round-4 high): try the binding-aware Merkle first
      // (writer post-fix always passes binding). Fall back to the
      // legacy unbound form for sessions emitted before the binding
      // landed, with a warning so operators can see which historical
      // sessions lack cross-session-replay protection. Binding requires
      // `agent` from the open message — without an open we can only
      // try the legacy form.
      const poolsForHash = bucket.pools.map((p) => ({
        poolId: p.poolId,
        spent: p.spent,
        spentToken: p.spentToken,
        wins: p.wins,
        prizes: p.prizes,
      }));
      let observedRoot: string;
      let usedLegacy = false;
      // R5-FG-2 (P1-004): refuse the legacy unbound fallback for any
      // close message emitted AFTER LEGACY_MERKLE_CUTOFF_TIMESTAMP.
      // Pre-fix an attacker with operator-key access could forge a
      // close with a legacy unbound root for any historical poolset
      // — bound check fails, legacy passes, status='closed_success'
      // with only a buried warning. R4-FG-23's protection was opt-out
      // for the attacker forever.
      const closePostCutoff = isPostLegacyCutoff(bucket.close.timestamp);
      // R5-FG-50 (P4-010): if `agent` is missing on the open (malformed
      // open or attacker-written messages omitting it), refuse to
      // validate — treat as `corrupt`. Pre-fix the reader fell through
      // to the legacy unbound fallback (`else { usedLegacy=true }`),
      // which made R4-FG-23's protection unavailable for ANY session
      // whose open omitted `agent`. The whole point of binding is the
      // operator key proves who emitted the session — without `agent`
      // there is no binding to validate.
      if (!agent) {
        warnings.push(
          'cannot_verify_root_binding_open_missing: close present but session-open lacks `agent`; binding cannot be validated',
        );
        observedRoot = '';
        // mirror_lag_grace_window left as a future ergonomic — for now,
        // operators with real lag can replay against a fully-mirrored
        // topic snapshot.
      } else {
        observedRoot = await computePoolsRoot(poolsForHash, {
          sessionId,
          user,
          agent,
        });
        if (observedRoot !== bucket.close.poolsRoot && !closePostCutoff) {
          // Try legacy unbound form for back-compat with pre-R4-FG-23
          // close messages (only if this session predates the cutover).
          const legacyRoot = await computePoolsRoot(poolsForHash);
          if (legacyRoot === bucket.close.poolsRoot) {
            observedRoot = legacyRoot;
            usedLegacy = true;
          }
        }
      }
      if (observedRoot !== bucket.close.poolsRoot) {
        warnings.push(
          `poolsRoot mismatch: close claims ${bucket.close.poolsRoot}, observed ${observedRoot || '(refused legacy fallback post-cutoff)'}`,
        );
        status = 'corrupt';
      } else {
        if (usedLegacy) {
          warnings.push(
            'legacy_merkle_binding: close validated against pre-R4-FG-23 unbound Merkle (cross-session replay protection unavailable for this session)',
          );
        }
        status = 'closed_success';
      }
    }
  } else if (bucket.aborted) {
    if (bucket.aborted.completedPools !== bucket.pools.length) {
      // R3-FG-36 (round-3 P5-SR-002): promote aborted-with-mismatch to
      // `corrupt`. Pre-fix only emitted a warning while leaving status
      // = `closed_aborted` — a topic-only auditor saw a clean abort
      // even though the pool count contradicted the abort message.
      // The closed_success branch already promotes count/merkle
      // mismatch to `corrupt`; aborted now matches.
      status = 'corrupt';
      warnings.push(
        `Aborted session pool count mismatch: aborted claims ${bucket.aborted.completedPools}, observed ${bucket.pools.length}`,
      );
    } else if (bucket.aborted.poolsRoot && agent) {
      // R4-FG-24 (round-4 high): when the abort message carries a
      // Merkle root (post-fix writers always do), validate it against
      // the observed pool messages. Pre-fix a compromised operator
      // could write an aborted claiming completedPools=0 for a session
      // whose pool messages already landed; the count-only check above
      // catches that exact case but only when pool messages observed
      // != claimed (which a sufficiently determined operator could
      // arrange). The Merkle bind ties the abort to specific pool
      // content + (sessionId, user, agent), so a forged abort cannot
      // pass against legitimate pool messages without operator-key
      // forgery of those too. Try-both back-compat with closed_success.
      const poolsForHash = bucket.pools.map((p) => ({
        poolId: p.poolId,
        spent: p.spent,
        spentToken: p.spentToken,
        wins: p.wins,
        prizes: p.prizes,
      }));
      const observedRoot = await computePoolsRoot(poolsForHash, {
        sessionId,
        user,
        agent,
      });
      const abortPostCutoff = isPostLegacyCutoff(bucket.aborted.timestamp);
      if (observedRoot !== bucket.aborted.poolsRoot) {
        // Last-ditch legacy fallback (extremely unlikely on aborted
        // since the field is brand new, but matches the close path).
        // R5-FG-2: refuse legacy fallback for post-cutoff aborts.
        if (abortPostCutoff) {
          warnings.push(
            `Aborted poolsRoot mismatch: aborted claims ${bucket.aborted.poolsRoot}, observed ${observedRoot} (refused legacy fallback post-cutoff)`,
          );
          status = 'corrupt';
        } else {
          const legacyRoot = await computePoolsRoot(poolsForHash);
          if (legacyRoot === bucket.aborted.poolsRoot) {
            warnings.push(
              'legacy_merkle_binding: aborted validated against pre-R4-FG-23 unbound Merkle',
            );
            status = 'closed_aborted';
          } else {
            warnings.push(
              `Aborted poolsRoot mismatch: aborted claims ${bucket.aborted.poolsRoot}, observed ${observedRoot}`,
            );
            status = 'corrupt';
          }
        }
      } else {
        status = 'closed_aborted';
      }
    } else {
      // Legacy abort (pre-R4-FG-24) has no poolsRoot. Surface that the
      // session lacks Merkle tamper-evidence so operators can see it.
      // R5-FG-2: post-cutoff aborts MUST carry a poolsRoot — refusing
      // closes the "drop the poolsRoot field to bypass binding" attack.
      if (!bucket.aborted.poolsRoot) {
        if (isPostLegacyCutoff(bucket.aborted.timestamp)) {
          warnings.push(
            'legacy_abort_no_merkle: post-cutoff aborted lacks poolsRoot — refusing as corrupt',
          );
          status = 'corrupt';
        } else {
          warnings.push(
            'legacy_abort_no_merkle: aborted message predates R4-FG-24 (no Merkle tamper-evidence; count-only check)',
          );
          status = 'closed_aborted';
        }
      } else {
        status = 'closed_aborted';
      }
    }
  } else {
    // Open seen, no terminal — in_flight or orphaned by timeout
    const openedTime = bucket.open.timestamp
      ? new Date(bucket.open.timestamp).getTime()
      : 0;
    if (openedTime > 0 && now - openedTime > SESSION_INFLIGHT_TIMEOUT_MS) {
      status = 'orphaned';
      warnings.push(
        `Session opened more than ${SESSION_INFLIGHT_TIMEOUT_MS / 1000}s ago with no terminal marker`,
      );
    } else {
      status = 'in_flight';
    }
  }

  // R8-FG-16: surface slim-truncation as a session warning so
  // verify-audit can promote it. Pool prizes were dropped to fit
  // the 1024-byte HCS topic cap; the on-chain prize transfer
  // happened with the FULL prize set, so the topic's
  // `totalPrizeValue` here under-reports actual on-chain value.
  // External auditors must reconcile against on-chain wallet
  // state, not the topic alone, when this warning is present.
  if (truncatedPrizesDropped > 0) {
    warnings.push(
      `slim_truncated_prizes: ${truncatedPrizesDropped} prize(s) dropped for size; topic totalPrizeValue under-reports on-chain truth`,
    );
  }

  return {
    sessionId,
    user,
    ...(agent ? { agent } : {}),
    status,
    ...(strategy ? { strategy } : {}),
    ...(boostBps != null ? { boostBps } : {}),
    ...(openedAt ? { openedAt } : {}),
    ...(closedAt ? { closedAt } : {}),
    pools,
    totalSpent,
    totalSpentByToken,
    totalWins,
    totalPrizeValue,
    totalPrizeValueByToken,
    totalNftCount,
    ...(prizeTransfer ? { prizeTransfer } : {}),
    warnings,
    firstSeq,
    lastSeq,
    // R5-FG-58: expose the session-open's sequence so verify-audit
    // can compare strategy_changes against the user's PLAY-INITIATION
    // time, not against `firstSeq` (which is the minimum sequence
    // across the entire bucket and could be a pool message in
    // out-of-order edge cases).
    ...(bucket.open?.sequence != null ? { openSeq: bucket.open.sequence } : {}),
    // R5-FG-59: surface strategyDeviation from the writer.
    ...(strategyDeviation ? { strategyDeviation } : {}),
    // R8-FG-16: surface count of slim-truncated prizes.
    ...(truncatedPrizesDropped > 0 ? { truncatedPrizesDropped } : {}),
  };
}

// ── v1 message parsers ─────────────────────────────────────────
//
// All v1 ops now use resolveTokenField() which prefers the explicit
// `token` field if the writer stamped one, and falls back to the
// LLCRED→HBAR heuristic for legacy messages on existing topics.
// New messages from the current writer always carry `token` so the
// reader doesn't have to guess. See docs/hcs20-v2-schema.md for the
// rationale and the audit-deposit-discrepancy script for the bug
// this prevents.

/**
 * Resolve the underlying token for a v1 mint/transfer/burn/refund.
 *
 * Priority:
 *   1. `payload.token` — set by the current writer, unambiguous
 *   2. `payload.tick` mapped via the legacy heuristic — only for
 *      pre-fix messages on existing topics. The historical convention
 *      was that all amounts were HBAR-denominated and `tick: LLCRED`
 *      was just the credit ledger label.
 *
 * Returns "HBAR" as the safest default when neither field tells us
 * anything useful.
 */
function resolveTokenField(payload: Record<string, unknown>): string {
  const explicit = payload.token;
  if (typeof explicit === 'string' && explicit.length > 0) {
    return explicit;
  }
  const tick = payload.tick;
  if (typeof tick === 'string' && tick.length > 0 && tick !== 'LLCRED' && tick !== 'llcred') {
    return tick;
  }
  // Legacy LLCRED → HBAR fallback. Mirrors src/scripts/verify-audit.ts
  // normalizeLegacyToken() so both readers agree.
  return 'HBAR';
}

function parseV1Mint(msg: RawTopicMessage): NormalizedDepositEvent | null {
  const to = String(msg.payload.to ?? '');
  const amt = Number(msg.payload.amt);
  if (!to || !Number.isFinite(amt)) return null;
  return {
    sequence: msg.sequence,
    timestamp: msg.timestamp,
    type: 'deposit',
    user: to,
    amount: amt,
    token: resolveTokenField(msg.payload),
    ...(msg.payload.memo ? { memo: String(msg.payload.memo) } : {}),
  };
}

function parseV1Transfer(
  msg: RawTopicMessage,
): NormalizedRakeEvent | NormalizedOperatorWithdrawalEvent | null {
  const memo = String(msg.payload.memo ?? '');
  const from = String(msg.payload.from ?? '');
  const to = String(msg.payload.to ?? '');
  const amt = Number(msg.payload.amt);
  if (!Number.isFinite(amt)) return null;

  // R5-FG-14: extract `depositTxId` from either the body field
  // (post-R5 emissions) or from `memo:'rake:<txId>'` (also post-R5,
  // for legacy clients that ignore extra body fields). Legacy v1
  // emissions have plain `memo:'rake'` and no depositTxId — keep
  // parsing but the pairing check at verify-audit exempts them.
  const bodyDepositTxId =
    typeof msg.payload.depositTxId === 'string' && msg.payload.depositTxId.length > 0
      ? (msg.payload.depositTxId as string)
      : undefined;
  const memoDepositTxId =
    memo.startsWith('rake:') && memo.length > 5 ? memo.slice(5) : undefined;
  const depositTxId = bodyDepositTxId ?? memoDepositTxId;

  if (memo === 'rake' || memo.startsWith('rake')) {
    return {
      sequence: msg.sequence,
      timestamp: msg.timestamp,
      type: 'rake',
      user: from,
      agent: to,
      amount: amt,
      token: resolveTokenField(msg.payload),
      ...(depositTxId ? { depositTxId } : {}),
    };
  }

  // Default: rake-ish transfer (current convention)
  return {
    sequence: msg.sequence,
    timestamp: msg.timestamp,
    type: 'rake',
    user: from,
    agent: to,
    amount: amt,
    token: resolveTokenField(msg.payload),
    ...(depositTxId ? { depositTxId } : {}),
  };
}

function parseV1Burn(
  msg: RawTopicMessage,
): NormalizedWithdrawalEvent | NormalizedOperatorWithdrawalEvent | null {
  const memo = String(msg.payload.memo ?? '').toLowerCase();
  const from = String(msg.payload.from ?? '');
  const amt = Number(msg.payload.amt);
  if (!Number.isFinite(amt)) return null;

  // F18: preserve the body-level idempotency key when present.
  const rawTxId = msg.payload.withdrawTxId;
  const withdrawTxId =
    typeof rawTxId === 'string' && rawTxId.length > 0 ? rawTxId : undefined;

  if (memo.startsWith('operator_withdrawal') || memo.startsWith('operator-withdrawal')) {
    return {
      sequence: msg.sequence,
      timestamp: msg.timestamp,
      type: 'operator_withdrawal',
      agent: from,
      amount: amt,
      token: resolveTokenField(msg.payload),
      ...(withdrawTxId ? { withdrawTxId } : {}),
    };
  }

  if (memo.startsWith('withdraw') || memo.includes('withdrawal')) {
    return {
      sequence: msg.sequence,
      timestamp: msg.timestamp,
      type: 'withdrawal',
      user: from,
      amount: amt,
      token: resolveTokenField(msg.payload),
      ...(withdrawTxId ? { withdrawTxId } : {}),
    };
  }

  // Unrecognized burn — treat as withdrawal by default
  return {
    sequence: msg.sequence,
    timestamp: msg.timestamp,
    type: 'withdrawal',
    user: from,
    amount: amt,
    token: resolveTokenField(msg.payload),
    ...(withdrawTxId ? { withdrawTxId } : {}),
  };
}

/**
 * R12-FG-4 / Phase-9.5 Cluster F: parseRefund returns a discriminated
 * tagged-union failure type so the dispatcher receives the
 * categorization at the type level. Pre-Phase-9.5 the dispatcher
 * re-derived the categorization from the raw payload AFTER parseRefund
 * returned bare null — meaning a future 6th null-return reason added
 * to parseRefund would silently fall through all four dispatcher
 * branches and re-open the R11-FG-1 over-credit signature. The
 * tagged-union shape makes that future regression a TypeScript error
 * instead of a silent skip. Also: a refund with multiple missing
 * fields no longer randomly attributes to whichever-field-was-checked-first
 * — parseRefund returns the FIRST encountered reason and the dispatcher
 * increments exactly one counter, deterministically.
 */
type ParseRefundFailureReason =
  | 'empty-original-deposit-tx-id'
  | 'missing-from-or-to'
  | 'invalid-amt'
  | 'missing-refund-tx-id';

interface ParseRefundFailure {
  reason: ParseRefundFailureReason;
}

function parseRefund(
  msg: RawTopicMessage,
): NormalizedRefundEvent | ParseRefundFailure {
  const from = String(msg.payload.from ?? '');
  const to = String(msg.payload.to ?? '');
  const amt = Number(msg.payload.amt);
  const originalDepositTxId = String(msg.payload.originalDepositTxId ?? '');
  const refundTxId = String(msg.payload.refundTxId ?? '');
  // R9-FG-11 / Phase-7 Cluster F: reader-side empty-string defense
  // for originalDepositTxId. Closes R8-FG-8 PARTIAL — legacy/
  // attacker-injected topic messages with empty originalDepositTxId
  // bypassed the dedup gate before. R12-FG-4 / Phase-9.5: each
  // null-return reason is now tagged so the dispatcher categorizes
  // by type rather than re-parsing the payload.
  if (!originalDepositTxId) return { reason: 'empty-original-deposit-tx-id' };
  if (!from || !to) return { reason: 'missing-from-or-to' };
  if (!Number.isFinite(amt)) return { reason: 'invalid-amt' };
  if (!refundTxId) return { reason: 'missing-refund-tx-id' };
  // R6-FG-7: extract rake reversal so verify-audit reducers can
  // apply operator-balance corrections. Pre-fix this was silently
  // dropped, leaving operator-balance reconstruction short.
  const rakeReversedRaw = msg.payload.rakeReversed;
  const rakeReversed =
    typeof rakeReversedRaw === 'number'
      ? rakeReversedRaw
      : typeof rakeReversedRaw === 'string' && rakeReversedRaw.length > 0
        ? Number(rakeReversedRaw)
        : undefined;
  const rakeReversedToken =
    typeof msg.payload.rakeReversedToken === 'string'
      ? (msg.payload.rakeReversedToken as string)
      : undefined;
  return {
    sequence: msg.sequence,
    timestamp: msg.timestamp,
    type: 'refund',
    agent: from,
    user: to,
    amount: amt,
    // R6-FG-8: prefer the explicit `token` field; fall back to the
    // legacy tick→HBAR resolution for pre-fix refund messages.
    token: resolveTokenField(msg.payload),
    originalDepositTxId,
    refundTxId,
    reason: String(msg.payload.reason ?? ''),
    performedBy: String(msg.payload.performedBy ?? ''),
    ...(rakeReversed !== undefined && Number.isFinite(rakeReversed)
      ? { rakeReversed }
      : {}),
    ...(rakeReversedToken ? { rakeReversedToken } : {}),
  };
}

function parseStrategyChange(
  msg: RawTopicMessage,
): NormalizedStrategyChangeEvent | null {
  const user = String(msg.payload.user ?? '');
  const newStrategy = String(msg.payload.newStrategy ?? '');
  if (!user || !newStrategy) return null;
  return {
    sequence: msg.sequence,
    timestamp: msg.timestamp,
    type: 'strategy_change',
    user,
    previousStrategy: String(msg.payload.previousStrategy ?? 'unknown'),
    newStrategy,
    newStrategyVersion: String(msg.payload.newStrategyVersion ?? ''),
    performedBy: String(msg.payload.performedBy ?? 'user'),
  };
}

function parsePrizeRecovery(
  msg: RawTopicMessage,
): NormalizedPrizeRecoveryEvent | null {
  const user = String(msg.payload.user ?? '');
  const agent = String(msg.payload.agent ?? '');
  if (!user || !agent) return null;
  return {
    sequence: msg.sequence,
    timestamp: msg.timestamp,
    type: 'prize_recovery',
    user,
    agent,
    prizesTransferred: Number(msg.payload.prizesTransferred ?? 0),
    contractTxId: String(msg.payload.contractTxId ?? ''),
    reason: String(msg.payload.reason ?? ''),
    performedBy: String(msg.payload.performedBy ?? ''),
    ...(msg.payload.prizesByToken
      ? { prizesByToken: msg.payload.prizesByToken as Record<string, number> }
      : {}),
    ...(msg.payload.attempts !== undefined
      ? { attempts: Number(msg.payload.attempts) }
      : {}),
    ...(msg.payload.gasUsed !== undefined
      ? { gasUsed: Number(msg.payload.gasUsed) }
      : {}),
    ...(Array.isArray(msg.payload.affectedSessions)
      ? { affectedSessions: msg.payload.affectedSessions as string[] }
      : {}),
  };
}
