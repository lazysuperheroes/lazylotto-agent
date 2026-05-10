/**
 * R6 Phase 1: gate test that fails CI if any code outside
 * `src/hedera/transfers.ts` (and approved test fixtures) uses
 * `instanceof ReceiptUncertainError` or `instanceof PostSubmitError`
 * directly.
 *
 * Why: the R5-FG-3 sibling-miss archetype caused 5 critical double-
 * spend windows discovered in R6. The structural fix requires every
 * gate to use the parent class `PreserveClaimError`, which now
 * carries `transactionId` so callers can narrow correctly. This gate
 * makes a regression visible at CI time, not at audit time.
 *
 * If you legitimately need to discriminate between subclasses (e.g.
 * for log messages), use `err.constructor.name` or add a discriminant
 * field to `PreserveClaimError`. The PRESERVE-CLAIM gate itself is
 * always on the parent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findViolations } from './sibling-archetype-gate.js';

// Phase-6 Cluster B: behavioral fixtures for the gate. The scanText
// helper runs the actual production FORBIDDEN_PATTERNS against
// synthetic text, asserting each archetype variant the R8 audit
// found bypassed is now flagged.

import { scanText } from './lint-helpers.js';
import { FORBIDDEN_PATTERNS } from './sibling-archetype-gate.js';

describe('Phase-6 Cluster B: sibling-archetype gate behavioral fixtures', () => {
  // revert-proof: R8-FG-29 — pre-fix the per-line block-comment strip
  // could false-positive on multi-line block comments mentioning the
  // forbidden pattern. The shared whole-file scanner now strips block
  // comments file-wide preserving line numbers; this fixture proves
  // the strip works.
  it('block comment containing the forbidden pattern does NOT fire', () => {
    const text = `
      /*
       * Documentation: when err instanceof PostSubmitError, do X.
       */
      function safe() { return null; }
    `;
    const matches = scanText(text, FORBIDDEN_PATTERNS);
    assert.equal(matches.length, 0, 'block comment must not produce a match');
  });

  // revert-proof: R5-FG-3 archetype — direct instanceof of a
  // PreserveClaim subclass outside the allowed path is the original
  // forbidden pattern. The fixture asserts the gate fires on it.
  it('flags `err instanceof PostSubmitError` in production code', () => {
    const text = `
      function bad() {
        if (err instanceof PostSubmitError) doStuff();
      }
    `;
    const matches = scanText(text, FORBIDDEN_PATTERNS);
    assert.ok(matches.length >= 1);
    assert.ok(matches.some((m) => m.description.includes('PostSubmitError')));
  });

  // revert-proof: R8-FG-4 / R6-FG-17 — name-string sibling miss. The
  // pre-Phase-6 gate didn't flag this; isPreserveClaim's cross-bundle
  // fallback was the EXACT archetype the gate exists to prevent.
  it('flags `err.name === "ReceiptUncertainError"` (name-string sibling miss)', () => {
    const text = `if (err.name === 'ReceiptUncertainError') return true;`;
    const matches = scanText(text, FORBIDDEN_PATTERNS);
    assert.ok(matches.length >= 1);
    assert.ok(matches.some((m) => m.description.includes('.name ===')));
  });

  // revert-proof: R8-FG-4 — constructor.name variant.
  it('flags `err.constructor.name === "PostSubmitError"`', () => {
    const text = `if (err.constructor.name === "PostSubmitError") return true;`;
    const matches = scanText(text, FORBIDDEN_PATTERNS);
    assert.ok(matches.length >= 1);
    assert.ok(matches.some((m) => m.description.includes('constructor.name')));
  });

  // revert-proof: R9-P3-009 / Phase-7 Cluster C — identity comparison
  // sibling-miss variant. Same archetype as `instanceof X` modulo
  // prototype chain.
  it('flags `err.constructor === ReceiptUncertainError`', () => {
    const text = `if (err.constructor === ReceiptUncertainError) doStuff();`;
    const matches = scanText(text, FORBIDDEN_PATTERNS);
    assert.ok(matches.length >= 1);
    assert.ok(matches.some((m) => m.description.includes('.constructor ===')));
  });

  // revert-proof: R9-FG-5 / Phase-7 Cluster C — message-substring
  // discrimination. The auth/verify.ts archetype the Phase-7 closure
  // retired; gate now forbids new instances.
  it('flags `err.message.includes("...")` discrimination', () => {
    const text = `if (e.message.includes('signature')) throw e;`;
    const matches = scanText(text, FORBIDDEN_PATTERNS);
    assert.ok(matches.length >= 1);
    assert.ok(matches.some((m) => m.description.includes('message.includes')));
  });
});

describe('R6 Phase 1: PreserveClaim subclass discrimination gate', () => {
  // smoke-only: structural lint, has no production code path to revert.
  it('no source file outside transfers.ts uses instanceof ReceiptUncertainError or PostSubmitError', () => {
    const violations = findViolations();
    if (violations.length === 0) return;
    const lines = violations.map(
      (v) => `  ${v.file}:${v.line}  ${v.pattern}\n      ${v.text}`,
    );
    assert.fail(
      `\n\nR5-FG-3 sibling-miss archetype detected — ${violations.length} violation(s):\n\n` +
        lines.join('\n') +
        `\n\nThe parent class \`PreserveClaimError\` is the only correct gate for\n` +
        `"preserve the idempotency claim / reserve" decisions. The R5-FG-3\n` +
        `audit shipped \`PostSubmitError\` as a sibling of \`ReceiptUncertainError\`\n` +
        `under the parent. Every subclass-specific gate is a sibling-miss\n` +
        `waiting for the next subclass to land — exactly what produced\n` +
        `R6-FG-1 through R6-FG-5 (5 critical double-spend windows).\n\n` +
        `Fix: replace \`err instanceof ReceiptUncertainError\` (or the\n` +
        `disjunction with PostSubmitError) with \`err instanceof\n` +
        `PreserveClaimError\`. The parent class exposes \`transactionId\`\n` +
        `so TypeScript narrows correctly.\n\n` +
        `If you genuinely need subclass discrimination (e.g. for log text),\n` +
        `use \`err.constructor.name\`. If you have a documented exception\n` +
        `(test fixture, etc.), add the file to \`ALLOWED_PATHS\` in\n` +
        `\`src/__tests__/sibling-archetype-gate.ts\` and explain why in PR review.\n\n`,
    );
  });
});
