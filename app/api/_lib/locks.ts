/**
 * Redis-based distributed user locks for serverless.
 *
 * Uses atomic SET NX EX with a unique fence token per acquirer, and
 * releases via a compare-and-delete Lua script so a Lambda that's
 * past its TTL cannot accidentally release a newer owner's lock.
 *
 * This pattern is the standard "correct" distributed lock minus
 * Redlock-style multi-node replication — Upstash is a single
 * replicated cluster, so a single SET NX is sufficient for our
 * serverless "prevent concurrent play/withdraw per user" use case.
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
import { getRedis, KEY_PREFIX } from '~/auth/redis';

const LOCK_PREFIX = KEY_PREFIX.session.replace('session:', 'lock:user:');

/** Lua: delete the key only if its value matches the expected token. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

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
  const key = `${LOCK_PREFIX}${userId}`;
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
 *
 * @param userId - The user ID
 * @param token - The fence token from acquireUserLock
 */
export async function releaseUserLock(
  userId: string,
  token: string,
): Promise<void> {
  const redis = await getRedis();
  const key = `${LOCK_PREFIX}${userId}`;
  try {
    await redis.eval(RELEASE_SCRIPT, [key], [token]);
  } catch (err) {
    // Lock release is best-effort — worst case it TTL-expires naturally
    console.warn('[locks] release failed:', err);
  }
}
