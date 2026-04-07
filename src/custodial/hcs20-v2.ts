/**
 * HCS-20 schema v2 — type definitions and shared helpers.
 *
 * v1 wrote ONE batch message per play session containing only burn
 * sub-ops (the cost side). The wins side was invisible on chain and
 * the dashboard joined with a local PlaySessionResult store to fill
 * the gap. v2 makes the audit trail self-sufficient: every play
 * session writes a structured sequence of messages so an independent
 * third party can reconstruct the full history from the topic alone.
 *
 * Design constraints:
 *   - Hedera HCS topic message hard limit: 1024 bytes
 *   - Each message is its own transaction; no atomic batch
 *   - HCS gives total ordering within a topic
 *   - Submit key is operator-only (only the agent can write)
 *   - v1 messages are immutable on chain — readers handle both shapes
 *
 * The shape choices below were locked in after architect + data-engineer
 * + product reviews. Notable decisions:
 *
 *   - Per-pool granularity (not chunked single message). Pros: simple
 *     reader, predictable size, no SDK chunk reassembly.
 *   - `v:2` lives on session lifecycle messages (open + recovery), not
 *     on every pool message. Op names disambiguate the rest.
 *   - `tick` is dropped from non-balance ops because it's HCS-20 spec
 *     baggage that says nothing the topic ID doesn't already.
 *   - `poolsRoot` (sha256 Merkle of pool tuples) replaces a totals
 *     dict on `_close`. Tamper evidence; reader recomputes and
 *     rejects on mismatch.
 *   - `agentSeq` is a monotonic per-agent counter recovered at
 *     startup via one mirror node scan. Lets readers detect dropped
 *     messages.
 *   - `prizeTransfer` on `_close` is a first-class field — the field
 *     that would have made the 668 HBAR stuck-prize incident
 *     self-explanatory if it had existed.
 */

// ── Op name constants ────────────────────────────────────────

export const HCS20_V2_OPS = {
  PLAY_SESSION_OPEN: 'play_session_open',
  PLAY_POOL_RESULT: 'play_pool_result',
  PLAY_SESSION_CLOSE: 'play_session_close',
  PLAY_SESSION_ABORTED: 'play_session_aborted',
  REFUND: 'refund',
  PRIZE_RECOVERY: 'prize_recovery',
} as const;

export type Hcs20V2OpName = (typeof HCS20_V2_OPS)[keyof typeof HCS20_V2_OPS];

// ── Wire shapes (what we write to the topic) ────────────────
//
// All v2 wire shapes use short field names where reasonable to keep
// per-message size under the 1024-byte topic limit. Long names like
// "transactionId" are only used where they're already part of the
// HCS-20 spec or where clarity beats byte savings (Hedera tx IDs
// dominate the size budget anyway).

/**
 * play_session_open — written FIRST in the play sequence. Carries the
 * v field as a session-level fence so future v3 readers can detect
 * unsupported sessions without parsing every pool message.
 *
 * `expectedPools` is a hint, not a guarantee. The agent may emit
 * fewer if budget runs out mid-session. The reader uses it as a
 * sanity check, not a hard constraint.
 */
export interface PlaySessionOpenMessage {
  p: 'hcs-20';
  op: 'play_session_open';
  v: 2;
  sessionId: string;
  user: string;
  agent: string;
  agentSeq: number;
  strategy: string;
  boostBps: number;
  expectedPools: number;
  ts: string;
}

/**
 * play_pool_result — one per pool actually played. The `seq` field
 * is the pool's position within this session (1-indexed). The total
 * count is `expectedPools` from the open message — no separate `of`
 * field, that would be redundant.
 *
 * Prizes are nested as a discriminated array. `t:'ft'` for fungible
 * (token + amt), `t:'nft'` for NFTs (token + symbol + serials array).
 * Symbol is included for NFTs because the dApp needs it for display
 * and recomputing it from the token ID requires a mirror node call.
 *
 * `strategyMeta` is optional and carries the agent's decision input
 * for this pool (EV, budget remaining at time of decision, etc.).
 * This is the "evidence" field that lets external auditors verify
 * not just *what* happened but *why* the agent thought it was a
 * good play. Convert the audit trail from a ledger into evidence.
 */
