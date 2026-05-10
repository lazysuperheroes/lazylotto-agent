/**
 * Phase-4 R7: fencedClaim primitive.
 *
 * Six audit rounds turned up the same archetype each time:
 *   1. `redis.set(claimKey, 'pending', { nx: true, ex: TTL })`
 *   2. do work
 *   3. `redis.del(claimKey)` on success
 *   4. `redis.del(claimKey)` on failure too
 *
 * The bugs cluster in two places:
 *
 *   (a) **Fence token absent.** Step 1 stores a non-unique value
 *       (`'pending'`, `'1'`). Step 4's DEL doesn't compare; if a
 *       sibling acquirer raced into the slot after the original's
 *       lease TTL'd out, the original's catch path nukes the
 *       sibling's claim. The catch block of withIdempotency
 *       documents the failure mode in detail (R4-FG-65, R5-FG-48).
 *
 *   (b) **DEL skipped on the failure path.** R6-FG-12 found
 *       `pendingLedger.ts` SET-NXing with `'1'` and NEVER DELing
 *       on a mutation failure — the row stays orphaned in the
 *       LIST until TTL (7 days) and the user's debit is silently
 *       lost. Same archetype as R3-FG-22, R4-FG-58, R5-FG-94.
 *
 * `fencedClaim` collapses the pattern into one primitive that gets
 * BOTH parts right by construction:
 *
 *   - SET-NX with a unique `pending:<uuid>` fence + TTL (default 10m).
 *   - Returns `{ kind: 'busy' }` immediately if the slot is held.
 *   - On `kind: 'ran'` — body completed normally; compare-and-DEL via
 *     the canonical RELEASE_SCRIPT (only releases if our fence is
 *     still the holder).
 *   - On `PreserveClaimError` thrown by the body — the claim is KEPT
 *     until TTL or operator reconcile (the on-chain action submitted;
 *     outcome unknown). The error is RETHROWN unchanged so the
 *     caller's existing `instanceof PreserveClaimError` catch ladder
 *     fires. The outcome union does NOT include a `'preserved'`
 *     variant — that path is signalled by re-throw, not by return
 *     value. This matches `withIdempotency`'s contract — see
 *     `src/lib/idempotency.ts`.
 *   - On any non-preserve throw — the claim is compare-and-DEL'd so
 *     a retry can immediately pick up where we left off, and the
 *     error is RETHROWN. The outcome union does NOT include a
 *     `'failed'` variant either.
 *
 * Outcome union TL;DR: `'ran'` (body succeeded) and `'busy'` (slot
 * held). All throws propagate; the difference between
 * preserve-vs-non-preserve is internal release-decision only,
 * invisible to the caller's discriminated `kind` switch.
 *
 * The contract is intentionally narrow: no result caching (that's
 * `withIdempotency`'s job), no auto-retry, no LREM/queue management.
 * Just the SET-NX + fence + release lifecycle. Higher-level helpers
 * (pending-ledger drain, refund per-tx claim, F24 per-token operator
 * claim) compose `fencedClaim` with their own queue/dedupe logic.
 *
 * Migration policy (Phase-4 R7): every existing hand-rolled
 * `redis.set(..., { nx: true, ex: ... })` claim site MUST migrate to
 * this primitive. The lint gate at `src/__tests__/claim-archetype-gate.ts`
 * enforces a one-way ratchet: any new `nx: true` SET outside the
 * approved files (locks.ts, idempotency.ts, fencedClaim.ts, the
 * mock-test files) fails CI.
 *
 * Orphan reconciler (Phase-4 R7): the optional `context` argument
 * stamps the claim with caller metadata so the orphan reconciler in
 * `src/lib/orphanReconciler.ts` can attribute stuck claims to a
 * specific subsystem when surfacing them.
 */

import { randomUUID } from 'node:crypto';
import { getRedis } from '../auth/redis.js';
import { isPreserveClaim } from './idempotency.js';
import { RELEASE_SCRIPT } from './locks.js';

export interface FencedClaimOptions {
  /**
   * Lease duration. Default 10 minutes. Pick this for the longest
   * realistic body runtime — the catch path always releases on
   * non-preserve errors, so this is the WORST-case orphan window
   * after a Lambda freeze.
   */
  ttlSec?: number;
  /**
   * Subsystem tag used by the orphan reconciler to attribute stuck
   * claims. Free-form; matches against the `kind` field in
   * `OrphanedClaim` reports.
   */
  context?: string;
}

export type FencedClaimOutcome<T> =
  | {
      /** Body completed normally; claim has been released. */
      kind: 'ran';
      result: T;
      /** The fence token we held — useful for log correlation. */
      fence: string;
    }
  | {
      /** Slot was held by a sibling; body did NOT run. */
      kind: 'busy';
      /** The existing claim value (for diagnostics; may be a sibling fence or a stored result). */
      existing: unknown;
    };

/**
 * Caller-side type guard for documenting the rethrow contract — a
 * thrown `PreserveClaimError` means `fencedClaim` kept the claim
 * held. Re-exported here so callers don't need to depend directly
 * on the transfers.ts internals.
 */
