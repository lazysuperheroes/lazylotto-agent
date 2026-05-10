/**
 * Phase-4 R7: gate test that fails CI if any code outside the
 * approved primitive files uses `redis.set(..., { nx: true, ... })`
 * directly.
 *
 * Why: the SET-NX/DEL archetype produced ~5 distinct stuck-claim or
 * fence-less DEL bugs across rounds R3..R6. The structural fix is
 * to route every fenced claim through `fencedClaim` (or
 * `acquireUserLock`/`acquireOperatorLock` for distributed locks).
 * This gate prevents the archetype from regressing.
 *
 * If a NEW use case genuinely needs a different shape from the
 * primitive (rare), add it to `ALLOWED_PATHS` in
 * `claim-archetype-gate.ts` and document why in PR review.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findClaimArchetypeViolations,
  FORBIDDEN_PATTERNS,
} from './claim-archetype-gate.js';
import { scanText } from './lint-helpers.js';

describe('Phase-6 Cluster B: claim-archetype gate behavioral fixtures', () => {
  // revert-proof: R8-FG-3 — pre-Phase-6 the gate scanned line-by-line.
  // Every production SET-NX in this codebase is multi-line. The new
  // whole-file scanner with `[\s\S]*?` in the regex catches it.
  it('flags multi-line `redis.set(..., { nx: true })`', () => {
    const text = `
      const x = await redis.set(
        KEY,
        fence,
        { nx: true, ex: 60 },
      );
    `;
    const matches = scanText(text, FORBIDDEN_PATTERNS);
    assert.ok(matches.length >= 1, 'multi-line redis.set with nx:true must be flagged');
  });

  // revert-proof: R8-FG-3 — single-line SET-NX must still fire (the
  // baseline case).
  it('flags single-line `redis.set(K, V, { nx: true })`', () => {
    const text = `await redis.set(K, V, { nx: true, ex: 60 });`;
    const matches = scanText(text, FORBIDDEN_PATTERNS);
    assert.ok(matches.length >= 1);
  });

  // revert-proof: R8-FG-28 — SADD claim archetype must be flagged.
  it('flags `redis.sadd(key, value)`', () => {
    const text = `await redis.sadd(KEY_PREFIX.dedup, txId);`;
    const matches = scanText(text, FORBIDDEN_PATTERNS);
    assert.ok(matches.length >= 1);
    assert.ok(matches.some((m) => m.description.includes('sadd')));
  });

  // revert-proof: R8-FG-28 — ZADD claim archetype must be flagged.
  it('flags `redis.zadd(key, score, value)`', () => {
    const text = `await redis.zadd(KEY_PREFIX.bucket, Date.now(), id);`;
    const matches = scanText(text, FORBIDDEN_PATTERNS);
    assert.ok(matches.length >= 1);
    assert.ok(matches.some((m) => m.description.includes('zadd')));
  });

  // revert-proof: R8-FG-29 — block comment containing the pattern
  // must NOT fire (false-positive defense).
  it('block comment containing `redis.set({nx:true})` does NOT fire', () => {
    const text = `
      /*
       * Documentation: legacy code did
       * \`redis.set(k, v, { nx: true })\` — now use fencedClaim.
       */
      function ok() { return null; }
    `;
    const matches = scanText(text, FORBIDDEN_PATTERNS);
    assert.equal(matches.length, 0, 'block comment must not match');
  });

  // revert-proof: R9-P3-003/004 / Phase-7 Cluster C — `redis.del`
  // outside the primitive layer. Same R5-FG-48 archetype.
  it('flags `redis.del(key)` outside the primitive layer', () => {
    const text = `await redis.del(KEY);`;
    const matches = scanText(text, FORBIDDEN_PATTERNS);
    assert.ok(matches.length >= 1);
    assert.ok(matches.some((m) => m.description.includes('redis.del')));
  });

  // revert-proof: R9-P3-007 / Phase-7 Cluster C — custom `redis.eval`
  // Lua outside the primitive layer.
  it('flags `redis.eval(script, ...)` outside the primitive layer', () => {
    const text = `await redis.eval(SCRIPT, [key], [val]);`;
    const matches = scanText(text, FORBIDDEN_PATTERNS);
    assert.ok(matches.length >= 1);
    assert.ok(matches.some((m) => m.description.includes('redis.eval')));
  });
});

describe('Phase-4 R7: SET-NX claim-archetype gate', () => {
  // smoke-only: structural lint — no production code path to revert.
  it('no source file outside the primitive layer uses redis.set(..., { nx: true, ... })', () => {
    const violations = findClaimArchetypeViolations();
    if (violations.length === 0) return;
    const lines = violations.map(
      (v) => `  ${v.file}:${v.line}  ${v.pattern}\n      ${v.text}`,
    );
    assert.fail(
      `\n\nSET-NX claim archetype detected — ${violations.length} violation(s):\n\n` +
        lines.join('\n') +
        `\n\nThe Phase-4 fencedClaim primitive (src/lib/fencedClaim.ts) is the\n` +
        `correct way to acquire+release a fenced claim. Hand-rolled\n` +
        `\`redis.set(key, marker, { nx: true })\` + \`redis.del(key)\` pairs\n` +
        `are the source of every R3-R6 stuck-claim / fence-less-DEL bug:\n` +
        `R4-FG-65 (idempotency catch DEL'd sibling claim), R5-FG-48 (eval\n` +
        `failure left claim stuck for 24h), R5-FG-94 (rakeReversed dedup\n` +
        `silent on duplicate), R6-FG-12 (pendingLedger mutation throw left\n` +
        `claim held while LREM nuked the row).\n\n` +
        `Fix: replace the SET-NX/DEL pair with one of:\n` +
        `  - \`fencedClaim(key, async () => ..., { ttlSec, context })\` for\n` +
        `    one-shot claims\n` +
        `  - \`acquireUserLock(userId)\` / \`releaseUserLock(...)\` for\n` +
        `    per-user serialization\n` +
        `  - \`acquireOperatorLock(scope)\` / \`releaseOperatorLock(...)\` for\n` +
        `    per-operation serialization\n` +
        `  - \`withIdempotency(scope, key, async () => ...)\` for request-\n` +
        `    level dedup with result caching\n\n` +
        `If you have a genuinely new use case (rare), add the file to\n` +
        `\`ALLOWED_PATHS\` in \`src/__tests__/claim-archetype-gate.ts\` and\n` +
        `explain why in PR review.\n\n`,
    );
  });
});
