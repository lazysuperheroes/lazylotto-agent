/**
 * Distributed locks for preventing concurrent write-path operations.
 *
 * Uses atomic SET NX EX with a unique fence token per acquirer, and
 * releases via a compare-and-delete Lua script so a stale owner
 * (one whose lease has expired and whose work got forcibly cut short)
 * cannot accidentally release a newer owner's lock.
 *
 * This is the standard "correct" distributed lock minus Redlock-style
 * multi-node replication — Upstash Redis is a single replicated cluster,
 * so a single SET NX is sufficient for our serverless "prevent
 * concurrent play/withdraw/refund per user" use case.
 *
 * Lives in `src/lib/` (not `app/api/_lib/`) so that both CLI code paths
 * (MCP tools, refund logic) and Next.js API routes can import the same
 * implementation. In local CLI dev without Redis, `getRedis()` falls
 * back to the in-memory store defined in `src/auth/redis.ts`, which
 * honours SET NX and the compare-and-delete eval script.
 *
 * Usage:
 *   const token = await acquireUserLock(userId);
 *   if (!token) return 'locked by another operation';
 *   try {
 *     // do the thing
 *   } finally {
 *     await releaseUserLock(userId, token);
 *   }
 */

import { randomUUID } from 'node:crypto';
import { getRedis, KEY_PREFIX } from '../auth/redis.js';
import type { IStore } from '../custodial/IStore.js';

const USER_LOCK_PREFIX = KEY_PREFIX.lockUser;
const OPERATOR_LOCK_PREFIX = KEY_PREFIX.lockOperator;

/** Lua: delete the key only if its value matches the expected token. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

// ── User locks ──────────────────────────────────────────────────

/**
 * Attempt to acquire a distributed lock for a user.
 * Returns a fence token string on success, or null if the lock is held.
 * The caller MUST pass the returned token back to releaseUserLock().
 *
 * @param userId - The user ID to lock
 * @param ttlSec - Lock TTL in seconds (default 300 = 5 min)
 */
export async function acquireUserLock(
  userId: string,
  ttlSec = 300,
): Promise<string | null> {
  const redis = await getRedis();
  const key = `${USER_LOCK_PREFIX}${userId}`;
  const token = randomUUID();

  // Atomic SET NX EX — returns 'OK' on success, null on conflict
  const result = await redis.set(key, token, { ex: ttlSec, nx: true });
  return result ? token : null;
}

/**
 * Release a distributed lock for a user.
 * The token must match the one returned by acquireUserLock, otherwise
 * the release is a no-op (prevents releasing someone else's lock after
 * your own lease expired).
 */
export async function releaseUserLock(
  userId: string,
  token: string,
): Promise<void> {
  const redis = await getRedis();
  const key = `${USER_LOCK_PREFIX}${userId}`;
  try {
    await redis.eval(RELEASE_SCRIPT, [key], [token]);
  } catch (err) {
    // Lock release is best-effort — worst case it TTL-expires naturally
    console.warn('[locks] user release failed:', err);
  }
}

/**
 * Higher-level user-lock helper that closes three subtle exposures the
 * raw `acquireUserLock` / `releaseUserLock` pair leaves open:
 *
 * 1. **Stale local cache.** When a different Lambda releases the lock
 *    after a balance update, our local `users[userId]` still holds the
 *    pre-update view. `await store.refreshUser(userId)` fetches the
 *    canonical Redis state before the body runs.
 *
 * 2. **Pending-ledger drift.** Refunds that couldn't acquire the lock
 *    queue a debit to `pendingLedger`. Pre-fix, drain only ran on the
 *    hourly reconcile cron — leaving an up-to-1-hour window where the
 *    user could withdraw the refunded funds again. We drain matching
 *    entries inside this lock so the body sees the post-drain balance.
 *
 * 3. **Lock release before flush.** The route's `releaseUserLock`
 *    used to fire BEFORE `withStore`'s outer-finally `flush()`,
 *    letting the next acquirer read pre-flush Redis state. We
 *    `await store.flush()` before releasing so the next holder
 *    always sees a consistent post-write Redis snapshot.
 *
 * Returns either the body's result OR `{ lockHeld: true }` on lock
 * contention. Callers translate `lockHeld` to a 409 response.
 */
export async function withUserLock<T>(
  store: IStore,
  userId: string,
  fn: () => Promise<T>,
  options?: { ttlSec?: number },
): Promise<{ lockHeld: true } | { result: T }> {
  const ttlSec = options?.ttlSec ?? 300;
  const token = await acquireUserLock(userId, ttlSec);
  if (!token) return { lockHeld: true };

  try {
    // 1. Refresh local cache from Redis. Defeats cross-Lambda
    //    staleness — another Lambda may have just released the lock
    //    after writing updates we don't have locally.
    await store.refreshUser(userId);

    // 2. Apply pending-ledger debits queued for THIS user (refunds
    //    that failed to acquire the lock previously). Lazy import
    //    keeps the locks module free of custodial deps in test mocks.
    try {
      const { applyPendingLedgerForUser } = await import(
        '../custodial/pendingLedger.js'
      );
      await applyPendingLedgerForUser(store, userId);
    } catch (err) {
      // Non-fatal — log and continue. Worst case the cron drain
      // catches this entry on the next reconcile.
      console.warn(
        '[withUserLock] applyPendingLedgerForUser failed:',
        err instanceof Error ? err.message : err,
      );
    }

    const result = await fn();

    // 3. Flush pending writes BEFORE releasing the lock so the next
    //    acquirer reads a fully-consistent Redis state. Without
    //    this, write-through `this.fire(...)` writes can still be
    //    in-flight when the lock is released.
    await store.flush();

    return { result };
  } finally {
    await releaseUserLock(userId, token);
  }
}

// ── Operator locks ──────────────────────────────────────────────

/**
 * Acquire a distributed lock for an operator-level operation. Keyed by
 * a short scope name (e.g. 'withdraw-fees') so different operator
 * operations can run in parallel but the same operation cannot.
 *
 * Used to protect operations like `operatorWithdrawFees` where two
 * concurrent admin requests could otherwise both pass a TOCTOU balance
 * check and double-spend the operator float.
 *
 * @param scope - Short identifier for the operation (e.g. 'withdraw-fees')
 * @param ttlSec - Lock TTL in seconds (default 60)
 */
export async function acquireOperatorLock(
  scope: string,
  ttlSec = 60,
): Promise<string | null> {
  const redis = await getRedis();
  const key = `${OPERATOR_LOCK_PREFIX}${scope}`;
  const token = randomUUID();
  const result = await redis.set(key, token, { ex: ttlSec, nx: true });
  return result ? token : null;
}

/** Release an operator lock. Fence token must match. */
export async function releaseOperatorLock(
  scope: string,
  token: string,
): Promise<void> {
  const redis = await getRedis();
  const key = `${OPERATOR_LOCK_PREFIX}${scope}`;
  try {
    await redis.eval(RELEASE_SCRIPT, [key], [token]);
  } catch (err) {
    console.warn('[locks] operator release failed:', err);
  }
}
