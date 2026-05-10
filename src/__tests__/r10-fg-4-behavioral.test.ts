/**
 * R10-FG-4 behavioral test — manifest placebo-by-elision.
 *
 * Authored 2026-05-09 BEFORE any fix lands, as part of the dissection
 * exercise verifying the hypothesis that "tests catch prior-round
 * archetypes, not current-round introduction archetypes". This test
 * exists to FAIL against current code; success would falsify the
 * hypothesis for this finding.
 *
 * R10-FG-4 says: 9 of 12 R9-FG entries in audit-coverage.json ship
 * with `coverageStrategy:'individual'` AND `tests:[]`. The Phase-3
 * annotation cross-check at audit-coverage.test.ts:122-147 loops
 * `for (const ref of f.tests)`. Empty array → vacuous pass. The
 * `'individual'` strategy was meant to be the strict per-finding-test
 * mandate; the empty-tests escape hatch defeats it. Goodhart-the-
 * default — exactly the archetype Phase-3 was created to prevent.
 *
 * Hypothesis-verification protocol: this test MUST FAIL right now.
 * No fix until the dissection is complete.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadManifest } from './audit-coverage-scan.js';

describe('R10-FG-4: manifest placebo gate (Phase-3 archetype recurrence)', () => {
  // revert-proof: R10-FG-4 — standalone behavioral mirror of the
  // canonical Phase-3 gate at audit-coverage.test.ts. Removing the
  // gate (or adding a new individual-strategy entry with tests:[])
  // flips this test. Kept as a dissection-discipline artifact
  // documenting the comment→test→code lockstep.
  it('individual-strategy entries declare at least one test', () => {
    const manifest = loadManifest();
    const empty = manifest.findings.filter(
      (f) => f.coverageStrategy === 'individual' && f.tests.length === 0,
    );
    assert.equal(
      empty.length,
      0,
      `Phase-3 placebo-by-elision (R10-FG-4): ${empty.length} entries declare ` +
        `coverageStrategy:'individual' but ship with tests:[]. ` +
        `The annotation cross-check at audit-coverage.test.ts:122-147 loops ` +
        `over the empty array → vacuous pass. ` +
        `Either populate tests:[...] or downgrade to ` +
        `coverageStrategy:'documentation-only'/'structural-gate'. ` +
        `Offending IDs: ${empty.map((f) => f.id).join(', ')}`,
    );
  });
});
