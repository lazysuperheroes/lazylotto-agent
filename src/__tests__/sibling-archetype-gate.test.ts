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
