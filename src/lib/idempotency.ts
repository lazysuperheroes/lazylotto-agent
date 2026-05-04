/**
 * Request-level idempotency for sensitive mutating endpoints.
 *
 * The use case: a client sends `POST /api/user/withdraw {amount: 50}`,
 * the server processes the on-chain transfer, the response packet
 * drops (cold timeout, network blip, MCP transport hiccup). The
 * client retries the SAME request. The per-user lock prevents
 * SIMULTANEOUS duplicates but not SEQUENTIAL retries — both calls
 * acquire the lock cleanly in turn and BOTH execute. Result:
 * double-withdrawal of the legitimately-requested amount.
 *
 * `withIdempotency` solves this by claiming an `Idempotency-Key`
 * with `SET NX EX` BEFORE running the body. The first call wins
 * the claim, executes, and stores the result keyed by the same id
 * with a 24h TTL. Duplicate calls with the same key get the cached
 * result back, never executing the body twice.
 *
 * Compatibility: a `null` / `undefined` key opts out — the body
 * runs once with no replay protection, identical to the pre-0.3.3
 * behaviour. Clients SHOULD pass a key for any irreversible
 * operation; a UUID per submit click is fine.
 */

import { getRedis } from '../auth/redis.js';

export type IdempotencyResult<T> =
  | { kind: 'fresh'; result: T }
  | { kind: 'duplicate'; result: T }
  | { kind: 'in-flight' };

/**
 * Run `fn` with replay protection keyed by `key`.
 *
 *   - `kind: 'fresh'`     — first time we've seen this key; body ran.
 *   - `kind: 'duplicate'` — key seen before, body completed; cached
 *                           result returned.
 *   - `kind: 'in-flight'` — key seen before but body hasn't completed
 *                           (still running on another Lambda OR died
 *                           mid-flight). Caller should return 409 and
 *                           let the client retry shortly.
 *
 * Body throw: the claim is DEL'd so an immediate retry can succeed.
 */
export async function withIdempotency<T>(
  scope: string,
  key: string | null | undefined,
  fn: () => Promise<T>,
  options?: { ttlSec?: number },
): Promise<IdempotencyResult<T>> {
  // Opt-out: no key, no replay protection. Run directly.
  if (!key) {
    return { kind: 'fresh', result: await fn() };
  }

  const ttlSec = options?.ttlSec ?? 24 * 60 * 60; // 24h default
  const redis = await getRedis();
  const fullKey = `idem:${scope}:${key}`;

  // Atomic claim — first caller wins.
  const claim = await redis.set(fullKey, 'pending', { nx: true, ex: ttlSec });

  if (claim === null) {
    // Already claimed by a previous request. Read back the stored value.
    const existing = await redis.get<string>(fullKey);
    if (!existing || existing === 'pending') {
      return { kind: 'in-flight' };
    }
    try {
      return { kind: 'duplicate', result: JSON.parse(existing) as T };
    } catch {
      // Corrupted cache value — treat as in-flight so the caller
      // can retry. Don't try to clean up; let TTL expire.
      return { kind: 'in-flight' };
    }
  }

  // We won the claim. Execute, store result, return fresh.
  try {
    const result = await fn();
    await redis.set(fullKey, JSON.stringify(result), { ex: ttlSec });
    return { kind: 'fresh', result };
  } catch (err) {
    // Release the claim so the next attempt can run cleanly.
    try {
      await redis.del(fullKey);
    } catch {
      // The 24h TTL is the worst-case fallback. Operator can DEL
      // manually if they want a faster retry.
    }
    throw err;
  }
}
