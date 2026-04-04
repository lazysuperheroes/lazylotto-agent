/**
 * Redis-based distributed user locks for serverless.
 *
 * The in-memory promise-based locks in MultiUserAgent only protect
 * within a single Node.js process. In serverless (Vercel), concurrent
 * Lambda invocations are separate processes — the in-memory lock
 * provides zero cross-process protection.
 *
 * This module uses Redis INCR (atomic) with TTL for distributed locking,
 * ensuring that two concurrent requests can't play or withdraw
 * for the same user simultaneously.
 */

import { getRedis, KEY_PREFIX } from '~/auth/redis';

const LOCK_PREFIX = KEY_PREFIX.session.replace('session:', 'lock:user:');

/**
 * Attempt to acquire a distributed lock for a user.
 * Returns true if the lock was acquired, false if already held.
 *
 * Uses atomic INCR: first caller gets count=1 (lock acquired),
 * concurrent callers get count>1 (lock denied).
 *
 * @param userId - The user ID to lock
 * @param ttlSec - Lock TTL in seconds (default 300 = 5 min)
 */
export async function acquireUserLock(
  userId: string,
  ttlSec = 300,
): Promise<boolean> {
  const redis = await getRedis();
  const key = `${LOCK_PREFIX}${userId}`;

  // INCR is atomic — first caller gets 1, others get 2+
  const count = await redis.incr(key);

  if (count === 1) {
    // We won the lock — set TTL so it auto-expires if we crash
    await redis.expire(key, ttlSec);
    return true;
  }

  // Lock already held by another invocation
  return false;
}

/**
 * Release a distributed lock for a user.
 */
export async function releaseUserLock(userId: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(`${LOCK_PREFIX}${userId}`);
}
