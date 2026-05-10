/**
 * Phase-4 R7: orphan-claim reconciler.
 *
 * The `fencedClaim` primitive (src/lib/fencedClaim.ts) closes the
 * "claim stuck after mutation throw" archetype that produced
 * R6-FG-12 — non-preserve errors release the claim, preserve errors
 * keep it intentionally. But two failure modes can still leave a
 * claim alive past its useful life:
 *
 *   (a) **PreserveClaim TTL** — by design the claim is held until
 *       TTL or operator reconcile. If the operator misses the page
 *       (or reconcile is broken), the claim sits.
 *
 *   (b) **Process kill mid-body** — a Lambda hard-killed AFTER
 *       SET-NX succeeds and BEFORE the catch path runs leaves a
 *       claim with no fence-holder; only TTL clears it. This is
 *       rare (Vercel's freeze model usually lets the catch run) but
 *       not impossible (OOM, signal, container terminated).
 *
 * The reconciler periodically walks every fenced-claim namespace,
 * surfaces claims whose remaining TTL is below a threshold (i.e.
 * they've been held a long time relative to their lease), and emits
 * structured warnings so an external monitor can page on them.
 *
 * Intentionally a SCAN-based passive observer. It does NOT release
 * claims unilaterally — that's exactly the unsafe move the fence
 * exists to prevent. The operator's decision to manually clear a
 * claim is informed by the on-chain state (mirror-node check,
 * audit-trail walk), not by the reconciler.
 *
 * Wiring: invoked from the hourly `/api/cron/reconcile` endpoint
 * after the existing reconcile passes. See the route handler for
 * the call site. Can also be invoked from the CLI via
 * `npm run reconcile:orphans` for ad-hoc triage.
 */

import { getRedis, KEY_PREFIX } from '../auth/redis.js';
import { logger } from './logger.js';

export interface OrphanedClaim {
  key: string;
  /** Subsystem inferred from the KEY_PREFIX namespace. */
  kind: string;
  /** Stored value (the fence token, in `pending:<uuid>[:<context>]` form). */
  fence: string;
  /**
   * R8-FG-26 / Phase-6 Cluster E: caller-provided context string
   * parsed from the fence suffix (`pending:<uuid>:<context>`). The
   * fencedClaim primitive encodes `options.context` here so the
   * reconciler can attribute stuck claims to a specific subsystem
   * — closes the documented-but-unimplemented behavior.
   */
  context?: string;
  /** Remaining TTL in seconds (-1 = no TTL set, -2 = key missing). */
  ttlSec: number;
  /**
   * `true` when the claim has been held at least
   * `staleThresholdRatio * originalTtl`. Used to gate alerting —
   * fresh claims aren't orphans yet.
   */
  isStale: boolean;
}

export interface OrphanReconcilerOptions {
  /**
   * Fraction of original TTL that must have elapsed before a claim
   * is considered stale. Default 0.5 — when a 10-min claim has only
   * 5 min left, it's been held ≥5 min and is at risk of being
   * stuck. The 24h idempotency claims become stale at 12h, etc.
   *
   * The reconciler can't know the original TTL from Redis alone
   * (TTL is the REMAINING value), so this is a heuristic via the
   * known TTL constants per subsystem (see `EXPECTED_TTL_SEC`).
   */
  staleThresholdRatio?: number;
  /** Max keys to enumerate per scan to bound the walk cost. */
  maxScan?: number;
}

/**
 * Per-subsystem expected TTLs. R8-FG-9 / Phase-6 Cluster F:
 * registers EVERY production claim/lock namespace, not just the
 * five Phase-4 originally tracked. Pre-fix the reconciler missed
 * `refunded` (refund per-tx claim, 30-day TTL), `escalated`
 * (escalation dedup, 1h TTL), `killswitch` (kill-switch flag,
 * 24h TTL), so stuck claims in those namespaces went undetected.
 *
 * Adding a new fenced-claim namespace? Register its KEY_PREFIX +
 * expected TTL here. The claim-archetype gate test verifies new
 * SET-NX call sites are routed through approved primitives; this
 * registry verifies they are also visible to the reconciler.
 */
const EXPECTED_TTL_SEC: Record<string, number> = {
  [KEY_PREFIX.idempotency]: 24 * 60 * 60, // withIdempotency default
  [KEY_PREFIX.lockUser]: 5 * 60, // user lock
  [KEY_PREFIX.lockOperator]: 60, // operator lock
  [KEY_PREFIX.pendingLedgerClaim]: 7 * 24 * 60 * 60, // pendingLedger
  [KEY_PREFIX.verifying]: 60, // verify lock
  // R8-FG-9 / Phase-6 Cluster F: previously-missed namespaces.
  [KEY_PREFIX.refunded]: 30 * 24 * 60 * 60, // refund per-tx claim (30 days)
  [KEY_PREFIX.escalated]: 60 * 60, // escalation dedup (1h)
  [KEY_PREFIX.killswitch]: 24 * 60 * 60, // kill-switch state (24h)
};

const DEFAULT_MAX_SCAN = 1000;

/**
 * Walk every namespace in EXPECTED_TTL_SEC, return the orphan
 * report. Pure observer — does not delete or extend any claim.
 */
