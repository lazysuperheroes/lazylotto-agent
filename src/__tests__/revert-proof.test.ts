/**
 * R4-0: revert-proof test discipline.
 *
 * The R2-FG-0 archetype — tests that pass even when the production
 * fix is reverted — has now surfaced in three consecutive audit
 * rounds (R2-FG-0 / R3-P8 / R4-P8). Each round identified ~4-12 tests
 * whose assertions don't actually exercise the fix path. Each round
 * called out the issue. Each round, the discipline didn't stick.
 *
 * This file is the gate. It enforces a one-way ratchet:
 *
 *   1. Every test file is scanned for `it(...)` and `test(...)` blocks.
 *   2. Each block must have, within 10 lines above its declaration,
 *      a comment containing `revert-proof:` (the assertion that
 *      proves the test fails on revert) OR `smoke-only:` (an explicit
 *      opt-out for sanity tests that don't lock in a specific fix).
 *   3. Pre-existing tests are grandfathered via a baseline at
 *      `src/__tests__/revert-proof-baseline.json` listing the count
 *      of undocumented blocks per file as of round 4.
 *   4. The gate FAILS if any file's undocumented count EXCEEDS its
 *      baseline. Adding a new test without a `revert-proof:` /
 *      `smoke-only:` comment increases the file's count → CI fails.
 *      Tightening a legacy test (adding the comment) decreases the
 *      count, which is allowed; the developer should also update
 *      the baseline downward in the same commit (`npm run
 *      revert-proof:update-baseline` regenerates it).
 *
 * The `revert-proof:` comment must be specific. A useful one names
 * the function and value that would change on revert. Reviewers
 * (and future audits) read these comments to validate that the test
 * actually exercises the claimed behaviour.
 *
 * Example:
 *
 *   ```ts
 *   // revert-proof: if validateProgressOrdering reverts to the
 *   // self-heal back-fill (R2-FG-13), the assertion
 *   // `outcomes[0].status === 'still_uncertain'` becomes
 *   // `'confirmed'` and this test fails.
 *   it('R3-FG-3: incoherent markers escalate', async () => { ... });
 *   ```
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  BASELINE_PATH,
  REPO_ROOT,
  computeFileCounts,
  type Baseline,
} from './revert-proof-scan.js';

describe('R4-0: revert-proof test gate', () => {
  // smoke-only: this gate enforces a discipline; it has no production
  // code path to revert.
  it('baseline file exists and is valid JSON', () => {
    assert.ok(existsSync(BASELINE_PATH), `baseline missing at ${BASELINE_PATH}`);
    const raw = readFileSync(BASELINE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Baseline;
    assert.equal(typeof parsed.version, 'number');
    assert.equal(typeof parsed.fileCounts, 'object');
  });

  // smoke-only: gate-of-gates; the production thing this protects is
  // the discipline itself.
  it('no test file exceeds its baseline undocumented-block count', () => {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
    const live = computeFileCounts();
    const offenders: string[] = [];
    for (const [file, count] of Object.entries(live)) {
      const baselineCount = baseline.fileCounts[file] ?? 0;
      if (count > baselineCount) {
        offenders.push(
          `  ${file}: live=${count} > baseline=${baselineCount} (added ${count - baselineCount} undocumented test${count - baselineCount === 1 ? '' : 's'})`,
        );
      }
    }
    if (offenders.length > 0) {
      assert.fail(
        `\n\nRevert-proof gate violations — new test(s) without 'revert-proof:' or 'smoke-only:' comment.\n\n` +
          offenders.join('\n') +
          `\n\nFix: add a comment within 10 lines above the test declaration:\n` +
          `  // revert-proof: <one sentence naming the function and value that change on revert>\n` +
          `  // smoke-only: <if the test is a sanity check and doesn't lock a specific fix>\n\n` +
          `Or, if you tightened a legacy test (decreased count), regenerate the baseline:\n` +
          `  npm run revert-proof:update-baseline\n\n`,
      );
    }
  });

  // smoke-only: helps devs notice they should regenerate the baseline.
  it('baseline does not over-count files that have been fully documented', () => {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
    const live = computeFileCounts();
    const stale: string[] = [];
    for (const file of Object.keys(baseline.fileCounts)) {
      const fullPath = join(REPO_ROOT, file);
      if (
        existsSync(fullPath) &&
        live[file] === undefined &&
        baseline.fileCounts[file]! > 0
      ) {
        stale.push(`  ${file}: baseline=${baseline.fileCounts[file]} but live=0`);
      }
    }
    if (stale.length > 0) {
      console.warn(
        `\nrevert-proof: ${stale.length} baseline entr${stale.length === 1 ? 'y is' : 'ies are'} now over-counted (legacy tests were documented):\n` +
          stale.join('\n') +
          `\nRun \`npm run revert-proof:update-baseline\` to lock these wins in.\n`,
      );
    }
  });
});