export interface PlayPoolResultMessage {
  p: 'hcs-20';
  op: 'play_pool_result';
  sessionId: string;
  user: string;
  agentSeq: number;
  poolId: number;
  seq: number;
  entries: number;
  spent: string;
  spentToken: string;
  wins: number;
  prizes: PrizeEntry[];
  strategyMeta?: {
    ev?: number;
    budgetRemaining?: number;
    [key: string]: unknown;
  };
  ts: string;
}

export type PrizeEntry =
  | { t: 'ft'; tk: string; amt: number }
  | { t: 'nft'; tk: string; sym: string; ser: number[] };

/**
 * play_session_close — written LAST in the play sequence on success.
 * Carries the operator's signed claim about the session totals plus
 * the prize-transfer outcome.
 *
 * `poolsRoot` is sha256 of canonically-sorted pool tuples (see
 * computePoolsRoot() below). The reader recomputes the root from
 * the pool messages it actually saw and rejects the close if they
 * disagree — that's the tamper-evidence layer.
 *
 * `prizeTransfer` is the field that would have made the 668 HBAR
 * stuck-prize incident self-explanatory. Operators (and end users)
 * can see exactly where the prize delivery sat: succeeded, pending,
 * failed, recovered.
 */
export interface PlaySessionCloseMessage {
  p: 'hcs-20';
  op: 'play_session_close';
  sessionId: string;
  user: string;
  agentSeq: number;
  poolsPlayed: number;
  poolsRoot: string;
  totalWins: number;
  prizeTransfer: {
    status: 'succeeded' | 'skipped' | 'failed' | 'recovered';
    txId?: string;
    attempts?: number;
    gasUsed?: number;
    lastError?: string;
  };
  ts: string;
}

/**
 * play_session_aborted — written instead of close when the session
 * sequence dies mid-stream (agent crash, contract revert, etc.).
 * The reader uses it as a positive close marker — "this session is
 * over, here's how many pools made it through" — instead of having
 * to detect missing closes via timeout (which can't distinguish
 * crashed from in-flight).
 */
export interface PlaySessionAbortedMessage {
  p: 'hcs-20';
  op: 'play_session_aborted';
  sessionId: string;
  user: string;
  agentSeq: number;
  completedPools: number;
  reason: string;
  /** Truncated error message (max ~200 chars to stay within size budget). */
  lastError?: string;
  abortedAt: string;
}

/**
 * refund — new op type for operator-initiated refunds. Today
 * processRefund mutates the local ledger and writes nothing to
 * HCS-20, which means external auditors see deposit + nothing,
 * making reconciliation impossible. Adding this closes the gap.
 *
 * `tick` IS included because refunds are credit-affecting (the
 * inverse of a deposit). Reconcilers treat it as a burn from the
 * user's LLCRED side.
 */
export interface RefundMessage {
  p: 'hcs-20';
  op: 'refund';
  tick: string;
  amt: string;
  from: string;
  to: string;
  originalDepositTxId: string;
  refundTxId: string;
  reason: 'stuck_deposit' | 'operator_initiated' | 'admin' | string;
  performedBy: string;
  ts: string;
}

// ── Discriminated union of all v2 messages ──────────────────

export type Hcs20V2Message =
  | PlaySessionOpenMessage
  | PlayPoolResultMessage
  | PlaySessionCloseMessage
  | PlaySessionAbortedMessage
  | RefundMessage;

// ── Normalized session reconstruction (reader output) ───────
//
// What the audit reader emits after grouping messages by sessionId
// and walking the state machine. This is the "anti-corruption layer"
// type — both v1 and v2 parsers normalize to this same shape so the
// audit page never has to branch on schema version.

export type SessionStatus =
  | 'closed_success'      // open + N pools + close, root verified, agentSeq contiguous
  | 'closed_aborted'      // open + N pools + aborted
  | 'in_flight'           // open seen, no terminal yet, within timeout
  | 'orphaned'            // pools without open, OR open with no terminal past timeout
  | 'corrupt';            // poolsRoot mismatch, agentSeq gap, or other invariant violation