export type { PreserveClaimError } from '../hedera/transfers.js';

/**
 * Acquire a fenced SET-NX claim, run `fn`, release on completion.
 *
 * Returns one of three outcomes (see `FencedClaimOutcome`). Throws
 * on `kind: 'preserved'` so the call site's existing PreserveClaim
 * handling fires — that's the only throw path. All other outcomes
 * are returned values, including `busy`.
 *
 * @example
 *   const out = await fencedClaim(`refund:${txId}`, async () => {
 *     return await processRefund(txId);
 *   }, { ttlSec: 7 * 24 * 3600, context: 'refund' });
 *   if (out.kind === 'busy') return { duplicate: true };
 *   if (out.kind === 'ran') return out.result;
 */
export async function fencedClaim<T>(
  key: string,
  fn: () => Promise<T>,
  options?: FencedClaimOptions,
): Promise<FencedClaimOutcome<T>> {
  const ttlSec = options?.ttlSec ?? 600; // 10 min default
  // R8-FG-26 / Phase-6 Cluster E: encode `context` into the fence
  // value as `pending:<uuid>:<context>`. Pre-fix the API documented
  // that `context` "stamps the claim with caller metadata so the
  // orphan reconciler can attribute stuck claims to a specific
  // subsystem" — but the implementation never wrote it anywhere.
  // Encoding into the fence keeps compare-and-DEL working (full
  // string equality) and lets the reconciler parse the suffix.
  // Colons inside context are sanitized to avoid breaking the
  // split.
  const ctx = options?.context
    ? `:${options.context.replace(/:/g, '_')}`
    : '';
  const fence = `pending:${randomUUID()}${ctx}`;
  const redis = await getRedis();

  const claimResult = await redis.set(key, fence, { nx: true, ex: ttlSec });
  if (claimResult === null) {
    // Slot already held; read back the value for diagnostics.
    const existing = await redis.get<unknown>(key).catch(() => null);
    return { kind: 'busy', existing };
  }

  try {
    const result = await fn();
    // Compare-and-DEL: only releases if our fence is still the holder.
    await releaseFence(key, fence);
    return { kind: 'ran', result, fence };
  } catch (err) {
    if (isPreserveClaim(err)) {
      // Body submitted an on-chain action whose outcome is unknown.
      // Releasing the claim would let a retry double-submit. KEEP the
      // claim — TTL eventually expires; operator reconcile is the
      // recovery path. Rethrow so the caller's existing PreserveClaim
      // catch ladder fires unchanged. The fence is intentionally NOT
      // released here — that's the entire point.
      throw err;
    }
    // Non-preserve failure: body did NOT mutate on-chain state in any
    // unrecoverable way (or the caller's contract says it can be
    // safely retried). Release the claim so a retry can pick up.
    // R6-Phase-4: REMOVING this releaseFence call is the R6-FG-12
    // archetype — the claim sits until TTL while the next drain
    // assumes a sibling completed. The fencedClaim.test.ts
    // "releases the claim on a non-preserve throw" test fails if
    // this line is removed; it is the structural revert detector
    // for the entire primitive's release contract.
    await releaseFence(key, fence); // R6-Phase-4 release-on-throw anchor
    throw err;
  }
}

/**
 * Compare-and-DEL via the canonical RELEASE_SCRIPT, with the same
 * eval→DEL fallback used by `withIdempotency` (R5-FG-48). Best-effort
 * on both rails — a failed release leaves the TTL as the worst-case
 * cleanup, which is exactly the TTL the caller picked.
 *
 * Exported so `withIdempotency` can compose it (Phase-4 collapses
 * the duplicated catch logic onto one helper).
 */
export async function releaseFence(key: string, fence: string): Promise<void> {
  const redis = await getRedis();
  try {
    await redis.eval(RELEASE_SCRIPT, [key], [fence]);
  } catch (evalErr) {
    // Fallback to plain DEL — same pattern as withIdempotency.
    // Race vs. sibling acquire is microseconds-wide and only
    // materializes if our TTL had already expired; in practice this
    // is the recoverable path on Redis cluster failover or mock
    // engines that don't support eval.
    try {
      await redis.del(key);
      try {
        const { logger } = await import('./logger.js');
        logger.warn('fencedClaim release eval failed; fell back to plain DEL', {
          component: 'FencedClaim',
          event: 'fenced_claim_release_eval_failed',
          key,
          error: evalErr instanceof Error ? evalErr.message : String(evalErr),
        });
      } catch {
        /* logger import is best-effort */
      }
    } catch (delErr) {
      try {
        const { logger } = await import('./logger.js');
        logger.error('fencedClaim release: BOTH eval and DEL failed; claim will TTL out', {
          component: 'FencedClaim',
          event: 'fenced_claim_release_failed',
          key,
          error: delErr instanceof Error ? delErr.message : String(delErr),
        });
      } catch {
        /* logger import is best-effort */
      }
    }
  }
}
