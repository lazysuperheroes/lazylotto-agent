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

/**
 * Lua: delete the key only if its value matches the expected token.
 *
 * Exported (R2-FG-6) so callers like `releaseVerifyLock` and
 * `releaseRefundLock` can share this exact lowercase script. The
 * in-memory Redis mock in `src/auth/redis.ts` matches `eval` payloads
 * by lowercase substring (`get` / `del`); using a custom uppercase
 * variant in caller code makes the release a SILENT NO-OP under
 * `installRedisMock` — exactly the case our tests exercise.
 */
export const RELEASE_SCRIPT = `
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
 * Default backoff schedule (ms) for `tryAcquireUserLockWithBackoff`.
 * Sized to absorb a typical in-band play (~3s) without permanently
 * blocking the caller — total ~6.85s, then return null and let the
 * caller defer to a later retry.
 */
const USER_LOCK_BACKOFF_MS = [50, 100, 200, 500, 1000, 2000, 3000] as const;

/**
 * Acquire `lockUser:<userId>` with bounded retry/backoff. Returns the
 * fence token on success, null after total backoff is exhausted.
 *
 * R2-FG-1 (2026-05-06 round-2 audit X-01/X-02/X-03): used by both
 * the verifier and the force-release handlers so a force-release
 * triggered by an operator can never race a concurrent in-band
 * withdraw / play / refund on the same user. Both paths share the
 * same `KEY_PREFIX.lockUser:<userId>` namespace; whoever acquires
 * first serializes the other.
 *
 * On null, callers MUST defer the work (return 409 from a route, or
 * leave the dead-letter `still_uncertain` for the next reconcile pass).
 * NEVER fall through to mutate state without a token — that's the
 * exact regression R2-FG-1 closes.
 */
export async function tryAcquireUserLockWithBackoff(
  userId: string,
  ttlSec = 60,
): Promise<string | null> {
  for (const delay of USER_LOCK_BACKOFF_MS) {
    const token = await acquireUserLock(userId, ttlSec);
    if (token) return token;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return null;
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

/**
 * R4-FG-66 (round-4 low): heartbeat-extend an operator lock to keep
 * it alive across long-running work that would otherwise outrun the
 * acquire-time TTL. Returns a `cancel` handle the caller MUST call
 * in their `finally`. The handle clears the timer.
 *
 * The fence token gates the EXPIRE — only the original acquirer's
 * heartbeat can extend the lock; a sibling acquisition with a
 * different token can't be silently extended by stale Lambdas.
 *
 * Use case: reconcile cron pass over many DLs where a single mirror
 * flake could push the walk past the 900s TTL acquired up front.
 */
const HEARTBEAT_RELEASE_OR_EXTEND_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('expire', KEYS[1], ARGV[2])
else
  return 0
end
`.trim();

export function startOperatorLockHeartbeat(
  scope: string,
  token: string,
  /** Re-extend interval, ms. */
  intervalMs: number,
  /** TTL to set on each heartbeat, seconds. */
  ttlSec: number,
): { cancel: () => void } {
  const key = `${OPERATOR_LOCK_PREFIX}${scope}`;
  return startLockHeartbeat(key, token, intervalMs, ttlSec);
}

/**
 * R5-FG-26 (P4-007): heartbeat for the per-txId verifier-lock used
 * by force-release. The route's work after acquire (handler + mirror
 * cross-check + ledger mutation + HCS submit + R4-FG-29 fallback +
 * resolve upsert + flush) can exceed `VERIFY_LOCK_TTL_SEC=60` on HCS
 * congestion. R4-FG-9 fixed the same TTL exhaustion concern for
 * refunds; reconcile got R4-FG-66's heartbeat. Force-release was the
 * sibling miss. R4-FG-8 fenced the release so a TTL-out doesn't nuke
 * a sibling — but the bug we fenced AGAINST (handler exceeds TTL on
 * HCS congestion → sibling acquires → torn state) is still reachable.
 */
export function startVerifyLockHeartbeat(
  /** Just the txId (or refund-prefixed txId) — full key is built here. */
  txIdOrSubKey: string,
  token: string,
  ttlSec: number,
  intervalMs: number = Math.max(15_000, Math.floor((ttlSec * 1000) / 3)),
): { cancel: () => void } {
  const key = `${KEY_PREFIX.verifying}${txIdOrSubKey}`;
  return startLockHeartbeat(key, token, intervalMs, ttlSec);
}

/**
 * R5-FG-28 (P6-003): heartbeat for per-user locks. Generalization of
 * `startOperatorLockHeartbeat` so the recover-stuck-prizes script
 * (which holds a user lock for transferAllPrizesWithRetry + 5s
 * mirror wait + audit anchor + verification) doesn't outrun its
 * 600s TTL on slow-mainnet days. Same Lua-fenced compare-and-extend
 * as the operator path so a sibling acquisition cannot be silently
 * extended by stale callbacks.
 */
export function startUserLockHeartbeat(
  userId: string,
  token: string,
  /** TTL to set on each heartbeat, seconds. */
  ttlSec: number,
  /** Re-extend interval, ms. Defaults to ttlSec/3 in ms (3 ticks per TTL). */
  intervalMs: number = Math.max(15_000, Math.floor((ttlSec * 1000) / 3)),
): { cancel: () => void } {
  const key = `${USER_LOCK_PREFIX}${userId}`;
  return startLockHeartbeat(key, token, intervalMs, ttlSec);
}

/**
 * R5-FG-28: shared heartbeat primitive for any lock-keyed Redis
 * fenced extend. Both operator and user variants delegate here.
 *
 * R5-FG-49 (P6-008 + P2-002 + P4-009 + P7-014): self-rescheduling
 * setTimeout (instead of setInterval) so that a hung Redis can't
 * stack callbacks. Pre-fix `setInterval(60s)` would queue a fresh
 * tick every 60s even when the previous tick hadn't resolved
 * because Redis was wedged. When the wedge cleared, dozens of
 * stacked callbacks fired, one of them landing a successful
 * compare-and-extend AFTER a sibling had acquired with a different
 * token — but the cancelled flag was checked in JS-only, so the
 * Lua script saw the original (still-matching) token and silently
 * extended out from under the sibling. Self-rescheduling caps the
 * outstanding queue at 1 and the cancelled-flag check before
 * scheduling the next tick prevents stacking.
 */
function startLockHeartbeat(
  key: string,
  token: string,
  intervalMs: number,
  ttlSec: number,
): { cancel: () => void } {
  let cancelled = false;
  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (cancelled) return;
    timerHandle = setTimeout(() => void tick(), intervalMs);
    // R5-FG-104 (P11-012): unref the timer so a forgotten heartbeat
    // doesn't keep the Node event loop alive in CLI processes.
    // Vercel Lambdas freeze the event loop on response anyway —
    // unref is mainly a CLI/dev-process hygiene fix.
    timerHandle.unref?.();
  };
  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      const redis = await getRedis();
      await redis.eval(HEARTBEAT_RELEASE_OR_EXTEND_SCRIPT, [key], [token, String(ttlSec)]);
    } catch {
      // Best-effort. If heartbeat fails, the lock will TTL out at
      // the last successful extension; the work continues until done.
    }
    // R5-FG-49: re-check cancelled BEFORE scheduling the next tick
    // so a cancellation during this tick's await doesn't leak a
    // queued callback that fires after the sibling has acquired.
    if (!cancelled) schedule();
  };
  schedule();
  return {
    cancel(): void {
      cancelled = true;
      if (timerHandle !== undefined) {
        clearTimeout(timerHandle);
        timerHandle = undefined;
      }
    },
  };
}
