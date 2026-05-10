/**
 * HCS-20 schema v2 — normalized session reconstruction types and
 * shared on/off-topic helpers (Merkle root, error truncation, byte
 * cap enforcement).
 *
 * SOURCE OF TRUTH: wire-format shapes (PlaySessionOpenMessage,
 * PlayPoolResultMessage, etc.) live in `./hcs20-schema.ts` as Zod
 * schemas. This file re-exports the inferred TypeScript types so
 * existing consumers (`AccountingService`, `hcs20-reader`,
 * `verify-audit`, audit pages) keep working unchanged. Adding or
 * changing a wire field MUST go through `hcs20-schema.ts` first;
 * the writer's `submitV2Message` calls `validateV2Message` against
 * the schema and a field that isn't on the schema is stripped.
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
 */

// ── Wire shape re-exports (source: hcs20-schema.ts) ─────────

export {
  HCS20_V2_OPS,
  PrizeEntrySchema,
  PlaySessionOpenSchema,
  PlayPoolResultSchema,
  PlaySessionCloseSchema,
  PlaySessionAbortedSchema,
  RefundSchema,
  PrizeRecoverySchema,
  StrategyChangeSchema,
  ControlEventSchema,
  Hcs20V2MessageSchema,
  Hcs20WriterMessageSchema,
  validateV2Message,
  safeParseByOp,
  HCS20_SCHEMAS,
} from './hcs20-schema.js';

export type {
  Hcs20V2OpName,
  Hcs20OpName,
  PrizeEntry,
  PlaySessionOpenMessage,
  PlayPoolResultMessage,
  PlaySessionCloseMessage,
  PlaySessionAbortedMessage,
  RefundMessage,
  PrizeRecoveryMessage,
  StrategyChangeMessage,
  ControlEventMessage,
  Hcs20V2Message,
  Hcs20WriterMessage,
} from './hcs20-schema.js';

import type { PrizeEntry, PlaySessionCloseMessage } from './hcs20-schema.js';

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
  /**
   * R5-FG-58 (P12-311): the sequence number of the
   * `play_session_open` message, distinct from `firstSeq` (the
   * minimum seq across the whole session bucket). For an
   * out-of-order session — rare but possible — `firstSeq` could
   * equal a pool message's sequence. A strategy_change between
   * open's logical time and firstSeq's actual time would be applied
   * incorrectly. `verify-audit`'s strategy cross-check uses
   * `openSeq` so the check compares to the strategy that was active
   * when the user *initiated* the play (the open), not when the
   * first pool happened to land on the topic.
   */
  openSeq?: number;
  /**
   * R5-FG-59 (P12-309): when the agent legitimately deviated from
   * the strategy snapshotted at session-open (budget exhaustion,
   * killswitch mid-play, per-pool fee filter), the close/aborted
   * message can carry this field so an auditor sees session
   * behavior diverged from the recorded strategy intentionally.
   * Surfaced by verify-audit as an `info` alert (NOT a critical
   * mismatch — the field's presence is the explanation).
   */
  strategyDeviation?: { reason: string; field?: string };
  /**
   * R8-FG-16 / Phase-6 Cluster C: total count of prizes dropped by
   * the writer's slim-fallback (`slim_truncated_prizes` field on
   * pool messages). When > 0, the on-chain prize transfer carried
   * MORE prizes than the topic records — totalPrizeValue under-reports
   * actual on-chain truth and external auditors must reconcile
   * against on-chain wallet state. Verify-audit surfaces this as a
   * warning.
   */
  truncatedPrizesDropped?: number;
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
 * Identity binding for a Merkle root. Pre-R4-FG-23 the root hashed only
 * pool tuples — two sessions with structurally identical pool sequences
 * (same poolIds, spent, prizes) produced the same root and a
 * compromised submit-key holder could swap a `play_session_close`
 * between sessions and still pass the reader's tamper-evidence check.
 *
 * Including `sessionId|user|agent` as the first hash input ties each
 * root to a single (session, user, agent) triple so cross-session
 * replay no longer validates.
 */
