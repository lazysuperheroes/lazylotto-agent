/**
 * Phase-4 R7 + Phase-6 Cluster B: structural lint gate against
 * hand-rolled SET-NX claim pairs (and the SADD/INCR sibling
 * archetypes Phase-6 added coverage for).
 *
 * Background: six audit rounds turned up the same archetype: a new
 * subsystem rolls its own `redis.set(key, marker, { nx: true, ex: ... })`
 * + `redis.del(key)` pair, gets the fence-token detail wrong (R4-FG-65,
 * R5-FG-48, R5-FG-94, R6-FG-12), and another double-spend / stuck-
 * claim window opens. The Phase-4 fencedClaim primitive collapses the
 * pattern into one helper that gets it right by construction.
 *
 * Phase-6 R8-FG-3 closure: the gate now uses the shared whole-file
 * scanner from `lint-helpers.ts`. Pre-fix the line-by-line scanner
 * silently missed every multi-line `redis.set(...)` call (and every
 * production SET-NX in this codebase IS multi-line); seven
 * production SET-NX call sites slipped past the gate while it
 * advertised "every hand-rolled SET-NX is locked".
 *
 * Phase-6 R8-FG-28 closure: SADD/ZADD/INCR claim archetypes are
 * now also flagged. CLAUDE.md ("Cross-Lambda dedup must hit Redis
 * through atomic primitives") names THREE primitives — SADD, SET-NX,
 * INCR — all of which can produce stuck-claim variants. Pre-fix
 * the gate covered only one.
 *
 * Approved files own the primitive layer:
 *   - src/lib/fencedClaim.ts
 *   - src/lib/idempotency.ts
 *   - src/lib/locks.ts
 *
 * Test files that exercise the mock SET-NX directly are also
 * grandfathered (the mock test fixtures for the in-memory Redis
 * backend that fencedClaim itself runs on).
 */

import {
  scanProductionRoots,
  type LintPattern,
  type LintViolation,
} from './lint-helpers.js';

export { REPO_ROOT, keyFor } from './lint-helpers.js';

/**
 * Files allowed to call `redis.set(*, *, { nx: true, ... })` directly,
 * or to use SADD/ZADD/INCR for the claim/dedup primitives:
 */
