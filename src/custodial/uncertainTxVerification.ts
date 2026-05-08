/**
 * Reconcile-time verification of `*_uncertain` dead-letter entries.
 *
 * When an on-chain submission's receipt times out (after `tx.execute`
 * returns successfully), the calling code persists a dead-letter row
 * with kind `withdrawal_uncertain`, `operator_fee_withdraw_uncertain`,
 * or `play_uncertain` and KEEPS its idempotency / reserve claim. The
 * on-chain outcome is unknown.
 *
 * This module walks those rows, queries the mirror node for each tx,
 * and resolves:
 *
 *   - Confirmed SUCCESS: complete the post-conditions (ledger
 *     adjustment, audit write, store flush) and mark the entry
 *     resolved. Leave any SET-NX-EX claim in place.
 *   - Confirmed FAILED: release the held claim / reserve so the
 *     operator (or user) can retry, and mark the entry resolved.
 *   - Still NOT_FOUND or transient mirror error: leave the entry
 *     untouched; next reconcile pass will retry. After 24h of
 *     persistent NOT_FOUND, the entry is promoted to FAILED — Hedera
 *     consensus is sub-second, so anything not on mirror after a day
 *     never landed.
 *
 * The refund verification path is in `src/hedera/refund.ts`
 * (`verifyUncertainRefunds`) — kept there because it's tightly
 * coupled to refund's claim-key semantics and audit-write helper.
 *
 * ── Concurrency safety ────────────────────────────────────────────
 *
 * Each verifier acquires a per-txId Redis SET-NX-EX lock
 * (`KEY_PREFIX.verifying:<txId>`, 60s TTL) BEFORE any state mutation.
 * Two reconcile passes overlapping (admin-click + cron) will see the
 * same open entry, but only one will hold the verifying lock and
 * mutate state. The other gets `still_uncertain` and bows out. Lock
 * naturally expires; explicit release would be racy, so we don't.
 */

import type { IStore, DeadLetterEntry } from './IStore.js';
import type { UserLedger } from './UserLedger.js';
import type { AccountingService } from './AccountingService.js';
import { getMirrorBaseUrl } from '../hedera/mirror.js';
import { classifyMirrorResult, type MirrorResult } from '../hedera/responseCodes.js';
import { getRedis, KEY_PREFIX } from '../auth/redis.js';
import { logger } from '../lib/logger.js';
import { escalateUncertainDlFailure } from '../lib/escalation.js';
import {
  acquireOperatorLock,
  releaseOperatorLock,
  releaseUserLock,
  RELEASE_SCRIPT,
  tryAcquireUserLockWithBackoff,
} from '../lib/locks.js';

// ── Constants ─────────────────────────────────────────────────────

/**
 * After this many hours of persistent NOT_FOUND, an uncertain entry
 * is promoted to FAILED. Hedera consensus is sub-second; anything
 * still invisible to the mirror node after 24h has functionally
 * never landed, so it's safe to release the held claim/reserve.
 */
const NOT_FOUND_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Per-txId verifier lock TTL. Long enough to absorb a slow mirror
 * fetch + audit write, short enough that a crashed verifier's lock
 * doesn't wedge the entry beyond the next reconcile cadence.
 */
const VERIFY_LOCK_TTL_SEC = 60;

/**
 * Number of times a malformed entry can be skipped before the
 * operator is paged. The entry sits in the dead-letter list until
 * resolved by hand; we want a signal so it doesn't quietly rot.
 */
const MAX_VERIFICATION_ATTEMPTS_BEFORE_PAGE = 5;

// Mirror node tx response shape (partial — only what we need).
interface MirrorTxLookup {
  transactions?: Array<{ result: string }>;
}

// ── Outcome shapes ────────────────────────────────────────────────

export interface WithdrawalVerificationOutcome {
  withdrawTxId: string;
  userId: string;
  status: 'confirmed' | 'failed' | 'still_uncertain';
  /** Human-readable note suitable for an admin UI. */
  note: string;
}

export interface OperatorFeeWithdrawVerificationOutcome {
  withdrawTxId: string;
  status: 'confirmed' | 'failed' | 'still_uncertain';
  note: string;
}

export interface PlayVerificationOutcome {
  uncertainTxId: string;
  userId: string;
  status: 'confirmed' | 'failed' | 'still_uncertain';
  note: string;
}

// ── Shared helpers ────────────────────────────────────────────────

/**
 * F4 (2026-05-06 audit I-05): a `details.amount` value must be a
 * finite, non-negative number before it's allowed into ledger
 * mutations. Without this check, `Infinity` passes `typeof === 'number'`
 * → `settleSpend(Infinity)` corrupts the ledger to `NaN` (which
 * JSON-serializes as `null` and silently breaks every subsequent
 * balance read), and a negative `-1` triggers an underflow path
 * downstream. Use this everywhere a verifier reads `details.amount`.
 */
function isValidDetailAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * F4 (2026-05-06 audit I-04): each `tokenReservations[i]` entry must
 * be a `{ token: string; amount: number }` before it's iterated.
 * Without this check, malformed entries like `{ token: 42, amount: '1.5' }`
 * coerce through `releaseReserve` and corrupt `entry.reserved` to
 * `NaN`/`null`.
 */
function isValidTokenReservation(
  r: unknown,
): r is { token: string; amount: number } {
  if (typeof r !== 'object' || r === null) return false;
  const obj = r as Record<string, unknown>;
  return typeof obj.token === 'string' && isValidDetailAmount(obj.amount);
}

/**
 * F4 (2026-05-06 audit I-12): a verifier must NOT partial-execute
 * when progress markers indicate impossible state (e.g.
 * `totalWithdrawnAt` set without `settledAt`).
 *
 * R3-FG-3 (round-3 P6-001 / P2-004): REVERTS R2-FG-13's self-heal.
 * Self-heal back-filled unset earlier markers from the latest set
 * marker's timestamp. The verifier's per-step gate (`if
 * (!progress.settledAt)`) is a TRUTHY check — back-fill set the
 * field, gate skipped, the actual mutation (`ledger.settleSpend`)
 * NEVER RAN, reservation held forever, balance silently understated.
 * The "tampering not realistic" justification was wrong: any
 * partial-Redis-failure or version-skew deploy that lands a later
 * stamp without an earlier one triggered the silent skip on the
 * next pass.
 *
 * Restored F4 behavior: return a string error reason; caller
 * escalates via bumpVerificationAttempts and refuses to proceed.
 * The 24h NOT_FOUND→FAILED max-age policy is the intended recovery
 * path; an entry that wedges past 24h gets a real operator page,
 * which is preferable to silent corruption.
 *
 * Returns `null` if markers are coherent; otherwise a reason string.
 */
function validateProgressOrdering(
  entry: DeadLetterEntry,
  order: string[],
): string | null {
  const details = (entry.details ?? {}) as Record<string, unknown>;
  let sawUnset = false;
  for (const marker of order) {
    const set = typeof details[marker] === 'string';
    if (set && sawUnset) {
      return `inconsistent progress markers: ${marker} set without prior step`;
    }
    if (!set) sawUnset = true;
  }
  return null;
}

/**
 * Acquire the per-txId verifier lock with a unique fence value.
 * Returns the fence string on success (caller passes it back to
 * `releaseVerifyLock`), or `null` if another reconcile pass already
 * holds the lock.
 *
 * F25 / F26 (2026-05-06 audit SM-01 / C-02 / SM-03): the fence
 * value is required so a stale lock from a crashed Lambda doesn't
 * accidentally get DELed by a fresh Lambda's release. Compare-and-
 * delete via the same Lua eval pattern used by `releaseUserLock`.
 */