export interface PoolsRootBinding {
  sessionId: string;
  user: string;
  agent: string;
}

/**
 * Compute the canonical poolsRoot for a session: sha256 of an
 * optional binding line concatenated with the sorted-by-poolId
 * tuple list. Used by both writer (when emitting the close /
 * aborted message) and reader (when validating it).
 *
 * Canonical form:
 *   - First line (when `binding` provided, R4-FG-23): `bv:1|${sessionId}|${user}|${agent}`
 *   - One line per pool: `${poolId}|${spent}|${spentToken}|${wins}|${prizesHash}`
 *     where prizesHash is sha256 of the canonical-JSON-serialized
 *     prizes array.
 *   - Joined by newline.
 *
 * Determinism: the writer ALWAYS passes a binding now (post-R4-FG-23).
 * Pre-fix close messages on testnet have a root that was hashed
 * without binding — the reader handles this by trying the bound
 * format first, then falling back to the legacy unbound format and
 * emitting a `legacy_merkle_binding` warning. Newly-emitted sessions
 * always validate strictly.
 */
export async function computePoolsRoot(
  pools: { poolId: number; spent: string | number; spentToken: string; wins: number; prizes: PrizeEntry[] }[],
  binding?: PoolsRootBinding,
): Promise<string> {
  const { createHash } = await import('node:crypto');

  const sorted = [...pools].sort((a, b) => a.poolId - b.poolId);
  const lines = sorted.map((p) => {
    // R5-FG-1 (round-5 critical): the canonical form intentionally
    // OMITS NFT display metadata (`sym`). The slim-fallback path in
    // `recordPlayPoolResult` (R3-FG-46) truncates `sym` to 8 chars
    // when an oversized message needs to fit under the 1024-byte HCS
    // cap; pre-fix the writer hashed the FULL untruncated `sym`
    // while the reader recomputed from the WIRE-FORMAT (truncated)
    // `sym` — Merkle roots disagreed, every multi-NFT branded-prize
    // pool was marked corrupt. `sym` is display metadata; only token
    // id + serial set are load-bearing for tamper-evidence.
    const prizesCanonical = JSON.stringify(canonicalizePrizesForHash(p.prizes));
    const prizesHash = createHash('sha256').update(prizesCanonical).digest('hex');
    return `${p.poolId}|${p.spent}|${p.spentToken}|${p.wins}|${prizesHash}`;
  });
  const allLines = binding
    ? [`bv:1|${binding.sessionId}|${binding.user}|${binding.agent}`, ...lines]
    : lines;
  const root = createHash('sha256').update(allLines.join('\n')).digest('hex');
  return `sha256:${root}`;
}

/**
 * Canonicalize a prizes array for HASHING. Returns a stripped form:
 * fungible = `{t, tk, amt}`; nft = `{t, tk, ser}` (NO `sym`).
 *
 * R5-FG-1 (round-5 critical): pre-fix this returned `PrizeEntry[]`
 * including the NFT `sym` display field. The slim-fallback in
 * `AccountingService.recordPlayPoolResult` truncates `sym` to 8 chars
 * to fit the 1024-byte HCS cap — but the writer ALREADY computed the
 * Merkle root over the FULL untruncated form. The reader recomputed
 * from the WIRE-FORMAT (truncated) form. Roots disagreed → every
 * multi-NFT-prize pool with branded symbols silently corrupted the
 * audit trail. The fix is to make `sym` non-load-bearing for hashing.
 * The wire format keeps `sym` for display; the canonical form for
 * tamper-evidence drops it.
 */
type CanonicalPrizeForHash =
  | { t: 'ft'; tk: string; amt: number }
  | { t: 'nft'; tk: string; ser: number[] };