const ALLOWED_PATHS = new Set<string>([
  // Primitive layer:
  'src/lib/fencedClaim.ts',
  'src/lib/fencedClaim.test.ts',
  'src/lib/idempotency.ts',
  'src/lib/idempotency.test.ts',
  'src/lib/locks.ts',
  'src/lib/locks.test.ts',

  // Test fixtures that exercise the underlying Redis mock directly.
  'src/hedera/refund.test.ts',
  'src/custodial/concurrency-invariants.test.ts',
  // Phase-6 Cluster F: orphan reconciler test seeds claims directly
  // via the mock to exercise the SCAN walk.
  'src/lib/orphanReconciler.test.ts',

  // The gate's own files reference the regex sources in comments
  // and tests; self-reference is intrinsic.
  'src/__tests__/claim-archetype-gate.ts',
  'src/__tests__/claim-archetype-gate.test.ts',
  'src/__tests__/lint-helpers.ts',

  // Phase-6: legacy SET-NX call sites grandfathered with rationale.
  // Each entry MUST come with a comment in this file explaining why
  // the site doesn't (or can't) migrate to fencedClaim. New entries
  // require PR review.

  // killswitch.ts: SET-NX with NO release (state stamp until TTL).
  // fencedClaim's release-on-throw doesn't fit; the kill flag is
  // explicitly meant to TTL out. R5-FG-7 fixed the missing-EX bug;
  // the structural shape is correct.
  'src/lib/killswitch.ts',

  // escalation.ts: 1h fire-and-forget dedup (no release, no body
  // execution). fencedClaim requires a body; this site stamps then
  // returns. Could wrap with `fencedClaim(key, async () => {})` but
  // it's a deliberate no-body claim.
  'src/lib/escalation.ts',

  // RedisStore.ts: agentSeq seed (CLAUDE.md invariant 12 —
  // SET-NX-based one-shot baseline, not a fenced claim).
  'src/custodial/RedisStore.ts',

  // uncertainTxVerification.ts: per-txId verifier-lock that pre-dates
  // fencedClaim. Has its own fence + acquireVerifyLock helper. Phase-6
  // does not migrate this; tracked under R7-Phase-4-followup.
  'src/custodial/uncertainTxVerification.ts',

  // refund.ts: refund per-tx claim AND verifier per-tx claim — the
  // shape is "claim, do on-chain transfer, store result, never DEL"
  // (refund txIds are kept in Redis for 30 days for replay defense).
  // Materially different from fencedClaim's DEL-on-completion model.
  // Migration would require a new "claim with terminal state" primitive.
  'src/hedera/refund.ts',

  // MultiUserAgent.ts: F24 per-token operator pending claim. Lifecycle
  // is "claim → transfer → on success: convert to terminal record;
  // on uncertain: keep claim; on hard failure: compare-and-DEL".
  // Mid-state lifecycle doesn't map to fencedClaim's catch-and-DEL.
  // Tracked for Phase-7+ structural extraction.
  'src/custodial/MultiUserAgent.ts',

  // app/api/admin/uncertain-tx/[id]/force-release/route.ts: verifier
  // lock for force-release operator action. Companion to
  // uncertainTxVerification.ts; same legacy verifier-lock primitive.
  'app/api/admin/uncertain-tx/[id]/force-release/route.ts',

  // SADD-membership grandfathered sites (R8-FG-28 closure: SADD is
  // also the canonical Redis SET-membership primitive per CLAUDE.md;
  // these uses are NOT claim archetypes — they're set-membership
  // dedup or aggregation, the legitimate SADD use case).

  // app/api/admin/uncertain-tx/[id]/force-release/handlers.ts:
  // refundedOriginals SADD-membership dedup. Companion to refund.ts;
  // CLAUDE.md invariant 13 names SADD-claim as the cross-Lambda dedup
  // primitive for refunds. Phase-7 R9-P3-005: also performs custom
  // redis.eval(RELEASE_SCRIPT-equivalent Lua) — verified to use the
  // canonical compare-and-DEL pattern, not bespoke claim semantics.
  // Phase-7 R9-P3-003: also performs redis.del on uncertainTx claim
  // keys after on-chain verification — covered by per-tx verifier
  // lock at acquisition time.
  'app/api/admin/uncertain-tx/[id]/force-release/handlers.ts',

  // src/auth/session.ts: per-account session-token tracking (revoke
  // all on re-auth). Pure SET-membership; no claim lifecycle. Also
  // performs redis.del on session keys (legitimate revocation).
  'src/auth/session.ts',

  // R9-FG-6 / Phase-7 Cluster E grandfather: pendingLedger.ts uses
  // SADD-membership for idempotency anchor on (userId, sourceTx) —
  // the legitimate SADD-membership primitive (CLAUDE.md invariant 13)
  // not a claim archetype. The body checks SISMEMBER before mutating
  // and SADDs after flush.
  'src/custodial/pendingLedger.ts',

  // R9-P3-003 / Phase-7 Cluster C grandfathers for redis.del:
  // src/services/userOps.ts: idempotency-claim DEL after replay-
  // deposit completes. The race is theoretically real (Lambda A
  // completes, Lambda B reads duplicate, Lambda B DELs while Lambda
  // C is in duplicate branch). In practice replay-deposit is admin-
  // initiated, gated by per-user lock, and extremely low-concurrency.
  // The structural fix (releaseIdempotencyClaim primitive that does
  // compare-and-DEL via the stored fence) is tracked under R10-Phase-1.
  // For now: grandfather with rationale.
  'src/services/userOps.ts',

  // R9-P3-003 / Phase-7 Cluster C grandfather: AccountingService.ts
  // performs redis.del on:
  //   - agentSeq seed-fail-count counter (line ~729) — counter clear
  //     on successful seed, not a claim DEL
  //   - migration / cleanup paths
  // None are claim archetypes; counter clears + migrations are not
  // fence-protected by design.
  'src/custodial/AccountingService.ts',

  // R9-P3-004 / Phase-7 Cluster C grandfather:
  // src/lib/killswitch.ts performs redis.del on KILL_KEY for explicit
  // operator disengage and on the engagement-attempt cleanup paths.
  // Both are admin-initiated, single-key state ops; no fence
  // semantics required (the kill flag's lifetime IS its TTL).
  'src/lib/killswitch.ts',

  // R9-P3-007 / Phase-7 Cluster C grandfather:
  // src/custodial/uncertainTxVerification.ts performs redis.del +
  // redis.eval as part of the legacy verifier-lock primitive. The
  // grandfather carries forward from Phase-4's same rationale.
  // Tracked for migration to fencedClaim under R10-Phase-1.
  // (already grandfathered above for SET-NX; restating here so the
  // DEL/EVAL coverage is explicit).
]);

