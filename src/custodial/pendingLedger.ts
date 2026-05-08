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

    // R5-FG-4 (P3-001 + P5-RU-003): SET-NX a per-(userId, sourceTx)
    // atomic claim before mutating. Pre-fix two concurrent drain
    // passes (eager inside withUserLock for Lambda A, periodic
    // reconcile on Lambda B) both LRANGE'd, captured overlapping
    // snapshots, and after Lambda A LREM'd, Lambda B's snapshot still
    // contained the row — so B re-applied the debit + rake reversal.
    // The user lock is RELEASED between A and B's acquires, so the
    // lock alone doesn't serialize. Now: claim atomically before the
    // mutation; LREM is belt-and-braces; 7d TTL bounds the claim.
    const claimKey = `${KEY_PREFIX.pendingLedgerClaim}${entry.userId}:${entry.sourceTx}`;
    const claimed = await redis
      .set(claimKey, '1', { nx: true, ex: 7 * 24 * 60 * 60 })
      .catch(() => null);
    if (claimed === null) {
      // Another drain pass already claimed this entry. Skip the
      // mutation; that pass will LREM. Belt-and-braces: also LREM in
      // case the claimer crashed mid-flight (leaving the row), since
      // the claim's 7d TTL keeps re-application safe.
      const removeRaw = typeof row === 'string' ? row : JSON.stringify(row);
      await redis.lrem(LIST_KEY, 1, removeRaw).catch(() => 0);
      continue;
    }

    try {
      const user = store.getUser(entry.userId);
      if (!user) {
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

      store.updateBalance(entry.userId, (b) => {
        const tokenEntry = b.tokens[entry.tokenKey];
        if (!tokenEntry) return b;
        tokenEntry.available = Math.max(0, tokenEntry.available - entry.amount);
        return b;
      });

      // R4-FG-13: apply the operator-rake reversal too. Pre-fix the
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

      const removeRaw = typeof row === 'string' ? row : JSON.stringify(row);
      await redis.lrem(LIST_KEY, 1, removeRaw).catch(() => 0);

      // R5-FG-61 (P5-RU-002): flush after lrem so a sibling Lambda
      // or cold-start reads the post-mutation state. Pre-fix the
      // periodic drain flushed but the eager path didn't; sibling
      // Lambdas could read stale Redis with the queue entry already
      // applied locally but not yet persisted.
      await store.flush().catch((flushErr) => {
        logger.warn('eager pending ledger flush failed', {
          component: 'PendingLedger',
          userId: entry.userId,
          sourceTx: entry.sourceTx,
          error: flushErr instanceof Error ? flushErr.message : String(flushErr),
        });
      });

      applied++;
      logger.info('pending ledger adjustment applied (eager)', {
        component: 'PendingLedger',
        event: 'pending_ledger_applied_eager',
        userId: entry.userId,
        amount: entry.amount,
        token: entry.tokenKey,
        sourceTx: entry.sourceTx,
      });
    } catch (err) {
      failed++;
      logger.error('eager pending ledger apply failed', {
        component: 'PendingLedger',
        userId: entry.userId,
        sourceTx: entry.sourceTx,
        error: err,
      });
    }
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

    // R5-FG-4: per-(userId, sourceTx) claim. See `applyPendingLedgerForUser`.
    const claimKey = `${KEY_PREFIX.pendingLedgerClaim}${entry.userId}:${entry.sourceTx}`;
    const claimed = await redis
      .set(claimKey, '1', { nx: true, ex: 7 * 24 * 60 * 60 })
      .catch(() => null);
    if (claimed === null) {
      // Sibling drain already applied (or is mid-apply). Best-effort
      // LREM in case the row was left behind, then release the lock.
      const removeRaw = typeof row === 'string' ? row : JSON.stringify(row);
      await redis.lrem(LIST_KEY, 1, removeRaw).catch(() => 0);
      await releaseUserLock(entry.userId, lockToken);
      continue;
    }

    try {
      // Refresh the user from the store before mutating, so we don't
      // clobber concurrent balance changes.
      await store.refreshUser(entry.userId);
      const user = store.getUser(entry.userId);
      if (!user) {
        // User was deleted since the entry was queued — drop it and log.
        const removeRaw =
          typeof row === 'string' ? row : JSON.stringify(row);
        await redis.lrem(LIST_KEY, 1, removeRaw).catch(() => 0);
        result.failed++;
        logger.warn('pending ledger entry dropped — user not found', {
          component: 'PendingLedger',
          userId: entry.userId,
          sourceTx: entry.sourceTx,
        });
        continue;
      }

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

      // Remove exactly this entry from the list (count=1)
      const removeRaw = typeof row === 'string' ? row : JSON.stringify(row);
      await redis.lrem(LIST_KEY, 1, removeRaw).catch(() => 0);

      result.applied++;
      logger.info('pending ledger adjustment applied', {
        component: 'PendingLedger',
        event: 'pending_ledger_applied',
        userId: entry.userId,
        amount: entry.amount,
        token: entry.tokenKey,
        sourceTx: entry.sourceTx,
      });
    } catch (err) {
      result.failed++;
      logger.error('pending ledger drain failed for entry', {
        component: 'PendingLedger',
        userId: entry.userId,
        sourceTx: entry.sourceTx,
        error: err,
      });
    } finally {
      await releaseUserLock(entry.userId, lockToken);
    }
  }

  return result;
}