function canonicalizePrizesForHash(prizes: PrizeEntry[]): CanonicalPrizeForHash[] {
  const ft = prizes
    .filter((p): p is Extract<PrizeEntry, { t: 'ft' }> => p.t === 'ft')
    .map((p) => ({ t: 'ft' as const, tk: p.tk, amt: p.amt }))
    .sort((a, b) => a.tk.localeCompare(b.tk));
  const nft = prizes
    .filter((p): p is Extract<PrizeEntry, { t: 'nft' }> => p.t === 'nft')
    .map((p) => ({
      t: 'nft' as const,
      tk: p.tk,
      // sym intentionally omitted (R5-FG-1)
      ser: [...p.ser].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.tk.localeCompare(b.tk));
  return [...ft, ...nft];
}

/**
 * Truncate an error message to a fixed byte budget so it fits in a
 * v2 message without overflowing the 1024-byte topic limit. Keeps
 * the head (most informative) and adds an ellipsis if truncated.
 *
 * R4-FG-55 (round-4 medium): codepoint-safe truncation. Pre-fix this
 * sliced at the byte boundary, which can split mid-codepoint for
 * non-ASCII errors (Hedera SDK errors with Japanese / accented chars,
 * URLs with percent-encoded UTF-8, etc.). The resulting U+FFFD
 * replacement chars re-encode to 3 bytes each, which can tip the
 * payload BACK over the 1024-byte cap that the truncation was meant
 * to bring it under. Walking backward to the previous UTF-8 lead byte
 * before the cut keeps every codepoint intact.
 */
export function truncateError(message: string, maxBytes = 200): string {
  const buf = Buffer.from(message, 'utf-8');
  if (buf.length <= maxBytes) return message;
  let cut = maxBytes - 3; // reserve 3 bytes for '...'
  // Walk backward to a UTF-8 lead byte. Continuation bytes are 10xxxxxx
  // (0x80..0xBF). Lead bytes are 0xxxxxxx (ASCII), 110xxxxx, 1110xxxx,
  // or 11110xxx. We want to STOP before a continuation byte so we
  // don't slice through a multibyte codepoint.
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) {
    cut--;
  }
  // Edge case: if the string is all continuation bytes (impossible for
  // valid UTF-8 but guard anyway), fall through to the byte slice.
  return buf.slice(0, cut).toString('utf-8') + '...';
}

/**
 * How long a session can sit in `in_flight` (open seen, no terminal)
 * before the reader marks it `orphaned`. 5 minutes covers any
 * realistic Hedera consensus + mirror node propagation lag plus the
 * agent's actual play time.
 */
export const SESSION_INFLIGHT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Hedera Consensus Service per-message size limit. The protocol is
 * 1024 bytes; we hard-fail anything bigger so a truncated audit
 * message can never be silently emitted.
 */
export const HCS_MESSAGE_BYTE_LIMIT = 1024;

/**
 * 0.3.4 hardening: single source of truth for the 1024-byte topic
 * message cap. Pre-fix the cap was duplicated inline at
 * `AccountingService.submitMessage` (v1) and `submitV2Message` (v2)
 * but missing entirely from `NegotiationHandler.sendToUser`. The
 * security audit's debt-hunter found the gap (finding #14) — a
 * negotiation message with a long error string or strategy diff
 * could silently fail at the HCS layer. Funnelling all three
 * submitters through this helper gives the cap one home.
 *
 * Throws if the message exceeds 1024 bytes. Caller chooses whether
 * to swallow the throw (negotiation paths are best-effort) or
 * propagate (audit paths are load-bearing).
 */
export function enforceTopicMessageSizeLimit(
  message: string,
  context: string,
): void {
  const bytes = Buffer.byteLength(message, 'utf-8');
  if (bytes > HCS_MESSAGE_BYTE_LIMIT) {
    throw new Error(
      `[HCS] message exceeds ${HCS_MESSAGE_BYTE_LIMIT}-byte cap (${bytes} bytes): ${context}`,
    );
  }
}