export interface NormalizedSession {
  sessionId: string;
  user: string;
  agent?: string;
  status: SessionStatus;
  /** Strategy from the open message, if seen. */
  strategy?: string;
  boostBps?: number;
  /** When the session opened, if known. */
  openedAt?: string;
  /** When the session terminated (closed or aborted), if known. */
  closedAt?: string;
  /** Pool messages observed for this session, in seq order. */
  pools: NormalizedPool[];
  /** Total spent across pool messages we actually saw. */
  totalSpent: number;
  totalSpentByToken: Record<string, number>;
  /** Total wins observed (count). */
  totalWins: number;
  /** Total prize value observed, fungible only. NFT counts tracked separately. */
  totalPrizeValue: number;
  totalPrizeValueByToken: Record<string, number>;
  totalNftCount: number;
  /** Prize transfer outcome from the close message, if present. */
  prizeTransfer?: PlaySessionCloseMessage['prizeTransfer'];
  /**
   * Free-form warnings the reader emitted while reconstructing this
   * session. Used by the audit page to surface "this session has
   * a poolsRoot mismatch" or "we're missing pool 3 of 5".
   */
  warnings: string[];
  /** First and last sequence numbers observed for this session. */
  firstSeq: number;
  lastSeq: number;
}

export interface NormalizedPool {
  poolId: number;
  seq: number;
  entries: number;
  spent: number;
  spentToken: string;
  wins: number;
  prizes: PrizeEntry[];
  ts: string;
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Compute the canonical poolsRoot for a session: sha256 of the
 * sorted-by-poolId tuple list. Used by both writer (when emitting
 * the close message) and reader (when validating it).
 *
 * Canonical form: each pool serialized as `${poolId}|${spent}|${spentToken}|${wins}|${prizesHash}`,
 * where prizesHash is sha256 of the canonical-JSON-serialized prizes
 * array. Joined by newline. This is deterministic across both sides
 * of the wire.
 */
export async function computePoolsRoot(
  pools: { poolId: number; spent: string | number; spentToken: string; wins: number; prizes: PrizeEntry[] }[],
): Promise<string> {
  const { createHash } = await import('node:crypto');

  const sorted = [...pools].sort((a, b) => a.poolId - b.poolId);
  const lines = sorted.map((p) => {
    const prizesCanonical = JSON.stringify(canonicalizePrizes(p.prizes));
    const prizesHash = createHash('sha256').update(prizesCanonical).digest('hex');
    return `${p.poolId}|${p.spent}|${p.spentToken}|${p.wins}|${prizesHash}`;
  });
  const root = createHash('sha256').update(lines.join('\n')).digest('hex');
  return `sha256:${root}`;
}

/**
 * Canonicalize a prizes array for hashing: sort fungible by token,
 * then NFTs by token + sorted serials. Strips key ordering noise
 * from JSON.stringify.
 */
function canonicalizePrizes(prizes: PrizeEntry[]): PrizeEntry[] {
  const ft = prizes
    .filter((p): p is Extract<PrizeEntry, { t: 'ft' }> => p.t === 'ft')
    .map((p) => ({ t: 'ft' as const, tk: p.tk, amt: p.amt }))
    .sort((a, b) => a.tk.localeCompare(b.tk));
  const nft = prizes
    .filter((p): p is Extract<PrizeEntry, { t: 'nft' }> => p.t === 'nft')
    .map((p) => ({
      t: 'nft' as const,
      tk: p.tk,
      sym: p.sym,
      ser: [...p.ser].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.tk.localeCompare(b.tk));
  return [...ft, ...nft];
}

/**
 * Truncate an error message to a fixed byte budget so it fits in a
 * v2 message without overflowing the 1024-byte topic limit. Keeps
 * the head (most informative) and adds an ellipsis if truncated.
 */
export function truncateError(message: string, maxBytes = 200): string {
  const buf = Buffer.from(message, 'utf-8');
  if (buf.length <= maxBytes) return message;
  return buf.slice(0, maxBytes - 3).toString('utf-8') + '...';
}

/**
 * How long a session can sit in `in_flight` (open seen, no terminal)
 * before the reader marks it `orphaned`. 5 minutes covers any
 * realistic Hedera consensus + mirror node propagation lag plus the
 * agent's actual play time.
 */
export const SESSION_INFLIGHT_TIMEOUT_MS = 5 * 60 * 1000;
