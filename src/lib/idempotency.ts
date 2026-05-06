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
import { PreserveClaimError } from '../hedera/transfers.js';

export type IdempotencyResult<T> =
  | { kind: 'fresh'; result: T }
  | { kind: 'duplicate'; result: T }
  | { kind: 'in-flight' };

/**
 * Errors that extend `PreserveClaimError` (transfers.ts) retain the
 * idempotency claim on throw — `withIdempotency`'s catch will NOT DEL
 * the marker. Used to stop retries from racing past an in-flight
 * on-chain action whose outcome is not yet known. The claim sticks at
 * `'pending'` until either (a) the TTL expires (24h default), or
 * (b) an explicit admin tool / reconcile pass clears it after
 * verifying the on-chain outcome.
 *
 * Concrete subclasses today: `ReceiptUncertainError` (receipt
 * timeout). Add new subclasses (extending PreserveClaimError) when a
 * future on-chain helper introduces another "submitted but unknown"
 * failure mode (e.g. SDK internal throw after tx.execute returns).
 *
 * Note: this mechanism activates ONLY when the caller actually wraps
 * the body in `withIdempotency`. Refunds (src/hedera/refund.ts) use a
 * different in-function SET-NX-EX claim keyed on the original deposit
 * tx id and do NOT go through this code path.
 */

export function isPreserveClaim(err: unknown): err is PreserveClaimError {
  if (err instanceof PreserveClaimError) return true;
  // Defense in depth: cross-bundle module identity drift fallback.
  // If a future bundling boundary produces a duplicate class, the
  // instanceof check above fails silently. The error name is set in
  // the constructor and survives the duplicate-class hazard.
  if (err instanceof Error && err.name === 'ReceiptUncertainError') return true;
  return false;
}

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
    //
    // Upstash REST auto-deserializes JSON values — calling JSON.parse on an
    // already-parsed object throws SyntaxError. Other call sites in the
    // codebase (RedisStore loaders, auth/session.ts, etc.) explicitly guard
    // with `typeof raw === 'string' ? JSON.parse(raw) : raw` for this reason.
    // Without the guard the catch silently downgraded `duplicate` to
    // `in-flight`, defeating the whole replay-protection contract this file
    // was added to enforce.
    const existing = await redis.get<unknown>(fullKey);
    if (!existing || existing === 'pending') {
      return { kind: 'in-flight' };
    }
    try {
      const parsed = (typeof existing === 'string' ? JSON.parse(existing) : existing) as T;
      return { kind: 'duplicate', result: parsed };
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
    // PreserveClaimError sentinel (concrete: ReceiptUncertainError)
    // means the body submitted an irreversible on-chain action whose
    // outcome is unknown. Releasing the claim would let a retry
    // execute a SECOND on-chain action that, combined with a
    // successful original, double-spends. KEEP the claim — the next
    // caller with the same key gets `'in-flight'` and bounces.
    // Reconcile (or an admin tool) is responsible for verifying on
    // chain and clearing.
    if (isPreserveClaim(err)) {
      throw err;
    }
    // Confirmed failure (no on-chain effect, or on-chain effect
    // confirmed reverted). Release the claim so a retry can run
    // cleanly.
    try {
      await redis.del(fullKey);
    } catch {
      // The 24h TTL is the worst-case fallback. Operator can DEL
      // manually if they want a faster retry.
    }
    throw err;
  }
}