export async function findOrphanedClaims(
  options?: OrphanReconcilerOptions,
): Promise<OrphanedClaim[]> {
  const ratio = options?.staleThresholdRatio ?? 0.5;
  const maxScan = options?.maxScan ?? DEFAULT_MAX_SCAN;
  const orphans: OrphanedClaim[] = [];

  const redis = await getRedis();
  // R8-FG-9 / Phase-6 Cluster F + R9-P10-004 / Phase-7 Cluster G:
  // both the in-memory mock AND production Upstash now implement
  // `scan`. The optional-chained access here is forward-compat for
  // any future Redis adapter that omits SCAN.
  const scan = (
    redis as unknown as {
      scan?: (
        cursor: string | number,
        opts: { match: string; count: number },
      ) => Promise<[string | number, string[]]>;
    }
  ).scan;

  for (const prefix of Object.keys(EXPECTED_TTL_SEC)) {
    const expectedTtl = EXPECTED_TTL_SEC[prefix]!;
    const matchPattern = `${prefix}*`;
    let cursor: string | number = 0;
    let scanned = 0;
    while (scanned < maxScan) {
      let keys: string[] = [];
      try {
        if (typeof scan === 'function') {
          // R9-FG-8 / Phase-7 Cluster G: pass cursor through verbatim.
          // Pre-fix `Number(cursor)` coerced Upstash's stringy "42"
          // back to numeric and worked for short namespaces but
          // broke if Upstash ever returned a non-numeric token.
          const [next, batch] = await scan(cursor, {
            match: matchPattern,
            count: 100,
          });
          cursor = next;
          keys = batch;
        } else {
          // No SCAN support on this adapter — skip this namespace silently.
          break;
        }
      } catch {
        // SCAN unavailable / errored — skip namespace.
        break;
      }
      scanned += keys.length;
      for (const key of keys) {
        const ttlSec = await redis.ttl?.(key).catch(() => -2);
        const value = await redis.get<unknown>(key).catch(() => null);
        if (typeof value !== 'string' || value.length === 0) {
          // Not present or empty — skip.
          continue;
        }
        // R8-FG-9 / Phase-6 Cluster F: drop the strict
        // `value.startsWith('pending:')` filter. Pre-fix this
        // excluded legitimate non-fenced claims (escalation = '1',
        // killswitch = JSON state) — the reconciler couldn't see
        // anything outside the fencedClaim layer. Now: any string
        // value with a TTL counts; the staleness ratio decides
        // what surfaces. For idempotency entries that completed
        // (value is the JSON-stringified result, not `pending:*`),
        // we still skip — completed claims are not stuck.
        if (
          prefix === KEY_PREFIX.idempotency &&
          !value.startsWith('pending:')
        ) {
          continue;
        }
        // R8-FG-26 / Phase-6 Cluster E + R9-P5-005 / Phase-7
        // Cluster G: parse the fence suffix ONLY when the value is
        // a fenced-claim form. Pre-Phase-7 the reconciler ran
        // `value.slice('pending:'.length)` unconditionally — for
        // `'1'` (escalation), JSON state (killswitch), or plain
        // UUIDs (legacy F24) the slice returned garbage and the
        // operator log "fence: <random>" was misleading. Now:
        // skip suffix parse for non-pending values.
        let context: string | undefined;
        if (value.startsWith('pending:')) {
          const afterPrefix = value.slice('pending:'.length);
          const colonIdx = afterPrefix.indexOf(':');
          if (colonIdx >= 0) context = afterPrefix.slice(colonIdx + 1);
        }
        const elapsedSec = expectedTtl - (ttlSec ?? expectedTtl);
        const isStale = elapsedSec / expectedTtl >= ratio;
        if (isStale) {
          orphans.push({
            key,
            kind: prefix.replace(/[:_]+$/, ''),
            fence: value,
            ...(context ? { context } : {}),
            ttlSec: ttlSec ?? -1,
            isStale: true,
          });
        }
      }
      if (cursor === 0 || cursor === '0') break;
    }
  }
  return orphans;
}

/**
 * Run the reconciler and emit a structured log entry per orphan.
 * Returns the number of stale claims found. Designed for cron
 * invocation:
 *
 *   await reconcileOrphans({ staleThresholdRatio: 0.75 });
 *
 * The cron handler should fire a webhook / page if the count
 * exceeds a threshold (operator-tunable; recommended 5).
 */
export async function reconcileOrphans(
  options?: OrphanReconcilerOptions,
): Promise<{ count: number; orphans: OrphanedClaim[] }> {
  const orphans = await findOrphanedClaims(options);
  for (const o of orphans) {
    // R9-P10-010 / Phase-7 Cluster G: include context in the
    // structured-log payload. Pre-Phase-7 the reconciler PARSED
    // context from the fence suffix but never logged it — defeating
    // R8-FG-26's purpose (operator subsystem attribution).
    logger.warn('orphaned fenced claim detected', {
      component: 'OrphanReconciler',
      event: 'orphaned_claim',
      key: o.key,
      kind: o.kind,
      fence: o.fence,
      ttlSec: o.ttlSec,
      ...(o.context ? { context: o.context } : {}),
    });
  }
  if (orphans.length > 0) {
    logger.error('orphan reconciler: stale claims present', {
      component: 'OrphanReconciler',
      event: 'orphan_reconciler_summary',
      count: orphans.length,
    });
  }
  return { count: orphans.length, orphans };
}
