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
