/**
 * pendingLedger — queue for ledger adjustments that couldn't be applied
 * inline due to per-user lock contention.
 *
 * The refund path needs to debit a user's `available` balance after an
 * on-chain refund settles. If the user is mid-play or mid-withdraw when
 * the refund runs, the per-user lock is held and we cannot apply the
 * debit immediately. Since the on-chain refund has already settled,
 * silently dropping the debit would create phantom funds (the user
 * could spend the refunded amount twice).
 *
 * Instead, we push the adjustment onto a Redis list keyed by userId.
 * A drain sweep (called at the start of reconciliation and available
 * as an admin action) walks the queue, tries to acquire the user lock,
 * and applies each pending entry.
 *
 * Design notes:
 *   - Redis LIST (rpush / lrange / lrem) so queue order is preserved.
 *   - Entries JSON-serialized with the full adjustment payload.
 *   - Idempotency is ensured by removing the specific entry (LREM
 *     with count=1) only after a successful store mutation.
 *   - If the list is unreachable we escalate with a logger.error so
 *     the operator can intervene before money moves — no silent loss.
 */

import type { IStore } from './IStore.js';
import { getRedis, KEY_PREFIX } from '../auth/redis.js';
import { acquireUserLock, releaseUserLock } from '../lib/locks.js';
import { fencedClaim } from '../lib/fencedClaim.js';
import { logger } from '../lib/logger.js';

// ── Types ───────────────────────────────────────────────────────

export interface PendingLedgerAdjustment {
  /** User ID this adjustment applies to. */
  userId: string;
  /** Token key (e.g. 'hbar' or token ID). */
  tokenKey: string;
  /**
   * Amount to deduct from available (always positive — a future
   * credit adjustment would get a separate type field). Human units,
   * not base units.
   */
  amount: number;
  /** What produced this pending adjustment. */
  reason: 'refund';
  /** Originating transaction ID for audit trail. */
  sourceTx: string;
  /** ISO timestamp when queued. */
  createdAt: string;
  /**
   * R4-FG-13 (round-4 high): operator-rake reversal for refunds that
   * originally credited rake. Pre-fix the queue applied only
   * `available -= amount`; the corresponding reduction of
   * `operator.balances[token]` was lost when the verifier path
   * couldn't acquire the inner lock and queued instead. Operator
   * silently kept the rake despite the refund. Optional because
   * not every refund had rake (e.g. legacy 0% deposits).
   */
  rakeReversal?: {
    tokenKey: string;
    amount: number;
  };
}

// ── Keys ────────────────────────────────────────────────────────

const LIST_KEY = KEY_PREFIX.pendingLedger;

// ── Queue ───────────────────────────────────────────────────────

/**
 * Append a pending adjustment to the queue.
 * Throws on failure — callers must handle (the refund path escalates
 * with logger.error so the operator sees it).
 */
export async function queuePendingLedgerAdjustment(
  entry: PendingLedgerAdjustment,
): Promise<void> {
  const redis = await getRedis();
  await redis.rpush(LIST_KEY, JSON.stringify(entry));
}

/**
 * Peek at the current queue length. Non-blocking; used for reporting.
 */
export async function getPendingLedgerCount(): Promise<number> {
  try {
    const redis = await getRedis();
    return await redis.llen(LIST_KEY);
  } catch {
    return 0;
  }
}

/**
 * Return a snapshot of all pending entries without removing them.
 * Used by the admin UI to show what's queued.
 */
export async function listPendingLedgerAdjustments(): Promise<
  PendingLedgerAdjustment[]