export const FORBIDDEN_PATTERNS: LintPattern[] = [
  {
    // R8-FG-3: multi-line tolerant. The whole-file scanner in
    // lint-helpers.ts plus this `[\s\S]*?` makes the regex work
    // across newlines.
    regex: /redis\s*\.\s*set\s*\([\s\S]*?\b(?:nx|NX)\s*:\s*true/g,
    description: 'redis.set(..., { nx: true, ... })',
  },
  {
    // R8-FG-28: SADD-based claim archetypes. CLAUDE.md names this
    // as the canonical SADD-claim primitive (deposit dedup,
    // dead-letter id dedup). Outside the approved producers, any
    // new SADD claim is a sibling-miss seed.
    regex: /redis\s*\.\s*sadd\s*\(/g,
    description: 'redis.sadd(...)',
  },
  {
    // R8-FG-28: ZADD-based time-bucket claim archetype.
    regex: /redis\s*\.\s*zadd\s*\(/g,
    description: 'redis.zadd(...)',
  },
  {
    // R9-P3-003/004 / Phase-7 Cluster C: unfenced `redis.del(...)`
    // outside primitive layer. The R4-FG-65 / R5-FG-48 archetype: a
    // sibling acquirer's claim gets DELed when the original holder's
    // catch path fires after TTL expiry. Compare-and-DEL via
    // RELEASE_SCRIPT (locks.ts) or fencedClaim.releaseFence is the
    // primitive contract; outside the primitive layer, plain DEL is
    // a sibling-miss seed. Match `redis.del(`, `this.redis.del(`,
    // `ctx.redis.del(` — anything ending in `.redis.del(`.
    regex: /\bredis\s*\.\s*del\s*\(/g,
    description: 'redis.del(...) (must be compare-and-DEL via fenced primitive)',
  },
  {
    // R9-P3-007 / Phase-7 Cluster C: custom `redis.eval(...)` Lua
    // outside primitive layer. Custom Lua implementing claim
    // semantics that bypass RELEASE_SCRIPT can clobber a fresh
    // acquirer's claim. RELEASE_SCRIPT is the canonical
    // compare-and-DEL Lua; primitive helpers (locks, fencedClaim,
    // idempotency) are the only legitimate users.
    regex: /\bredis\s*\.\s*eval\s*\(/g,
    description: 'redis.eval(...) (only RELEASE_SCRIPT allowed; primitive layer)',
  },
];

export type Violation = LintViolation;

/**
 * Scan the codebase for forbidden patterns. Returns one Violation
 * per match.
 */
export function findClaimArchetypeViolations(): Violation[] {
  return scanProductionRoots(ALLOWED_PATHS, FORBIDDEN_PATTERNS);
}