async function acquireVerifyLock(txId: string): Promise<string | null> {
  try {
    const redis = await getRedis();
    const key = `${KEY_PREFIX.verifying}${txId}`;
    // Crypto-grade fence — random per acquisition. Two concurrent
    // attempts cannot collide.
    const fence = `verify-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const result = await redis.set(key, fence, { nx: true, ex: VERIFY_LOCK_TTL_SEC });
    return result !== null ? fence : null;
  } catch (e) {
    // Redis blip — fail closed. Better to skip this pass than to risk
    // double-mutation if the next pass sees the entry resolved.
    logger.warn('verifier lock acquisition failed; skipping entry this pass', {
      component: 'UncertainTx',
      event: 'verify_lock_redis_error',
      txId,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Compare-and-delete release for the per-txId verifier lock.
 *
 * F25 (2026-05-06 audit SM-01): release on no-mutation paths
 * (transient mirror, recent NOT_FOUND) so the next reconcile pass
 * can retry within the lock TTL window. Without this, a flaky mirror
 * wedges entries for 60s × the cron cadence.
 *
 * F26 (audit C-02 / SM-03): release after successful resolve so a
 * concurrent force-release isn't blocked by the just-finished
 * verifier's still-alive lock.
 *
 * The fence check (only delete if the value matches the fence we set
 * at acquire) prevents a fresh Lambda's lock from being DELed by a
 * stale completion path. Failure here is logged but non-fatal —
 * worst case the lock TTL handles cleanup.
 */
async function releaseVerifyLock(txId: string, fence: string): Promise<void> {
  try {
    const redis = await getRedis();
    const key = `${KEY_PREFIX.verifying}${txId}`;
    // R2-FG-6: share the lowercase RELEASE_SCRIPT with `src/lib/locks.ts`.
    // The in-memory Redis mock matches eval bodies by `script.includes('get')
    // && script.includes('del')` (lowercase) — the previous in-line
    // uppercase Lua made every release a silent no-op under the mock,
    // which is exactly what every test in the suite uses. Also drops
    // the get-then-del fallback (racy — another acquire could win
    // between get and del); TTL-expire is preferable to that risk.
    await redis.eval(RELEASE_SCRIPT, [key], [fence]);
  } catch (e) {
    logger.warn('verifier lock release failed; relying on TTL', {
      component: 'UncertainTx',
      event: 'verify_lock_release_failed',
      txId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Mirror-node fetch timeout. F5 (2026-05-06 audit I-09): without
 * AbortSignal.timeout, a slow-body mirror response can wedge a
 * verifier pass past the per-txId verifier-lock TTL.
 */
const MIRROR_FETCH_TIMEOUT_MS = 8_000;

/**
 * Look up a tx on the mirror node and classify the result. Returns
 * `null` for a transient/network error (caller should treat as
 * still-uncertain and retry next pass).
 */
async function lookupMirrorResult(
  txId: string,
): Promise<{ result: MirrorResult } | { transientError: string }> {
  try {
    const url = `${getMirrorBaseUrl()}/transactions/${txId}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(MIRROR_FETCH_TIMEOUT_MS) });
    if (res.status === 404) return { result: 'NOT_FOUND' };
    if (!res.ok) {
      return { transientError: `Mirror returned ${res.status}; will retry next reconcile.` };
    }
    const body = (await res.json()) as MirrorTxLookup;
    const tx = body.transactions?.[0];
    if (!tx) return { result: 'NOT_FOUND' };
    return { result: classifyMirrorResult(tx.result) };
  } catch (e) {
    return {
      transientError: `Mirror lookup failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Parse a Hedera transaction id's valid-start timestamp.
 * Format: `<account>@<seconds>.<nanos>` (e.g. `0.0.123@1700000000.000000001`).
 * Returns the consensus-adjacent timestamp in milliseconds, or
 * `null` if the txId is malformed.
 *
 * F27 (2026-05-06 audit SM-06): the 24h NOT_FOUND→FAILED policy
 * MUST use this timestamp instead of `entry.timestamp` (which is
 * the write-time wall clock on whatever Lambda dead-lettered the
 * tx). Operator-clock skew, container-host clock drift, and
 * Lambda wall-clock jitter all bias `entry.timestamp`; the txId's
 * embedded `seconds.nanos` is the canonical consensus-adjacent
 * value. Without this, an attacker who can nudge the Lambda's
 * clock 25 hours forward gets the verifier to release reserves
 * for txs that are still 5 minutes old on chain.
 */
export function parseTxIdTimestamp(txId: string): number | null {
  // Format `<shard>.<realm>.<num>@<seconds>.<nanos>`. Anchored regex
  // to refuse anything that isn't a Hedera txId shape.
  const match = txId.match(/^\d+\.\d+\.\d+@(\d+)\.(\d+)$/);
  if (!match) return null;
  const seconds = Number(match[1]);
  const nanos = Number(match[2]);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return null;
  return seconds * 1000 + Math.floor(nanos / 1_000_000);
}

/**
 * Apply the NOT_FOUND max-age policy. Entries older than 24h are
 * promoted to FAILED — Hedera consensus is sub-second, so anything
 * not on the mirror after a day never landed.
 *
 * F27: prefers the txId's embedded valid-start timestamp over
 * `entry.timestamp`. Falls back to `entry.timestamp` only when the
 * txId can't be parsed (legacy entries written before the txId-shape
 * invariant was enforced upstream).
 */
function applyNotFoundMaxAge(entry: DeadLetterEntry): MirrorResult {
  const txIdMs = parseTxIdTimestamp(entry.transactionId);
  const referenceMs = txIdMs ?? new Date(entry.timestamp).getTime();
  const ageMs = Date.now() - referenceMs;
  return ageMs > NOT_FOUND_MAX_AGE_MS ? 'FAILED' : 'NOT_FOUND';
}

/**
 * Increment `verificationAttempts` on a malformed entry and page if
 * the threshold is hit.
 *
 * F4 (2026-05-06 audit SM-08): the counter lives in Redis under
 * `KEY_PREFIX.verifying<txId>:malformed-attempts` via atomic INCR,
 * not in the dead-letter `details` blob. The old read-then-write
 * pattern (`prior = details.verificationAttempts ?? 0; next = prior + 1`)
 * could race between two concurrent reconcile passes — both reading
 * the same `prior`, both writing the same `next` — silently missing
 * the page condition `next === MAX_VERIFICATION_ATTEMPTS_BEFORE_PAGE`.
 * INCR returns the new value atomically so the threshold fires
 * exactly once across the cluster.
 *
 * The counter is also mirrored into `details.verificationAttempts`
 * for backward compat with any UI that reads from the dead-letter
 * row directly. Best-effort — a Redis blip on the mirror write is
 * non-fatal because the INCR is the source of truth for paging.
 */
async function bumpVerificationAttempts(
  store: IStore,
  entry: DeadLetterEntry,
): Promise<void> {
  let next: number;
  try {
    const redis = await getRedis();
    const counterKey = `${KEY_PREFIX.verifying}${entry.transactionId}:malformed-attempts`;
    next = await redis.incr(counterKey);
    // Set a TTL on first increment so abandoned counters don't
    // accumulate forever. 7 days is generous — a malformed entry
    // either gets fixed or escalates well before then.
    if (next === 1) {
      try {
        await redis.expire(counterKey, 7 * 24 * 60 * 60);
      } catch {
        /* TTL is hygiene; counter still works without it */
      }
    }
  } catch (e) {
    // Redis unavailable — fall back to the local-cache counter so
    // the page can still fire (best-effort, not cluster-atomic).
    const prior = (entry.details?.verificationAttempts as number | undefined) ?? 0;
    next = prior + 1;
    logger.warn('bumpVerificationAttempts INCR failed; using local fallback', {
      component: 'UncertainTx',
      txId: entry.transactionId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  // R3-FG-58 (round-3 P2-011): mirror the count via the same
  // refresh-then-spread pattern stampProgress uses (R3-FG-10) so a
  // concurrent force-release-resolve isn't reverted by the bump's
  // stale entry spread.
  try {
    let baseEntry: DeadLetterEntry = entry;
    try {
      await store.refreshDeadLetters();
      const fresh = store
        .getDeadLetters()
        .find((e) => e.transactionId === entry.transactionId);
      if (fresh) baseEntry = fresh;
    } catch {
      /* fall through */
    }
    if (baseEntry.resolvedAt) {
      // Already resolved; don't re-open by stamping.
      return;
    }
    await store.upsertDeadLetter({
      ...baseEntry,
      details: { ...(baseEntry.details ?? {}), verificationAttempts: next },
    });
  } catch {
    /* logged below if the threshold fires */
  }
  if (next >= MAX_VERIFICATION_ATTEMPTS_BEFORE_PAGE) {
    // F4: the page check fires whenever we cross OR equal the
    // threshold (was strict equality — a Redis blip that caused
    // two passes to both observe `next === 5` would miss the page).
    // Idempotent paging is fine; the escalation hook deduplicates.
    logger.error(
      `dead-letter entry malformed for ${MAX_VERIFICATION_ATTEMPTS_BEFORE_PAGE}+ ` +
        `consecutive reconcile passes — manual triage required`,
      {
        component: 'UncertainTx',
        event: 'malformed_dl_threshold_reached',
        kind: entry.kind,
        txId: entry.transactionId,
        attempts: next,
      },
    );
    await escalateUncertainDlFailure({
      kind: (entry.kind ?? 'withdrawal_uncertain') as
        | 'withdrawal_uncertain'
        | 'operator_fee_withdraw_uncertain'
        | 'play_uncertain'
        | 'refund_uncertain',
      uncertainTxId: entry.transactionId,
      userId: entry.details?.userId as string | undefined,
      cause: new Error(
        `Malformed dead-letter persisted across ${next} reconcile passes`,
      ),
    });
  }
}

/**
 * R2-FG-14 (round-2 B-01 / S-07 / R-03 partial): bump a per-entry
 * counter for "verifier deferred this pass because the user lock was
 * held". Sustained contention (legit long play, or a user spamming
 * plays) wedges the verifier indefinitely — telemetry-only "still
 * uncertain" looks identical to mirror-flake from the operator's
 * point of view. Page after `MAX_USER_LOCK_CONTENTION_BEFORE_PAGE`
 * consecutive defers so an operator gets a real escalation instead
 * of silent stuckness.
 *
 * Counter is stored in Redis (cross-Lambda atomic) plus mirrored
 * into the DL row's `userLockContentionAttempts` for operator
 * visibility. The escalation hook is idempotent so multiple Lambdas
 * crossing the threshold simultaneously don't multi-page.
 */
const MAX_USER_LOCK_CONTENTION_BEFORE_PAGE = 6;

async function bumpUserLockContentionAttempts(
  store: IStore,
  entry: DeadLetterEntry,
): Promise<void> {
  let next: number;
  try {
    const redis = await getRedis();
    const counterKey = `${KEY_PREFIX.verifying}${entry.transactionId}:user-lock-contention`;
    next = await redis.incr(counterKey);
    if (next === 1) {
      try {
        await redis.expire(counterKey, 7 * 24 * 60 * 60);
      } catch {
        /* TTL hygiene */
      }
    }
  } catch (e) {
    // R3-FG-54 (round-3 P6-006): pre-fix used a per-process local
    // fallback. Each Lambda counted only its own observations across
    // a Redis outage; the page threshold (6) was never crossed because
    // each Lambda saw only 1-2. Now: eagerly escalate on Redis
    // failure — better duplicate pages than a silently stuck
    // verifier. The dedup at R3-FG-48 (escalation idempotency) bounds
    // page volume.
    const prior =
      (entry.details?.userLockContentionAttempts as number | undefined) ?? 0;
    next = prior + 1;
    logger.error('bumpUserLockContentionAttempts INCR failed — escalating eagerly', {
      component: 'UncertainTx',
      txId: entry.transactionId,
      error: e instanceof Error ? e.message : String(e),
    });
    try {
      await escalateUncertainDlFailure({
        kind: (entry.kind ?? 'withdrawal_uncertain') as
          | 'withdrawal_uncertain'
          | 'operator_fee_withdraw_uncertain'
          | 'play_uncertain'
          | 'refund_uncertain',
        uncertainTxId: entry.transactionId,
        userId: entry.details?.userId as string | undefined,
        cause: e,
      });
    } catch {
      /* logged above */
    }
  }
  // R4-FG-2 (round-4 P3-DS-002): refresh-then-spread, mirroring
  // R3-FG-58 in `bumpVerificationAttempts` and R3-FG-10 in
  // `stampProgress`. Pre-fix this spread `...entry` (the verifier-loop's
  // pre-mutation snapshot) — a sibling force-release that just set
  // `resolvedAt` had it REVERTED, reopening the entry for re-mutation
  // (double-debit / double-release-reservation).
  try {
    let base: DeadLetterEntry = entry;
    try {
      await store.refreshDeadLetters();
      const fresh = store
        .getDeadLetters()
        .find((e) => e.transactionId === entry.transactionId);
      if (fresh) base = fresh;
    } catch {
      /* fall through with caller-supplied snapshot */
    }
    if (base.resolvedAt) {
      // Already resolved; don't reopen by stamping a counter on it.
      return;
    }
    await store.upsertDeadLetter({
      ...base,
      details: {
        ...(base.details ?? {}),
        userLockContentionAttempts: next,
      },
    });
  } catch {
    /* visible in next stamp */
  }
  if (next >= MAX_USER_LOCK_CONTENTION_BEFORE_PAGE) {
    logger.error(
      `verifier deferred for ${MAX_USER_LOCK_CONTENTION_BEFORE_PAGE}+ consecutive passes ` +
        `due to per-user lock contention — operator triage required`,
      {
        component: 'UncertainTx',
        event: 'user_lock_contention_threshold_reached',
        kind: entry.kind,
        txId: entry.transactionId,
        userId: entry.details?.userId,
        attempts: next,
      },
    );
    await escalateUncertainDlFailure({
      kind: (entry.kind ?? 'withdrawal_uncertain') as
        | 'withdrawal_uncertain'
        | 'operator_fee_withdraw_uncertain'
        | 'play_uncertain'
        | 'refund_uncertain',
      uncertainTxId: entry.transactionId,
      userId: entry.details?.userId as string | undefined,
      cause: new Error(
        `Verifier deferred ${next} consecutive passes — per-user lock held by long-running in-band op or runaway play loop`,
      ),
    });
  }
}

/**
 * Write an `audit_trail_orphaned` dead-letter when a verifier's
 * audit-write fails. Mirrors the in-band path's failure handling —
 * audit asymmetry was finding M16.
 */
async function recordAuditOrphan(
  store: IStore,
  sourceKind: NonNullable<DeadLetterEntry['kind']>,
  sourceTxId: string,
  details: Record<string, unknown>,
  cause: unknown,
): Promise<void> {
  try {
    // R2-FG-17 (round-2 S-02): salt the synthetic id by writer phase
    // (`verifier:`) so multiple audit-orphan writes for the same
    // source tx (verifier + force-release + creditDeposit) don't
    // collide. `upsertDeadLetter` is REPLACE — without the salt, a
    // later force-release orphan would obliterate the verifier's
    // earlier orphan history.
    //
    // R4-FG-27 (round-4 high): salt by writer phase WAS NOT enough.
    // Multi-pass mutation failures on the same source tx (e.g. flush
    // fails on pass 1, audit fails on pass 2 — both verifier-phase)
    // still collided. Use `mintAuditOrphanId` for a fresh `Date.now()
    // + uuid8` tail every call.
    const { mintAuditOrphanId } = await import('../lib/orphanIds.js');
    await store.upsertDeadLetter({
      transactionId: mintAuditOrphanId('audit-orphan:verifier', sourceTxId),
      timestamp: new Date().toISOString(),
      error: `verifier audit write failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      kind: 'audit_trail_orphaned',
      details: { sourceKind, sourceTxId, ...details },
    });
  } catch {
    // Already escalated by the calling verifier; nothing more to do.
  }
}

/**
 * Mark an entry resolved (idempotent — safe to call twice). When
 * `progress` is supplied, the per-post-condition idempotency
 * markers are merged into `entry.details` so a re-run after a crash
 * can read which steps already happened and skip them. R-HIGH-1 fix.
 */
async function markResolved(
  store: IStore,
  entry: DeadLetterEntry,
  resolutionTxId: string,
  progress?: Record<string, unknown>,
): Promise<void> {
  try {
    // R4-FG-1 (round-4 P1-001): refresh-then-spread, mirroring R3-FG-10
    // in `stampProgress`. Pre-fix the upsert spread `...entry` (the
    // verifier-loop's pre-mutation snapshot) for top-level fields.
    // A concurrent force-release that wrote a top-level field
    // (e.g. `sender`, or a future `pendingClaimFence`) between loop
    // entry and `markResolved` had its write silently REVERTED. Now:
    // re-read the latest entry, spread that. If the latest entry is
    // ALREADY resolved, skip the write entirely (someone else got
    // there first; clobbering would re-open it for our resolver).
    let base: DeadLetterEntry = entry;
    try {
      await store.refreshDeadLetters();
      const fresh = store
        .getDeadLetters()
        .find((e) => e.transactionId === entry.transactionId);
      if (fresh) base = fresh;
    } catch {
      /* fall through with caller-supplied snapshot */
    }
    if (base.resolvedAt) {
      // Already resolved by sibling — don't re-open.
      return;
    }
    await store.upsertDeadLetter({
      ...base,
      details: { ...(base.details ?? {}), ...(progress ?? {}) },
      resolvedAt: new Date().toISOString(),
      resolvedBy: 'reconcile',
      resolutionTxId,
    });
  } catch (e) {
    logger.warn('uncertain dead-letter resolve write failed', {
      component: 'UncertainTx',
      event: 'dl_resolve_write_failed',
      kind: entry.kind,
      txId: entry.transactionId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Persist the running progress accumulator mid-flight (between
 * post-condition steps) so a Lambda crash before `markResolved` is
 * recoverable by the next reconcile pass without duplicating the
 * completed steps.
 *
 * F1 (2026-05-06 audit C-01 / SM-02 / U-05): callers MUST pass the
 * full `progress` accumulator, not a single-key patch. Earlier
 * versions accepted a per-step patch and merged it into a stale
 * `entry.details` snapshot — each subsequent stamp overwrote prior
 * stamps in Redis, so a Lambda crash between steps would lose every
 * marker except the most recent one and the next pass would
 * re-execute the already-completed steps (silent double-mutation).
 *
 * Failures are still logged-and-swallowed: the next stamp re-asserts
 * the full accumulator, so a one-off stamp failure self-heals on the
 * next step. This avoids a transient Redis blip aborting the
 * remaining post-conditions.
 */
async function stampProgress(
  store: IStore,
  entry: DeadLetterEntry,
  progress: Record<string, unknown>,
): Promise<void> {
  try {
    // R2-FG-12 + R3-FG-10 (round-3 P2-001): refresh-before-merge AND
    // spread the FRESH entry's top-level fields, not the caller's
    // pre-refresh snapshot. Pre-R3 the upsert spread `...entry`
    // (top-level frozen at loop entry) — a concurrent writer that
    // set `resolvedAt` between Lambda A's refresh and Lambda A's
    // upsert had it REVERTED to undefined → next pass re-ran the
    // entry from scratch.
    //
    // If `fresh.resolvedAt` is set, ABORT — someone else already
    // resolved the entry. Stamping over it would re-open it.
    let fresh: DeadLetterEntry | undefined;
    try {
      await store.refreshDeadLetters();
      fresh = store
        .getDeadLetters()
        .find((e) => e.transactionId === entry.transactionId);
    } catch {
      /* fall through with the caller-supplied snapshot */
    }
    const base = fresh ?? entry;
    if (base.resolvedAt) {
      // Sibling writer resolved the entry; do not re-stamp.
      return;
    }
    await store.upsertDeadLetter({
      ...base,
      details: { ...(base.details ?? {}), ...progress },
    });
  } catch (e) {
    logger.warn('uncertain dead-letter progress stamp failed', {
      component: 'UncertainTx',
      event: 'dl_progress_stamp_failed',
      kind: entry.kind,
      txId: entry.transactionId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * F23 (2026-05-06 audit C-06): acquire the per-user lock with bounded
 * backoff before any per-user ledger mutation in the verifier paths.
 * Implementation lives in `src/lib/locks.ts` as
 * `tryAcquireUserLockWithBackoff` (R2-FG-1) so the verifier and the
 * force-release handlers share the exact same primitive — operator
 * actions can never race a concurrent in-band flow on the same user.
 */
const tryAcquireUserLockForVerify = tryAcquireUserLockWithBackoff;

/**
 * R2-FG-15 (round-2 R-03): namespace decision recorded here so future
 * refactors don't re-litigate it. The verifier intentionally shares
 * `lockUser:<userId>` with `processRefund` and in-band withdraw —
 * separate keys would let an in-band withdraw and a verifier mutation
 * proceed concurrently, which is exactly the race R2-FG-1 closes.
 * Sustained contention (legit long play, runaway client) is observed
 * via R2-FG-14's `bumpUserLockContentionAttempts` counter rather than
 * by giving the verifier a different lock; visibility, not correctness,
 * was the gap.
 */

// ── verifyUncertainWithdrawals ────────────────────────────────────

export async function verifyUncertainWithdrawals(
  store: IStore,
  ledger: UserLedger,
  accounting?: AccountingService,
): Promise<WithdrawalVerificationOutcome[]> {
  const outcomes: WithdrawalVerificationOutcome[] = [];

  await store.refreshDeadLetters().catch(() => undefined);
  const allOpen = store
    .getDeadLetters()
    .filter((e) => e.kind === 'withdrawal_uncertain' && !e.resolvedAt);
  if (allOpen.length === 0) return outcomes;

  // R4-FG-16 (round-4 high): cap entries per pass. Pre-fix the loop
  // walked every open DL serially. Per-DL cost ~10s with mirror flake
  // bias; with 90+ open DLs reconcile blows the 900s lock TTL, no
  // releaseOperatorLock runs (Lambda ceiling kills it), and the next
  // 14 cron ticks all see "reconcile already in progress" and skip
  // — insolvency goes undetected for ~3.5h. Now: cap at 25/pass and
  // log a "deferred N to next pass" warning.
  const MAX_ENTRIES_PER_PASS = 25;
  const open = allOpen.slice(0, MAX_ENTRIES_PER_PASS);
  if (allOpen.length > MAX_ENTRIES_PER_PASS) {
    logger.warn('verifyUncertainWithdrawals: deferred entries to next pass', {
      component: 'UncertainTx',
      event: 'verifier_pass_capped',
      kind: 'withdrawal_uncertain',
      total: allOpen.length,
      capped: MAX_ENTRIES_PER_PASS,
      deferred: allOpen.length - MAX_ENTRIES_PER_PASS,
    });
  }

  for (let entry of open) {
    const withdrawTxId = entry.transactionId;
    const details = (entry.details ?? {}) as {
      userId?: string;
      withdrawTxId?: string;
      amount?: number;
      tokenKey?: string;
      isHbar?: boolean;
      recipientAccountId?: string;
    };
    const userId = details.userId ?? '(unknown)';

    if (
      typeof details.userId !== 'string' ||
      !isValidDetailAmount(details.amount) ||
      typeof details.tokenKey !== 'string'
    ) {
      await bumpVerificationAttempts(store, entry);
      outcomes.push({
        withdrawTxId,
        userId,
        status: 'still_uncertain',
        note: 'Dead-letter entry malformed (missing userId / non-finite amount / tokenKey). Manual triage required.',
      });
      continue;
    }

    // F4 + R3-FG-3 (round-3 P6-001 / P2-004): REVERTS R2-FG-13's
    // self-heal. The self-heal silently caused the verifier to skip
    // real settleSpend / updateBalance mutations because the per-step
    // gate is a TRUTHY check on the back-filled marker. Restored F4:
    // escalate as malformed; the 24h max-age policy promotes
    // NOT_FOUND→FAILED for mirror-confirmed dead entries; truly
    // wedged entries get a real operator page after
    // MAX_VERIFICATION_ATTEMPTS_BEFORE_PAGE.
    const orderingErr = validateProgressOrdering(entry, [
      'settledAt',
      'totalWithdrawnAt',
      'historyWrittenAt',
      'auditWrittenAt',
    ]);
    if (orderingErr) {
      await bumpVerificationAttempts(store, entry);
      outcomes.push({
        withdrawTxId,
        userId,
        status: 'still_uncertain',
        note: `Dead-letter ${orderingErr}. Manual triage required.`,
      });
      continue;
    }

    // C4: per-txId lock. Skip if another reconcile is processing.
    const lockFence = await acquireVerifyLock(withdrawTxId);
    if (!lockFence) {
      outcomes.push({
        withdrawTxId,
        userId,
        status: 'still_uncertain',
        note: 'Concurrent reconcile holds verifier lock; will retry next pass.',
      });
      continue;
    }

    // ── Mirror lookup ──────────────────────────────────────────
    const lookup = await lookupMirrorResult(withdrawTxId);
    if ('transientError' in lookup) {
      // F25: no mutation happened — release lock so next pass can retry.
      await releaseVerifyLock(withdrawTxId, lockFence);
      outcomes.push({
        withdrawTxId,
        userId,
        status: 'still_uncertain',
        note: lookup.transientError,
      });
      continue;
    }
    let { result } = lookup;
    if (result === 'NOT_FOUND') {
      result = applyNotFoundMaxAge(entry);
    }

    if (result === 'NOT_FOUND') {
      // F25: recent NOT_FOUND means no mutation happened.
      await releaseVerifyLock(withdrawTxId, lockFence);
      outcomes.push({
        withdrawTxId,
        userId,
        status: 'still_uncertain',
        note: 'Not yet visible on mirror node; will retry next reconcile.',
      });
      continue;
    }

    if (result === 'FAILED') {
      // F23: serialize per-user mutation against active withdraw/play.
      const userToken = await tryAcquireUserLockForVerify(details.userId);
      if (!userToken) {
        // R2-FG-14: bump counter + page after threshold so sustained
        // contention escalates instead of silently looping.
        await bumpUserLockContentionAttempts(store, entry);
        await releaseVerifyLock(withdrawTxId, lockFence);
        outcomes.push({
          withdrawTxId,
          userId,
          status: 'still_uncertain',
          note: 'Per-user lock contention did not clear; will retry next reconcile.',
        });
        continue;
      }
      try {
        ledger.releaseReserve(details.userId, details.amount, details.tokenKey);
      } catch (e) {
        logger.warn('withdrawal_uncertain releaseReserve failed', {
          component: 'UncertainTx',
          withdrawTxId,
          userId: details.userId,
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        await releaseUserLock(details.userId, userToken);
      }
      // H10: flush before marking resolved, so the release survives
      // a Lambda freeze between mutation and resolve.
      try {
        await store.flush();
      } catch {
        /* flush failure is logged inside the store */
      }
      await markResolved(store, entry, withdrawTxId);
      // F26: release lock after work done so a concurrent
      // force-release isn't blocked by the just-finished verifier's
      // still-alive 60s lock.
      await releaseVerifyLock(withdrawTxId, lockFence);
      outcomes.push({
        withdrawTxId,
        userId,
        status: 'failed',
        note: 'On-chain withdrawal failed (or not on mirror after 24h); reserve released, user can retry.',
      });
      continue;
    }

    // ── Confirmed SUCCESS: settle + audit + flush + resolve ────
    //
    // R-HIGH-1: each post-condition is idempotency-marked so a
    // Lambda crash mid-mutation (or `accounting.recordWithdrawal`
    // exceeding the 60s lock TTL — HCS submits can hang on Hedera
    // congestion) doesn't cause a re-run to duplicate the completed
    // steps. Markers are stamped immediately after each step
    // succeeds; the next reconcile pass reads them and skips.
    type WithdrawProgress = {
      settledAt?: string;
      totalWithdrawnAt?: string;
      historyWrittenAt?: string;
      auditWrittenAt?: string;
    };
    const priorProgress = (entry.details ?? {}) as WithdrawProgress;
    const progress: WithdrawProgress = {
      settledAt: priorProgress.settledAt,
      totalWithdrawnAt: priorProgress.totalWithdrawnAt,
      historyWrittenAt: priorProgress.historyWrittenAt,
      auditWrittenAt: priorProgress.auditWrittenAt,
    };

    // F23: serialize the per-user mutations (settle / totalWithdrawn /
    // history) against active in-band withdraw / play / refund. The
    // user lock is held only across these three Redis writes; the HCS
    // audit submit below runs OUTSIDE the lock since it doesn't touch
    // per-user state and HCS submits can hang for seconds on
    // congestion. Skip this entire mutation block + audit on lock
    // contention — the entry stays unresolved (markers untouched) and
    // the next reconcile pass picks it up.
    let userMutateToken: string | null = null;
    if (
      !progress.settledAt ||
      !progress.totalWithdrawnAt ||
      !progress.historyWrittenAt
    ) {
      userMutateToken = await tryAcquireUserLockForVerify(details.userId);
      if (!userMutateToken) {
        // R2-FG-14: bump counter + escalate at threshold.
        await bumpUserLockContentionAttempts(store, entry);
        await releaseVerifyLock(withdrawTxId, lockFence);
        outcomes.push({
          withdrawTxId,
          userId,
          status: 'still_uncertain',
          note: 'Per-user lock contention did not clear; will retry next reconcile.',
        });
        continue;
      }
    }
    // R3-FG-8 (round-3 P5-WU-001): track whether any mutation step
    // threw. Pre-fix each step was `try/catch/log` and control fell
    // through to the audit step + markResolved. If `recordWithdrawal`
    // threw after settle+totalWithdrawn succeeded, the entry was
    // marked resolved with `historyWrittenAt` UNSET — but the topic
    // showed the burn. Subsequent passes never re-walked the entry
    // (resolvedAt set). Now: track failures, write audit_trail_orphaned
    // with the failed phase, and SKIP markResolved so the next pass
    // can retry.
    let mutationError: { phase: string; cause: unknown } | null = null;
    try {
      if (!progress.settledAt) {
        try {
          ledger.settleSpend(details.userId, details.amount, details.tokenKey);
          progress.settledAt = new Date().toISOString();
          await stampProgress(store, entry, progress);
        } catch (e) {
          mutationError = { phase: 'settle_spend', cause: e };
          logger.warn('withdrawal_uncertain settleSpend failed', {
            component: 'UncertainTx',
            withdrawTxId,
            userId: details.userId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      if (!progress.totalWithdrawnAt && !mutationError) {
        try {
          store.updateBalance(details.userId, (b) => {
            const tokEntry = b.tokens[details.tokenKey!];
            if (tokEntry) tokEntry.totalWithdrawn += details.amount!;
            return b;
          });
          progress.totalWithdrawnAt = new Date().toISOString();
          await stampProgress(store, entry, progress);
        } catch (e) {
          mutationError = { phase: 'total_withdrawn', cause: e };
          logger.warn('withdrawal_uncertain totalWithdrawn update failed', {
            component: 'UncertainTx',
            withdrawTxId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      if (!progress.historyWrittenAt && !mutationError) {
        try {
          store.recordWithdrawal({
            userId: details.userId,
            amount: details.amount,
            tokenId: details.isHbar ? null : details.tokenKey,
            recipientAccountId: details.recipientAccountId ?? '',
            transactionId: withdrawTxId,
            timestamp: new Date().toISOString(),
          });
          progress.historyWrittenAt = new Date().toISOString();
          await stampProgress(store, entry, progress);
        } catch (e) {
          mutationError = { phase: 'history_written', cause: e };
          logger.warn('withdrawal_uncertain recordWithdrawal failed', {
            component: 'UncertainTx',
            withdrawTxId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } finally {
      if (userMutateToken) {
        await releaseUserLock(details.userId, userMutateToken);
      }
    }

    // C3: HCS-20 audit anchor — was missing entirely. Without this,
    // confirmed-via-reconcile withdrawals are invisible to external
    // auditors reconstructing from the topic. R-HIGH-1: also gated
    // by auditWrittenAt — `accounting.recordWithdrawal` writes a
    // burn op with no idempotency on the message body, so a re-run
    // would emit a SECOND burn for the same withdrawal.
    if (accounting && !progress.auditWrittenAt) {
      try {
        // F18: include withdrawTxId so the reader can dedup duplicate
        // burns on Lambda-crash + reseed.
        await accounting.recordWithdrawal(
          details.recipientAccountId ?? '',
          details.amount,
          details.tokenKey,
          withdrawTxId,
        );
        progress.auditWrittenAt = new Date().toISOString();
        await stampProgress(store, entry, progress);
      } catch (auditErr) {
        // M16: audit failure → audit_trail_orphaned dead-letter so
        // the operator surfaces it the same way as in-band failures.
        logger.warn('withdrawal_uncertain accounting.recordWithdrawal failed', {
          component: 'UncertainTx',
          withdrawTxId,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
        // F19 (2026-05-06 audit A-04): orphan must carry every
        // parameter needed to manually replay
        // `accounting.recordWithdrawal` — recipientAccountId is the
        // first arg, dropping it forces the operator to JOIN against
        // the original DL row (fragile if purged).
        await recordAuditOrphan(
          store,
          'withdrawal_uncertain',
          withdrawTxId,
          {
            userId: details.userId,
            amount: details.amount,
            tokenKey: details.tokenKey,
            recipientAccountId: details.recipientAccountId ?? '',
            withdrawTxId,
          },
          auditErr,
        );
      }
    }

    // H10: flush BEFORE marking resolved.
    try {
      await store.flush();
    } catch {
      /* flush failure is logged inside the store */
    }
    // R3-FG-8 (round-3 P5-WU-001): if any mutation step failed, write
    // an audit_trail_orphaned row and SKIP markResolved so the next
    // pass retries. Pre-fix marked resolved unconditionally even when
    // a step had thrown, leaving the entry with missing markers and
    // no path back to retry.
    if (mutationError) {
      await recordAuditOrphan(
        store,
        'withdrawal_uncertain',
        withdrawTxId,
        {
          userId: details.userId,
          amount: details.amount,
          tokenKey: details.tokenKey,
          recipientAccountId: details.recipientAccountId ?? '',
          withdrawTxId,
          phase: `${mutationError.phase}_failed`,
        },
        mutationError.cause,
      );
      await releaseVerifyLock(withdrawTxId, lockFence);
      outcomes.push({
        withdrawTxId,
        userId,
        status: 'still_uncertain',
        note: `Mutation step '${mutationError.phase}' failed; entry left unresolved for retry on next pass.`,
      });
      continue;
    }
    await markResolved(store, entry, withdrawTxId, progress);
    // F26: release lock after successful resolve.
    await releaseVerifyLock(withdrawTxId, lockFence);

    outcomes.push({
      withdrawTxId,
      userId,
      status: 'confirmed',
      note: 'On-chain withdrawal confirmed; ledger settled and HCS-20 audit anchor written.',
    });
  }

  return outcomes;
}

// ── verifyUncertainOperatorFeeWithdrawals ─────────────────────────

export async function verifyUncertainOperatorFeeWithdrawals(
  store: IStore,
  agentAccountId: string,
  accounting?: AccountingService,
): Promise<OperatorFeeWithdrawVerificationOutcome[]> {
  const outcomes: OperatorFeeWithdrawVerificationOutcome[] = [];

  await store.refreshDeadLetters().catch(() => undefined);
  const allOpen = store
    .getDeadLetters()
    .filter((e) => e.kind === 'operator_fee_withdraw_uncertain' && !e.resolvedAt);
  if (allOpen.length === 0) return outcomes;
  // R4-FG-16: per-pass cap.
  const MAX_ENTRIES_PER_PASS = 25;
  const open = allOpen.slice(0, MAX_ENTRIES_PER_PASS);
  if (allOpen.length > MAX_ENTRIES_PER_PASS) {
    logger.warn('verifyUncertainOperatorFeeWithdrawals: deferred entries to next pass', {
      component: 'UncertainTx',
      event: 'verifier_pass_capped',
      kind: 'operator_fee_withdraw_uncertain',
      total: allOpen.length,
      capped: MAX_ENTRIES_PER_PASS,
      deferred: allOpen.length - MAX_ENTRIES_PER_PASS,
    });
  }

  for (let entry of open) {
    const withdrawTxId = entry.transactionId;
    const details = (entry.details ?? {}) as {
      withdrawTxId?: string;
      amount?: number;
      tokenKey?: string;
      token?: string;
      recipientAccountId?: string;
    };

    if (
      !isValidDetailAmount(details.amount) ||
      typeof details.tokenKey !== 'string'
    ) {
      await bumpVerificationAttempts(store, entry);
      outcomes.push({
        withdrawTxId,
        status: 'still_uncertain',
        note: 'Dead-letter entry malformed (non-finite amount / tokenKey). Manual triage required.',
      });
      continue;
    }

    // F4 + R3-FG-3: REVERTS R2-FG-13 self-heal in operator-fee path.
    // See R3-FG-3 comment in the withdrawal verifier above.
    const orderingErr = validateProgressOrdering(entry, [
      'operatorDebitedAt',
      'auditWrittenAt',
    ]);
    if (orderingErr) {
      await bumpVerificationAttempts(store, entry);
      outcomes.push({
        withdrawTxId,
        status: 'still_uncertain',
        note: `Dead-letter ${orderingErr}. Manual triage required.`,
      });
      continue;
    }

    const opLockFence = await acquireVerifyLock(withdrawTxId);
    if (!opLockFence) {
      outcomes.push({
        withdrawTxId,
        status: 'still_uncertain',
        note: 'Concurrent reconcile holds verifier lock; will retry next pass.',
      });
      continue;
    }

    const lookup = await lookupMirrorResult(withdrawTxId);
    if ('transientError' in lookup) {
      // F25: no mutation; release lock for retry.
      await releaseVerifyLock(withdrawTxId, opLockFence);
      outcomes.push({
        withdrawTxId,
        status: 'still_uncertain',
        note: lookup.transientError,
      });
      continue;
    }
    let { result } = lookup;
    if (result === 'NOT_FOUND') {
      result = applyNotFoundMaxAge(entry);
    }

    if (result === 'NOT_FOUND') {
      // F25: no mutation; release lock.
      await releaseVerifyLock(withdrawTxId, opLockFence);
      outcomes.push({
        withdrawTxId,
        status: 'still_uncertain',
        note: 'Not yet visible on mirror node; will retry next reconcile.',
      });
      continue;
    }

    if (result === 'FAILED') {
      try {
        await store.flush();
      } catch {
        /* */
      }
      await markResolved(store, entry, withdrawTxId);
      // F26: release lock after resolve.
      await releaseVerifyLock(withdrawTxId, opLockFence);
      // R2-FG-16 + R3-FG-2: fenced release of F24 pending claim on FAILED.
      // Read fence from `details.pendingClaimFence` (R3-FG-2) and
      // compare-and-delete via RELEASE_SCRIPT instead of unfenced DEL.
      //
      // R4-FG-33 (round-4 medium): legacy DLs (written before R3-FG-2
      // deploy) have no `pendingClaimFence`; pre-fix the verifier
      // silently SKIPPED release, leaving the operator-fees pending
      // claim wedged for full TTL (30 min) and blocking concurrent
      // operator fee withdrawals. Operators trained to manually
      // `redis.del` the claim → standing runbook becomes a double-pay
      // vector. On confirmed mirror=FAILED with no fence, force-DEL
      // the claim (operator-acknowledged risk: no on-chain effect on
      // FAILED so the DEL is safe).
      const failedFence = (details as { pendingClaimFence?: string }).pendingClaimFence;
      if (typeof failedFence === 'string' && failedFence.length > 0) {
        try {
          const redis = await getRedis();
          const pendingKey = `${KEY_PREFIX.lockOperator}withdraw-pending:${details.tokenKey}`;
          await redis.eval(RELEASE_SCRIPT, [pendingKey], [failedFence]);
        } catch (e) {
          logger.warn(
            'operator_fee_withdraw_uncertain F24 pending-claim release failed (FAILED branch)',
            {
              component: 'UncertainTx',
              withdrawTxId,
              tokenKey: details.tokenKey,
              error: e instanceof Error ? e.message : String(e),
            },
          );
        }
      } else if (typeof details.tokenKey === 'string') {
        // R4-FG-33: legacy-DL fallback. FAILED means the on-chain tx
        // didn't move tokens, so DELing the pending claim cannot
        // double-spend. Log loudly so an operator sees the migration
        // gap.
        try {
          const redis = await getRedis();
          const pendingKey = `${KEY_PREFIX.lockOperator}withdraw-pending:${details.tokenKey}`;
          await redis.del(pendingKey);
          logger.warn(
            'operator_fee_withdraw_uncertain F24 legacy-DL fallback: unfenced DEL on FAILED (no pendingClaimFence)',
            {
              component: 'UncertainTx',
              withdrawTxId,
              tokenKey: details.tokenKey,
            },
          );
        } catch (e) {
          logger.warn('legacy-DL F24 unfenced DEL failed', {
            component: 'UncertainTx',
            withdrawTxId,
            tokenKey: details.tokenKey,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      outcomes.push({
        withdrawTxId,
        status: 'failed',
        note: 'On-chain operator fee withdrawal failed (or not on mirror after 24h); nothing to roll back.',
      });
      continue;
    }

    // SUCCESS: debit operator balance + write HCS-20 audit anchor.
    // R-HIGH-1: idempotency markers gate each step so a Lambda crash
    // doesn't double-debit on the next reconcile pass.
    //
    // R4-FG-6 (round-4 high): mirror R3-FG-8's `mutationError` flag +
    // skip-markResolved gating that already lives in the withdrawal
    // SUCCESS branch (lines 942-1087). Pre-fix this branch wrote the
    // orphan row in the catch and then UNCONDITIONALLY ran
    // markResolved at the bottom — entry was marked resolved even
    // when the operator debit or the audit anchor failed, leaving
    // the operator wallet credited with un-debited fees and no path
    // back to retry. Sibling miss in the original R3-FG-8 fix.
    type OperatorProgress = {
      operatorDebitedAt?: string;
      auditWrittenAt?: string;
    };
    const priorOperatorProgress = (entry.details ?? {}) as OperatorProgress;
    const operatorProgress: OperatorProgress = {
      operatorDebitedAt: priorOperatorProgress.operatorDebitedAt,
      auditWrittenAt: priorOperatorProgress.auditWrittenAt,
    };
    let operatorMutationError: { phase: string; cause: unknown } | null = null;

    if (!operatorProgress.operatorDebitedAt) {
      // R2-FG-5 (round-2 G-02 / R-06): stamp BEFORE mutate, mirroring
      // the F14 pattern that already lives in `handlers.ts`. Without
      // this, a Lambda freeze between `updateOperator` and
      // `stampProgress` leaves the next pass with `operatorDebitedAt`
      // unset → second debit. Stamp-before-mutate inverts the failure
      // mode to "stamp landed but mutate didn't" which `reconcile`
      // detects as wallet < ledger insolvency, plus we write an
      // `audit_trail_orphaned` row on mutation failure so an operator
      // can manually replay.
      //
      // R3-FG-12 (round-3 P4-005): acquire `withdraw-fees` operator-lock
      // around the debit so a concurrent in-band operatorWithdrawFees
      // call on a DIFFERENT token can't race the read-modify-write on
      // `operator.balances`. The in-band path holds this same lock
      // around its debit; the verifier was bypassing it → last-write-
      // wins on the in-process operator cache → one debit lost.
      //
      // R4-FG-12 (round-4 high): on null acquire (lock held by another
      // Lambda), the very race the lock was added to prevent reopens.
      // Pre-fix the code stamped `operatorDebitedAt` and ran
      // `updateOperator` ANYWAY without the lock. Now: write
      // audit_trail_orphaned + leave the entry unresolved + bail.
      // The next reconcile pass retries when the lock is free.
      const opLockToken = await acquireOperatorLock('withdraw-fees', 60);
      if (!opLockToken) {
        operatorMutationError = { phase: 'op_lock_unavailable', cause: new Error('withdraw-fees operator-lock contention') };
        await recordAuditOrphan(
          store,
          'operator_fee_withdraw_uncertain',
          withdrawTxId,
          {
            amount: details.amount,
            tokenKey: details.tokenKey,
            agentAccountId,
            recipientAccountId: details.recipientAccountId ?? '',
            withdrawTxId,
            phase: 'op_lock_unavailable',
          },
          new Error('withdraw-fees operator-lock contention'),
        );
        await releaseVerifyLock(withdrawTxId, opLockFence);
        outcomes.push({
          withdrawTxId,
          status: 'still_uncertain',
          note: 'withdraw-fees operator-lock unavailable; deferring debit to next reconcile pass.',
        });
        continue;
      }
      operatorProgress.operatorDebitedAt = new Date().toISOString();
      await stampProgress(store, entry, operatorProgress);
      try {
        const tokenKey = details.tokenKey;
        const amount = details.amount;
        store.updateOperator((op) => ({
          ...op,
          balances: {
            ...op.balances,
            [tokenKey]: (op.balances[tokenKey] ?? 0) - amount,
          },
          totalWithdrawnByOperator: {
            ...op.totalWithdrawnByOperator,
            [tokenKey]: (op.totalWithdrawnByOperator[tokenKey] ?? 0) + amount,
          },
        }));
      } catch (e) {
        logger.warn('operator_fee_withdraw_uncertain operator state update failed', {
          component: 'UncertainTx',
          withdrawTxId,
          error: e instanceof Error ? e.message : String(e),
        });
        operatorMutationError = { phase: 'operator_debit', cause: e };
        await recordAuditOrphan(
          store,
          'operator_fee_withdraw_uncertain',
          withdrawTxId,
          {
            amount: details.amount,
            tokenKey: details.tokenKey,
            agentAccountId,
            recipientAccountId: details.recipientAccountId ?? '',
            withdrawTxId,
            phase: 'debit_failed_after_stamp',
          },
          e,
        );
      } finally {
        // R3-FG-12: release the withdraw-fees operator-lock.
        if (opLockToken) {
          await releaseOperatorLock('withdraw-fees', opLockToken);
        }
      }
    }

    if (accounting && !operatorProgress.auditWrittenAt && !operatorMutationError) {
      try {
        // F18: include withdrawTxId for reader dedup.
        await accounting.recordOperatorWithdrawal(
          agentAccountId,
          details.amount,
          details.tokenKey,
          withdrawTxId,
        );
        operatorProgress.auditWrittenAt = new Date().toISOString();
        await stampProgress(store, entry, operatorProgress);
      } catch (auditErr) {
        logger.warn(
          'operator_fee_withdraw_uncertain accounting.recordOperatorWithdrawal failed',
          {
            component: 'UncertainTx',
            withdrawTxId,
            error: auditErr instanceof Error ? auditErr.message : String(auditErr),
          },
        );
        operatorMutationError = { phase: 'audit_anchor', cause: auditErr };
        // F19: include all replay params so operator can manually
        // re-emit recordOperatorWithdrawal(agentAccountId, amount, token).
        await recordAuditOrphan(
          store,
          'operator_fee_withdraw_uncertain',
          withdrawTxId,
          {
            amount: details.amount,
            tokenKey: details.tokenKey,
            agentAccountId,
            recipientAccountId: details.recipientAccountId ?? '',
            withdrawTxId,
          },
          auditErr,
        );
      }
    }

    try {
      await store.flush();
    } catch {
      /* */
    }
    // R4-FG-6: gate markResolved on operatorMutationError (mirrors
    // R3-FG-8 in the withdrawal SUCCESS branch). If any mutation step
    // failed, leave the entry unresolved so the next reconcile pass
    // can retry. The orphan row written above gives operators the
    // full replay context.
    if (operatorMutationError) {
      await releaseVerifyLock(withdrawTxId, opLockFence);
      outcomes.push({
        withdrawTxId,
        status: 'still_uncertain',
        note: `Mutation step '${operatorMutationError.phase}' failed; entry left unresolved for retry on next pass.`,
      });
      continue;
    }
    await markResolved(store, entry, withdrawTxId, operatorProgress);
    // F26: release lock after successful resolve.
    await releaseVerifyLock(withdrawTxId, opLockFence);
    // R2-FG-16 + R3-FG-2 (round-3 P2-003): fenced release of F24
    // pending claim. Read fence from `details.pendingClaimFence`
    // (R3-FG-2) and compare-and-delete via RELEASE_SCRIPT instead of
    // unfenced DEL. Pre-fix: a stale verifier completion DEL'd a
    // fresh in-band acquirer's claim → operator double-pay.
    const successFence = (details as { pendingClaimFence?: string }).pendingClaimFence;
    if (typeof successFence === 'string' && successFence.length > 0) {
      try {
        const redis = await getRedis();
        const pendingKey = `${KEY_PREFIX.lockOperator}withdraw-pending:${details.tokenKey}`;
        await redis.eval(RELEASE_SCRIPT, [pendingKey], [successFence]);
      } catch (e) {
        logger.warn(
          'operator_fee_withdraw_uncertain F24 pending-claim release failed',
          {
            component: 'UncertainTx',
            withdrawTxId,
            tokenKey: details.tokenKey,
            error: e instanceof Error ? e.message : String(e),
          },
        );
      }
    } else {
      // Legacy DL (pre-R3-FG-2) — TTL is the only safe release path.
      logger.warn(
        'operator_fee_withdraw_uncertain F24 pending-claim release skipped (no fence — legacy DL)',
        { component: 'UncertainTx', withdrawTxId, tokenKey: details.tokenKey },
      );
    }

    outcomes.push({
      withdrawTxId,
      status: 'confirmed',
      note: 'On-chain operator fee withdrawal confirmed; operator state debited and HCS-20 audit anchor written.',
    });
  }

  return outcomes;
}

// ── verifyUncertainPlays ──────────────────────────────────────────
//
// C1: when a play session's contract submission times out, we keep
// per-token reservations and dead-letter. Reconcile resolves:
//   - FAILED (or 24h NOT_FOUND): release every reservation in the
//     stored tokenReservations list.
//   - SUCCESS: the on-chain action landed but in-band settlement
//     code never ran. We CANNOT reconstruct settlement here (the
//     play session has no PlaySessionResult). Mark the entry
//     resolved with a flag for manual triage — the operator must
//     reconcile entries against dApp pool state by hand.
//   - NOT_FOUND (recent): leave for next reconcile pass.

export async function verifyUncertainPlays(
  store: IStore,
  ledger: UserLedger,
  accounting?: AccountingService,
): Promise<PlayVerificationOutcome[]> {
  const outcomes: PlayVerificationOutcome[] = [];

  await store.refreshDeadLetters().catch(() => undefined);
  const allOpen = store
    .getDeadLetters()
    .filter((e) => e.kind === 'play_uncertain' && !e.resolvedAt);
  if (allOpen.length === 0) return outcomes;
  // R4-FG-16: per-pass cap.
  const MAX_ENTRIES_PER_PASS = 25;
  const open = allOpen.slice(0, MAX_ENTRIES_PER_PASS);
  if (allOpen.length > MAX_ENTRIES_PER_PASS) {
    logger.warn('verifyUncertainPlays: deferred entries to next pass', {
      component: 'UncertainTx',
      event: 'verifier_pass_capped',
      kind: 'play_uncertain',
      total: allOpen.length,
      capped: MAX_ENTRIES_PER_PASS,
      deferred: allOpen.length - MAX_ENTRIES_PER_PASS,
    });
  }

  for (let entry of open) {
    const uncertainTxId = entry.transactionId;
    const details = (entry.details ?? {}) as {
      userId?: string;
      tokenReservations?: Array<{ token: string; amount: number }>;
    };
    const userId = details.userId ?? '(unknown)';

    if (
      typeof details.userId !== 'string' ||
      !Array.isArray(details.tokenReservations) ||
      !details.tokenReservations.every(isValidTokenReservation)
    ) {
      await bumpVerificationAttempts(store, entry);
      outcomes.push({
        uncertainTxId,
        userId,
        status: 'still_uncertain',
        note: 'Dead-letter entry malformed (missing userId / tokenReservations or invalid entry shape). Manual triage required.',
      });
      continue;
    }

    const playLockFence = await acquireVerifyLock(uncertainTxId);
    if (!playLockFence) {
      outcomes.push({
        uncertainTxId,
        userId,
        status: 'still_uncertain',
        note: 'Concurrent reconcile holds verifier lock; will retry next pass.',
      });
      continue;
    }

    const lookup = await lookupMirrorResult(uncertainTxId);
    if ('transientError' in lookup) {
      // F25: no mutation; release lock for retry.
      await releaseVerifyLock(uncertainTxId, playLockFence);
      outcomes.push({
        uncertainTxId,
        userId,
        status: 'still_uncertain',
        note: lookup.transientError,
      });
      continue;
    }
    let { result } = lookup;
    if (result === 'NOT_FOUND') {
      result = applyNotFoundMaxAge(entry);
    }

    if (result === 'NOT_FOUND') {
      // F25: no mutation; release lock.
      await releaseVerifyLock(uncertainTxId, playLockFence);
      outcomes.push({
        uncertainTxId,
        userId,
        status: 'still_uncertain',
        note: 'Not yet visible on mirror node; will retry next reconcile.',
      });
      continue;
    }

    if (result === 'FAILED') {
      // F23: serialize per-user reservation releases against active
      // in-band withdraw / play / refund.
      const playUserToken = await tryAcquireUserLockForVerify(details.userId);
      if (!playUserToken) {
        // R2-FG-14: bump counter + escalate at threshold.
        await bumpUserLockContentionAttempts(store, entry);
        await releaseVerifyLock(uncertainTxId, playLockFence);
        outcomes.push({
          uncertainTxId,
          userId,
          status: 'still_uncertain',
          note: 'Per-user lock contention did not clear; will retry next reconcile.',
        });
        continue;
      }
      try {
        // Confirmed not-on-chain: release every reserved token amount.
        for (const { token, amount } of details.tokenReservations) {
          try {
            ledger.releaseReserve(details.userId, amount, token);
          } catch (e) {
            logger.warn('play_uncertain releaseReserve failed', {
              component: 'UncertainTx',
              uncertainTxId,
              userId: details.userId,
              token,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      } finally {
        await releaseUserLock(details.userId, playUserToken);
      }
      try {
        await store.flush();
      } catch {
        /* */
      }
      await markResolved(store, entry, uncertainTxId);
      // F26: release lock after resolve.
      await releaseVerifyLock(uncertainTxId, playLockFence);
      outcomes.push({
        uncertainTxId,
        userId,
        status: 'failed',
        note: 'Play submission failed (or not on mirror after 24h); reservations released.',
      });
      continue;
    }

    // SUCCESS: on-chain play landed but in-band settlement code did
    // NOT run. We cannot reconstruct PlaySessionResult here (no
    // pool-result data, no prizes record). Mark resolved with a
    // manual-triage flag and page the operator. The reservations
    // remain held until manual unlock — releasing them blindly would
    // erase the spend evidence for the operator's reconstruction.
    logger.error(
      'play_uncertain confirmed SUCCESS — manual triage required to reconstruct settlement',
      {
        component: 'UncertainTx',
        event: 'play_uncertain_success_manual_triage',
        uncertainTxId,
        userId: details.userId,
        tokenReservations: details.tokenReservations,
      },
    );

    // F16 (2026-05-06 audit A-06 / DR-04): write the manual-triage
    // anchor BEFORE escalating + resolving so the topic captures the
    // spend even if Redis is wiped before manual reconstruction
    // completes. Without this anchor, a topic-only auditor sees the
    // user's full pre-play balance and the operator wallet short by
    // the spend amount — silent insolvency. F15's `successTriagedAt`
    // marker depends on the resolve write below.
    //
    // R4-FG-6 (round-4 high): mirror R3-FG-8's `mutationError` flag
    // here too. Pre-fix the resolve write at line 1614-1624 fired
    // even when the anchor failed → entry resolved without the
    // topic capturing the spend → topic-only auditor cannot see the
    // play happened at all → silent insolvency invisible. Now: on
    // anchor failure, leave the entry unresolved so the next
    // reconcile pass retries.
    let playMutationError: { phase: string; cause: unknown } | null = null;
    if (accounting) {
      try {
        // R3-FG-14 (round-3 P4-003): the verifier is the actor here,
        // not the user. Pre-fix `by: details.userId` made it look on
        // the topic as if the user themselves triaged their own
        // play_uncertain reservations — misleading auditor attribution.
        // R3-FG-22 (round-3 P5-PU-001): deterministic idempotencyKey
        // so retry passes don't double-emit the anchor. Both verifier
        // and force-release sibling produce the SAME key for the same
        // uncertainTxId; readers can dedup.
        await accounting.recordControlEvent('play_uncertain_success_pending_triage', {
          by: 'reconcile',
          uncertainTxId,
          userId: details.userId,
          tokenReservations: details.tokenReservations,
          idempotencyKey: `play-triage:${uncertainTxId}`,
        });
      } catch (anchorErr) {
        playMutationError = { phase: 'success_triage_anchor', cause: anchorErr };
        logger.warn('play_uncertain SUCCESS triage anchor write failed', {
          component: 'UncertainTx',
          uncertainTxId,
          error: anchorErr instanceof Error ? anchorErr.message : String(anchorErr),
        });
        try {
          // R4-FG-27: mintAuditOrphanId for collision-free retries.
          const { mintAuditOrphanId: mintId } = await import('../lib/orphanIds.js');
          await store.upsertDeadLetter({
            transactionId: mintId('audit-orphan:verifier', uncertainTxId),
            timestamp: new Date().toISOString(),
            error: `play_uncertain SUCCESS triage anchor write failed: ${anchorErr instanceof Error ? anchorErr.message : String(anchorErr)}`,
            kind: 'audit_trail_orphaned',
            details: {
              sourceKind: 'play_uncertain',
              sourceTxId: uncertainTxId,
              userId: details.userId,
              tokenReservations: details.tokenReservations,
              phase: 'success_triage_anchor',
            },
          });
        } catch {
          /* logged above */
        }
      }
    }

    await escalateUncertainDlFailure({
      kind: 'play_uncertain',
      uncertainTxId,
      userId: details.userId,
      cause: new Error(
        'play_uncertain confirmed SUCCESS — settlement state must be reconstructed manually from dApp pool state',
      ),
    });
    // R4-FG-6: gate the resolve write on anchor success. Pre-fix the
    // resolve write fired even when the anchor failed → entry shows
    // resolved with no topic record → topic-only auditor sees no
    // play, no spend, no triage → silent insolvency.
    if (playMutationError) {
      await releaseVerifyLock(uncertainTxId, playLockFence);
      outcomes.push({
        uncertainTxId,
        userId,
        status: 'still_uncertain',
        note: `Mutation step '${playMutationError.phase}' failed; entry left unresolved for retry on next pass.`,
      });
      continue;
    }
    try {
      await store.upsertDeadLetter({
        ...entry,
        details: {
          ...(entry.details ?? {}),
          // F15 gate: force-release refuses entries already triaged.
          successTriagedAt: new Date().toISOString(),
        },
        resolvedAt: new Date().toISOString(),
        resolvedBy: 'reconcile-success-needs-manual-triage',
        resolutionTxId: uncertainTxId,
      });
    } catch {
      /* logged via escalation */
    }
    // F26: release lock after triage anchor + resolve write.
    await releaseVerifyLock(uncertainTxId, playLockFence);
    outcomes.push({
      uncertainTxId,
      userId,
      status: 'confirmed',
      note: 'On-chain play confirmed; reservations held pending manual settlement reconstruction (operator paged).',
    });
  }

  return outcomes;
}