> {
  try {
    const redis = await getRedis();
    const raw = await redis.lrange(LIST_KEY, 0, -1);
    const entries: PendingLedgerAdjustment[] = [];
    for (const row of raw) {
      try {
        // Upstash auto-parses JSON values; accept both shapes.
        const parsed = typeof row === 'string' ? JSON.parse(row) : row;
        if (isPendingLedgerAdjustment(parsed)) entries.push(parsed);
      } catch {
        /* skip malformed row */
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function isPendingLedgerAdjustment(v: unknown): v is PendingLedgerAdjustment {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.userId === 'string' &&
    typeof o.tokenKey === 'string' &&
    typeof o.amount === 'number' &&
    typeof o.sourceTx === 'string'
  );
}

// ── Drain ───────────────────────────────────────────────────────

export interface DrainResult {
  attempted: number;
  applied: number;
  deferred: number;
  failed: number;
}

/**
 * Walk the pending queue, attempting to apply each entry.
 *
 * For each entry:
 *   1. Acquire the per-user lock (short TTL — drain is fast)
 *   2. If acquired: apply the debit, LREM the entry, release
 *   3. If not acquired: leave the entry in place for the next drain
 *
 * Safe to call concurrently — the per-user lock serializes writes.
 * Call at the start of reconciliation and expose via an admin route.
 */
/**
 * Apply pending ledger adjustments for a SINGLE user. The caller MUST
 * already hold `acquireUserLock(userId)` — this function does not
 * acquire it. Called from `withUserLock` (eager drain on every lock
 * acquisition) so refund-queued debits land before the lock holder
 * reads `user.balances`.
 *
 * Without this, the gap between a refund queueing a pending debit
 * (because it couldn't acquire the user lock) and the next reconcile
 * cron (~hourly) was a window in which the user could withdraw the
 * refunded funds again — double-spend.
 *
 * Failure mode: if Redis is unreachable we return zero counts. The
 * caller's `await store.refreshUser` runs first, so a Redis failure
 * here doesn't poison the local cache.
 */
export async function applyPendingLedgerForUser(
  store: IStore,
  userId: string,
): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;

  let redis;
  try {
    redis = await getRedis();
  } catch {
    return { applied: 0, failed: 0 };
  }

  const rawEntries = await redis
    .lrange(LIST_KEY, 0, -1)
    .catch(() => [] as unknown[]);

  for (const row of rawEntries) {
    let entry: PendingLedgerAdjustment;
    try {
      const parsed = typeof row === 'string' ? JSON.parse(row) : row;
      if (!isPendingLedgerAdjustment(parsed)) {
        failed++;
        continue;
      }
      entry = parsed;
    } catch {
      failed++;
      continue;
    }

    // Filter to the requested user only.
    if (entry.userId !== userId) continue;

    // R5-FG-4 (P3-001 + P5-RU-003) + R6-FG-12 + R6-Phase-4: claim
    // ownership of this row before mutating. Pre-fix two concurrent
    // drain passes (eager inside withUserLock for Lambda A, periodic
    // reconcile on Lambda B) both LRANGE'd, captured overlapping
    // snapshots, and after Lambda A LREM'd, Lambda B's snapshot still
    // contained the row — so B re-applied the debit + rake reversal.
    //
    // R6-FG-12 found the prior implementation hand-rolled
    // `redis.set(claimKey, '1', {nx:true, ex:7d})` with NO fence
    // token: any mutation failure left the claim stuck for 7 days
    // AND left the LIST row in place. The next drain saw the held
    // claim, took the "sibling already applied" branch, and LREM'd
    // the row → debit silently lost.
    //
    // R6-Phase-4 routes the claim through `fencedClaim`: a
    // mutation throw inside the body releases the claim via
    // compare-and-DEL so the next drain pass can retry. The LIST
    // row is only LREM'd inside the fenced body, AFTER the
    // store mutation succeeds.
    const claimKey = `${KEY_PREFIX.pendingLedgerClaim}${entry.userId}:${entry.sourceTx}`;
    // R9-FG-6 / Phase-7 Cluster E: idempotency anchor on (userId, sourceTx).
    // No TTL — once a row is applied, it's applied forever.
    const appliedKey = `${KEY_PREFIX.pendingLedgerApplied}${entry.userId}:${entry.sourceTx}`;
    let outcome;
    try {
      outcome = await fencedClaim(
        claimKey,
        async () => {
          // R9-FG-6 / Phase-7 Cluster E: SADD-membership check BEFORE
          // mutation. Pre-Phase-7 the body assumed bodies are
          // idempotent, but Lambda crash mid-mutation (between
          // updateBalance and lrem) leaves balance debited, row in
          // queue, claim held. After 7-day TTL, sibling re-acquires,
          // re-runs body → double-debit. Now: check the applied-set
          // first; if present, the prior body succeeded but didn't
          // get to LREM the row — we just LREM and return without
          // re-applying.
          const alreadyApplied = await redis.sismember(KEY_PREFIX.pendingLedgerAppliedSet, `${entry.userId}:${entry.sourceTx}`);
          if (alreadyApplied === 1) {
            const removeRaw = typeof row === 'string' ? row : JSON.stringify(row);
            await redis.lrem(LIST_KEY, 1, removeRaw).catch(() => 0);
            return { ok: false as const, reason: 'already-applied' as const };
          }

          const user = store.getUser(entry.userId);
          if (!user) {
            // User was deleted since the entry was queued — drop it.
            // We're inside the fenced body so the claim is held;
            // return a marker to let the outer scope LREM + log.
            return { ok: false as const, reason: 'user-not-found' as const };
          }

          // R10-FG-1 / Phase-8 Cluster D + R11-FG-4 / Phase-9 Cluster D:
          // SADD goes FIRST, BEFORE any in-memory mutation. Pre-Phase-9
          // the order was updateBalance → SADD → flush → LREM: a SADD
          // throw left the in-memory cache dirty (debit applied, no
          // anchor, flush never ran). withUserLock's outer catch then
          // continued into `fn()` against the dirty live state; the
          // post-body `store.flush()` at locks.ts:197 committed the
          // dirty cache to persisted state — DOUBLE-DEBIT through a
          // sibling channel R10-FG-1 didn't address.
          //
          // Post-fix (Phase-9): SADD-before-mutation. If SADD throws,
          // no in-memory mutation has happened, so the dirty-cache
          // bleed-into-fn() path doesn't exist. The flush-throw branch
          // (after SADD + updateBalance both ran) is still acceptable:
          // applied-set anchor is set, so next drain takes the
          // already-applied branch and doesn't re-debit even if the
          // flush eventually retries via withUserLock's flush.
          //
          //   - SADD throws → body propagates → fencedClaim releases →
          //     outer try/catch logs and continues. Live cache clean,
          //     persisted clean, anchor empty, row queued. Next drain
          //     replays cleanly.
          //   - flush throws after SADD+updateBalance → body propagates
          //     → outer catch continues. Live dirty, persisted clean,
          //     anchor SET. withUserLock continues; fn() reads dirty
          //     live (over-conservatively) and locks.ts:197 flushes;
          //     persisted catches up. Next drain SISMEMBER=1 →
          //     already-applied → no re-debit. No double-debit possible.
          //   - LREM keeps `.catch(() => 0)`; idempotent under
          //     SISMEMBER=1 already-applied recovery.
          await redis.sadd(
            KEY_PREFIX.pendingLedgerAppliedSet,
            `${entry.userId}:${entry.sourceTx}`,
          );

          // SADD landed; only NOW mutate the in-memory cache. A throw
          // from any of these (e.g. updater bug, getUser race) leaves
          // the anchor set and live possibly partially mutated; the
          // next drain takes the already-applied branch via SISMEMBER
          // and the operational hold is the lesser evil compared to
          // double-debit.
          store.updateBalance(entry.userId, (b) => {
            const tokenEntry = b.tokens[entry.tokenKey];
            if (!tokenEntry) return b;
            tokenEntry.available = Math.max(0, tokenEntry.available - entry.amount);
            return b;
          });

          // R4-FG-13: apply the operator-rake reversal. Pre-fix the
          // operator silently retained rake when the refund was queued.
          if (entry.rakeReversal && entry.rakeReversal.amount > 0) {
            const rakeKey = entry.rakeReversal.tokenKey;
            const rakeAmt = entry.rakeReversal.amount;
            store.updateOperator((op) => ({
              ...op,
              balances: {
                ...op.balances,
                [rakeKey]: Math.max(0, (op.balances[rakeKey] ?? 0) - rakeAmt),
              },
              totalRakeCollected: {
                ...op.totalRakeCollected,
                [rakeKey]: Math.max(0, (op.totalRakeCollected[rakeKey] ?? 0) - rakeAmt),
              },
            }));
          }

          await store.flush();

          const removeRaw = typeof row === 'string' ? row : JSON.stringify(row);
          await redis.lrem(LIST_KEY, 1, removeRaw).catch(() => 0);

          return { ok: true as const };
        },
        { ttlSec: 7 * 24 * 60 * 60, context: 'pending-ledger-eager' },
      );
    } catch (err) {
      // fencedClaim only rethrows on PreserveClaimError. The body
      // doesn't submit on-chain actions so this branch is impossible
      // in practice, but if it ever fires we propagate so callers
      // see the failure instead of silently corrupting the queue.
      failed++;
      logger.error('eager pending ledger apply failed (preserve-claim)', {
        component: 'PendingLedger',
        userId: entry.userId,
        sourceTx: entry.sourceTx,
        error: err,
      });
      continue;
    }

    if (outcome.kind === 'busy') {
      // R8-FG-7 / Phase-6 Cluster E: do NOT LREM here. Pre-fix this
      // branch best-effort LREM'd the LIST row "in case the sibling
      // crashed mid-flight". But fencedClaim's catch path releases
      // the claim on ANY non-preserve throw — release happens
      // EXACTLY when the in-body LREM did NOT run. So a Lambda B
      // that sees `kind:'busy'` while Lambda A is mid-body, then A
      // throws non-preserve, would: A releases the claim → B has
      // already removed the LIST row → next drain sees nothing to
      // process → user's debit silently lost. The exact R6-FG-12
      // archetype in a slightly different shape.
      //
      // Correct behavior: leave the row in place. A's release means
      // the next drain pass re-acquires the claim and processes
      // the row to completion. The fence guarantees serialization,
      // not LREM ordering.
      continue;
    }

    if (!outcome.result.ok) {
      // user-not-found path: drop the row + log.
      const removeRaw = typeof row === 'string' ? row : JSON.stringify(row);
      await redis.lrem(LIST_KEY, 1, removeRaw).catch(() => 0);
      failed++;
      logger.warn('pending ledger entry dropped — user not found', {
        component: 'PendingLedger',
        userId: entry.userId,
        sourceTx: entry.sourceTx,
      });
      continue;
    }

    applied++;
    logger.info('pending ledger adjustment applied (eager)', {
      component: 'PendingLedger',
      event: 'pending_ledger_applied_eager',
      userId: entry.userId,
      amount: entry.amount,
      token: entry.tokenKey,
      sourceTx: entry.sourceTx,
    });
  }

  return { applied, failed };
}

export async function drainPendingLedgerAdjustments(
  store: IStore,
): Promise<DrainResult> {
  const result: DrainResult = {
    attempted: 0,
    applied: 0,
    deferred: 0,
    failed: 0,
  };

  let redis;
  try {
    redis = await getRedis();
  } catch {
    return result;
  }

  const rawEntries = await redis.lrange(LIST_KEY, 0, -1).catch(() => [] as unknown[]);

  for (const row of rawEntries) {
    result.attempted++;
    let entry: PendingLedgerAdjustment;
    try {
      const parsed = typeof row === 'string' ? JSON.parse(row) : row;
      if (!isPendingLedgerAdjustment(parsed)) {
        result.failed++;
        continue;
      }
      entry = parsed;
    } catch {
      result.failed++;
      continue;
    }

    // Try to acquire the user lock with a short TTL — if we can't, the
    // user is actively doing something; leave the entry for next drain.
    const lockToken = await acquireUserLock(entry.userId, 30);
    if (!lockToken) {
      result.deferred++;
      continue;
    }

    // R5-FG-4 + R6-FG-12 + R6-Phase-4: route the per-(userId, sourceTx)
    // claim through `fencedClaim`. See `applyPendingLedgerForUser`
    // for the full archetype rationale. Pre-fix the hand-rolled
    // `redis.set(claimKey, '1', { nx: true, ex: 7d })` left the
    // claim stuck for 7d on a mutation throw.
    const claimKey = `${KEY_PREFIX.pendingLedgerClaim}${entry.userId}:${entry.sourceTx}`;
    let outcome;
    try {
      outcome = await fencedClaim(
        claimKey,
        async () => {
          // R9-FG-6 / Phase-7 Cluster E: SADD-membership idempotency
          // check (see eager-path body for full rationale).
          const alreadyApplied = await redis.sismember(
            KEY_PREFIX.pendingLedgerAppliedSet,
            `${entry.userId}:${entry.sourceTx}`,
          );
          if (alreadyApplied === 1) {
            const removeRaw = typeof row === 'string' ? row : JSON.stringify(row);
            await redis.lrem(LIST_KEY, 1, removeRaw).catch(() => 0);
            return { ok: false as const, reason: 'already-applied' as const };
          }

          // Refresh the user from the store before mutating so we don't
          // clobber concurrent balance changes.
          await store.refreshUser(entry.userId);
          const user = store.getUser(entry.userId);
          if (!user) {
            return { ok: false as const, reason: 'user-not-found' as const };
          }

          // R10-FG-1 / Phase-8 Cluster D + R11-FG-4 / Phase-9 Cluster D:
          // SADD goes BEFORE updateBalance so a SADD throw never leaves
          // dirty in-memory state. Mirrors the eager path's fix; see
          // its full rationale at the corresponding site above.
          // Periodic path's user-lock contract (acquireUserLock at the
          // outer drain loop) means the dirty-cache bleed-into-fn()
          // hazard the eager path described doesn't apply here, but
          // the consistency of "SADD first, mutate second" is worth
          // having across both paths.
          await redis.sadd(
            KEY_PREFIX.pendingLedgerAppliedSet,
            `${entry.userId}:${entry.sourceTx}`,
          );

          store.updateBalance(entry.userId, (b) => {
            const tokenEntry = b.tokens[entry.tokenKey];
            if (!tokenEntry) return b;
            tokenEntry.available = Math.max(0, tokenEntry.available - entry.amount);
            return b;
          });

          // R4-FG-13: apply rake reversal in the periodic drain path too.
          // R5-FG-96 (P3-014): cross-check the queued rakeAmount against
          // the deposit record's current rakeAmount. The two should match
          // (the queue snapshot was built from the same DepositRecord),
          // but operator-side migrations or hand-edits could drift the
          // values; if they differ we use the deposit record's value
          // (canonical) and log a warning.
          if (entry.rakeReversal && entry.rakeReversal.amount > 0) {
            const rakeKey = entry.rakeReversal.tokenKey;
            let rakeAmt = entry.rakeReversal.amount;
            if (store.getDepositByTxId) {
              try {
                const dep = await store.getDepositByTxId(entry.sourceTx);
                if (dep && typeof dep.rakeAmount === 'number' && dep.rakeAmount !== rakeAmt) {
                  logger.warn('pending ledger rake amount drifted from deposit record', {
                    component: 'PendingLedger',
                    event: 'pending_ledger_rake_drift',
                    userId: entry.userId,
                    sourceTx: entry.sourceTx,
                    queuedAmount: rakeAmt,
                    depositRecordAmount: dep.rakeAmount,
                  });
                  rakeAmt = dep.rakeAmount;
                }
              } catch {
                /* deposit record lookup is advisory; proceed with queued amount */
              }
            }
            store.updateOperator((op) => ({
              ...op,
              balances: {
                ...op.balances,
                [rakeKey]: Math.max(0, (op.balances[rakeKey] ?? 0) - rakeAmt),
              },
              totalRakeCollected: {
                ...op.totalRakeCollected,
                [rakeKey]: Math.max(0, (op.totalRakeCollected[rakeKey] ?? 0) - rakeAmt),
              },
            }));
          }
          await store.flush();
          // Remove exactly this entry from the list (count=1).
          const removeRaw = typeof row === 'string' ? row : JSON.stringify(row);
          await redis.lrem(LIST_KEY, 1, removeRaw).catch(() => 0);
          return { ok: true as const };
        },
        { ttlSec: 7 * 24 * 60 * 60, context: 'pending-ledger-periodic' },
      );
    } catch (err) {
      // PreserveClaim path is impossible here (no on-chain action),
      // but propagate just in case so the operator sees it.
      result.failed++;
      logger.error('pending ledger drain failed (preserve-claim path)', {
        component: 'PendingLedger',
        userId: entry.userId,
        sourceTx: entry.sourceTx,
        error: err,
      });
      await releaseUserLock(entry.userId, lockToken);
      continue;
    }

    if (outcome.kind === 'busy') {
      // R8-FG-7 / Phase-6 Cluster E: do NOT LREM here. See the
      // identical fix in `applyPendingLedgerForUser`. Removing
      // the row before the sibling's body completes (or after
      // the sibling's catch released the claim without LREMing)
      // silently loses the user debit. Leave the row in place so
      // the next drain pass re-acquires and processes it.
      await releaseUserLock(entry.userId, lockToken);
      continue;
    }

    if (!outcome.result.ok) {
      const removeRaw = typeof row === 'string' ? row : JSON.stringify(row);
      await redis.lrem(LIST_KEY, 1, removeRaw).catch(() => 0);
      await releaseUserLock(entry.userId, lockToken);
      result.failed++;
      logger.warn('pending ledger entry dropped — user not found', {
        component: 'PendingLedger',
        userId: entry.userId,
        sourceTx: entry.sourceTx,
      });
      continue;
    }

    result.applied++;
    logger.info('pending ledger adjustment applied', {
      component: 'PendingLedger',
      event: 'pending_ledger_applied',
      userId: entry.userId,
      amount: entry.amount,
      token: entry.tokenKey,
      sourceTx: entry.sourceTx,
    });
    await releaseUserLock(entry.userId, lockToken);
  }

  return result;
}
