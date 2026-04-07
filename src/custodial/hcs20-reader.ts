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
}

export interface NormalizedWithdrawalEvent extends BaseEvent {
  type: 'withdrawal';
  user: string;
  amount: number;
  token: string;
}

export interface NormalizedOperatorWithdrawalEvent extends BaseEvent {
  type: 'operator_withdrawal';
  agent: string;
  amount: number;
  token: string;
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

export interface NormalizedControlEvent extends BaseEvent {
  type: 'control';
  event: string;
  reason?: string;
  by: string;
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
  };
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
  const seenAgentSeqByAgent = new Map<string, Set<number>>();
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
  };

  for (const msg of messages) {
    const op = String(msg.payload.op ?? 'unknown');

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
      const ev = parseRefund(msg);
      if (ev) events.push(ev);
      else stats.skippedMessages++;
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
      events.push({
        sequence: msg.sequence,
        timestamp: msg.timestamp,
        type: 'control',
        event: String(msg.payload.event ?? ''),
        ...(msg.payload.reason
          ? { reason: String(msg.payload.reason) }
          : {}),
        by: String(msg.payload.by ?? ''),
      });
      continue;
    }

    // ── v1 balance ops (mint, burn, transfer) ──────────────
    if (op === 'mint') {
      stats.v1Messages++;
      const ev = parseV1Mint(msg);
      if (ev) events.push(ev);
      else stats.skippedMessages++;
      continue;
    }
    if (op === 'transfer') {
      stats.v1Messages++;
      const ev = parseV1Transfer(msg);
      if (ev) events.push(ev);
      else stats.skippedMessages++;
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
      seenAgentSeqByAgent.set(agent, new Set());
    }
    const set = seenAgentSeqByAgent.get(agent)!;
    for (const seq of bucket.sessionAgentSeqs) {
      set.add(seq);
    }
  }

  // Phase 3: detect agentSeq gaps. For each agent, sort the seen
  // values and check for gaps. Each gap is reported as the seq
  // value that was followed by a missing successor.
  for (const [agent, seqSet] of seenAgentSeqByAgent) {
    if (agent === '__unknown_agent__') continue;
    const seqs = Array.from(seqSet).sort((a, b) => a - b);
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
      // Recompute root from observed pools and compare
      const observedRoot = await computePoolsRoot(
        bucket.pools.map((p) => ({
          poolId: p.poolId,
          spent: p.spent,
          spentToken: p.spentToken,
          wins: p.wins,
          prizes: p.prizes,
        })),
      );
      if (observedRoot !== bucket.close.poolsRoot) {
        warnings.push(
          `poolsRoot mismatch: close claims ${bucket.close.poolsRoot}, observed ${observedRoot}`,
        );
        status = 'corrupt';
      } else {
        status = 'closed_success';
      }
    }
  } else if (bucket.aborted) {
    status = 'closed_aborted';
    if (bucket.aborted.completedPools !== bucket.pools.length) {
      warnings.push(
        `Aborted session pool count mismatch: aborted claims ${bucket.aborted.completedPools}, observed ${bucket.pools.length}`,
      );
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
  };
}

// ── v1 message parsers ─────────────────────────────────────────

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
    token: String(msg.payload.tick ?? 'LLCRED'),
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

  if (memo === 'rake' || memo.startsWith('rake')) {
    return {
      sequence: msg.sequence,
      timestamp: msg.timestamp,
      type: 'rake',
      user: from,
      agent: to,
      amount: amt,
      token: String(msg.payload.tick ?? 'LLCRED'),
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
    token: String(msg.payload.tick ?? 'LLCRED'),
  };
}

function parseV1Burn(
  msg: RawTopicMessage,
): NormalizedWithdrawalEvent | NormalizedOperatorWithdrawalEvent | null {
  const memo = String(msg.payload.memo ?? '').toLowerCase();
  const from = String(msg.payload.from ?? '');
  const amt = Number(msg.payload.amt);
  if (!Number.isFinite(amt)) return null;

  if (memo.startsWith('operator_withdrawal') || memo.startsWith('operator-withdrawal')) {
    return {
      sequence: msg.sequence,
      timestamp: msg.timestamp,
      type: 'operator_withdrawal',
      agent: from,
      amount: amt,
      token: String(msg.payload.tick ?? 'LLCRED'),
    };
  }

  if (memo.startsWith('withdraw') || memo.includes('withdrawal')) {
    return {
      sequence: msg.sequence,
      timestamp: msg.timestamp,
      type: 'withdrawal',
      user: from,
      amount: amt,
      token: String(msg.payload.tick ?? 'LLCRED'),
    };
  }

  // Unrecognized burn — treat as withdrawal by default
  return {
    sequence: msg.sequence,
    timestamp: msg.timestamp,
    type: 'withdrawal',
    user: from,
    amount: amt,
    token: String(msg.payload.tick ?? 'LLCRED'),
  };
}

function parseRefund(msg: RawTopicMessage): NormalizedRefundEvent | null {
  const from = String(msg.payload.from ?? '');
  const to = String(msg.payload.to ?? '');
  const amt = Number(msg.payload.amt);
  const originalDepositTxId = String(msg.payload.originalDepositTxId ?? '');
  const refundTxId = String(msg.payload.refundTxId ?? '');
  if (!from || !to || !Number.isFinite(amt) || !refundTxId) return null;
  return {
    sequence: msg.sequence,
    timestamp: msg.timestamp,
    type: 'refund',
    agent: from,
    user: to,
    amount: amt,
    token: String(msg.payload.tick ?? 'LLCRED'),
    originalDepositTxId,
    refundTxId,
    reason: String(msg.payload.reason ?? ''),
    performedBy: String(msg.payload.performedBy ?? ''),
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
