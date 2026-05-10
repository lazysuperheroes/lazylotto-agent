/**
 * Phase-3 R7: audit-coverage gate.
 *
 * Bridges the gap between R4-0 (annotation discipline) and a real
 * behavior-verification ratchet. R4-0 enforces every test has a
 * `revert-proof:` annotation — but the annotation could lie. Phase 3
 * adds a manifest (`audit-coverage.json`) listing every shipped
 * audit-finding fix and the test(s) that lock it. This gate enforces:
 *
 *   1. The manifest itself is valid (Zod schema in audit-coverage-scan.ts).
 *   2. Every fix file referenced still exists (catches stale entries
 *      after refactors).
 *   3. Every locking test reference resolves to a real `it(...)` /
 *      `test(...)` block with a substring-matching name.
 *   4. Every locking test has a `revert-proof:` annotation within 10
 *      lines that mentions the finding ID — bidirectional consistency
 *      with the R4-0 gate.
 *   5. Finding IDs are unique within the manifest.
 *
 * The gate is a one-way ratchet: removing an entry from the manifest
 * is allowed (e.g. when a fix becomes obsolete) but the test it
 * referenced must either still exist OR be deleted in the same
 * change. New R7+ findings that don't ship with a manifest entry
 * surface as gaps in the next round's audit — the discipline turns
 * audits from vector-finders into regression-finders.
 *
 * The optional `revertDrill` field on each entry is honored by
 * `npm run audit:revert-drill -- <id>` (separate runner). When
 * present, the drill applies the patch and asserts the listed test
 * patterns FAIL — physical revert verification, not annotation
 * counting. New findings SHOULD ship with one but legacy entries
 * are grandfathered as `revertDrill: null`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadManifest,
  findTestLine,
  findRevertProofAnnotation,
  fixFileExists,
  listDrillPatches,
  drillPatchPath,
  REPO_ROOT,
} from './audit-coverage-scan.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

describe('Phase-3 R7: audit-coverage gate', () => {
  // smoke-only: this gate enforces the manifest discipline; it has no
  // production code path to revert.
  it('manifest parses against the Zod schema', () => {
    assert.doesNotThrow(() => loadManifest());
  });

  // revert-proof: removing the unique-ID enforcement lets a typo in
  // the manifest silently shadow an earlier entry; the gate would
  // pass while one finding's coverage was overwritten.
  it('finding IDs are unique', () => {
    const manifest = loadManifest();
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const f of manifest.findings) {
      if (seen.has(f.id)) dupes.push(f.id);
      seen.add(f.id);
    }
    assert.equal(dupes.length, 0, `duplicate finding IDs: ${dupes.join(', ')}`);
  });

  // revert-proof: removing the file-existence check would let a
  // refactor silently invalidate a fix reference (e.g. file renamed,
  // entry not updated) without surfacing in CI.
  it('every fix file referenced exists on disk', () => {
    const manifest = loadManifest();
    const missing: string[] = [];
    for (const f of manifest.findings) {
      for (const loc of f.fix.files) {
        if (!fixFileExists(loc.file)) {
          missing.push(`${f.id}: ${loc.file}`);
        }
      }
    }
    assert.equal(
      missing.length,
      0,
      `audit-coverage.json points to missing fix files:\n  ` + missing.join('\n  '),
    );
  });

  // revert-proof: removing the test-resolution check lets the
  // manifest claim coverage that doesn't exist (entry references
  // a deleted or renamed test); the user-visible coverage report
  // would lie.
  it('every locking test reference resolves to a real test block', () => {
    const manifest = loadManifest();
    const broken: string[] = [];
    for (const f of manifest.findings) {
      for (const ref of f.tests) {
        const line = findTestLine(ref);
        if (line === null) {
          broken.push(`${f.id}: ${ref.file} :: "${ref.name}"`);
        }
      }
    }
    assert.equal(
      broken.length,
      0,
      `audit-coverage.json references missing test blocks:\n  ` + broken.join('\n  '),
    );
  });

  // revert-proof: R8-FG-12 — removing the annotation cross-check
  // (or relaxing the `coverageStrategy` enum back to a notes-
  // substring soft-allow) lets a test claim to lock a finding
  // without naming it in the revert-proof comment. The
  // bidirectional invariant would weaken to one-way.
  //
  // Phase-6 Cluster D: the soft-allow is now an explicit
  // `coverageStrategy: 'structural-gate' | 'documentation-only'`
  // field on each entry. Substring keyword matches in `notes` no
  // longer bypass the cross-check.
  it('every locking test carries a revert-proof annotation referencing the finding ID', () => {
    const manifest = loadManifest();
    const missing: string[] = [];
    for (const f of manifest.findings) {
      // Phase-6: explicit coverageStrategy waivers replace the
      // pre-Phase-6 notes-substring soft-allow.
      // Phase-9 Cluster A: documentation-only struck (R11-FG-2);
      // only structural-gate waiver remains.
      if (f.coverageStrategy === 'structural-gate') continue;
      // 'individual' coverage: every locking test MUST carry the
      // revert-proof annotation naming the finding id.
      for (const ref of f.tests) {
        const annotation = findRevertProofAnnotation(ref, f.id);
        if (!annotation) {
          missing.push(
            `${f.id}: ${ref.file} :: "${ref.name}" — no \`revert-proof: ... ${f.id} ...\` within 10 lines above the test`,
          );
        }
      }
    }
    assert.equal(
      missing.length,
      0,
      `Phase-3 cross-reference violations (every 'individual'-strategy entry's locking test must carry a revert-proof annotation naming the finding ID):\n  ` +
        missing.join('\n  '),
    );
  });

  // revert-proof: removing the drill-patch existence check lets the
  // manifest declare a revertDrill that points to a missing patch
  // file — the runner would silently no-op.
  it('every revertDrill.patch file exists when declared', () => {
    const manifest = loadManifest();
    const missing: string[] = [];
    for (const f of manifest.findings) {
      if (!f.revertDrill) continue;
      const path = drillPatchPath(f.revertDrill.patch);
      if (!existsSync(path)) {
        missing.push(`${f.id}: ${f.revertDrill.patch}`);
      }
    }
    assert.equal(
      missing.length,
      0,
      `audit-coverage.json declares revertDrill patches that don't exist:\n  ` +
        missing.join('\n  '),
    );
  });

  // revert-proof: R10-FG-4 / Phase-8 Cluster A — placebo-by-elision
  // gate. Pre-Phase-8 the annotation cross-check at lines 122-147
  // looped `for (const ref of f.tests)`; an empty array vacuously
  // passed. 9 of 12 R9-FG entries shipped with
  // coverageStrategy:'individual' AND tests:[] — the strict setting
  // defeated by its own escape hatch. Removing this it() block (or
  // changing the predicate) flips the test against any
  // individual-strategy entry that lacks a locking test.
  it('R10-FG-4: individual-strategy entries declare at least one test', () => {
    const manifest = loadManifest();
    const empty = manifest.findings.filter(
      (f) => f.coverageStrategy === 'individual' && f.tests.length === 0,
    );
    assert.equal(
      empty.length,
      0,
      `Phase-3 placebo-by-elision: ${empty.length} entries declare ` +
        `coverageStrategy:'individual' but ship with tests:[]. ` +
        `Either populate tests:[...] with a real revert-proof-annotated ` +
        `locking test, or change to coverageStrategy:'structural-gate' ` +
        `(only valid when locked by a structural fixture). ` +
        `Offending IDs: ${empty.map((f) => f.id).join(', ')}`,
    );
  });

  // smoke-only: surfaces the count + drill availability for visual
  // CI inspection. The other tests do the actual gating.
  it('coverage status snapshot', () => {
    const manifest = loadManifest();
    const drillsAuthored = manifest.findings.filter((f) => f.revertDrill !== null).length;
    const drillsAvailable = listDrillPatches().length;
    console.log(
      `[audit-coverage] manifest entries: ${manifest.findings.length}, ` +
        `revert-drills authored: ${drillsAuthored}, ` +
        `drill patch files: ${drillsAvailable}`,
    );
    // Snapshot only — never fails. Used by reviewers to monitor
    // ratchet progress over rounds.
    assert.ok(manifest.findings.length >= 0);
  });

  // smoke-only: R8-FG-21 / Phase-6 Cluster G — manifest-vs-audit-doc
  // coverage ratio. Walks every `docs/audit-2026-*-round*.md`,
  // extracts every R<N>-FG-<n> id, compares to manifest entries.
  // Reports the ratio so reviewers can see the manifest's coverage
  // trajectory over rounds. Pre-Phase-6 the manifest's description
  // claimed "every shipped audit-finding fix" but covered ~9 of 115
  // R6 findings — the gate enforced "every entry has a real test"
  // but never the inverse. This counter makes under-claim visible.
  // Never fails CI by default — operator's call.
  it('manifest-vs-audit-doc coverage ratio (informational)', () => {
    const auditDocsDir = join(REPO_ROOT, 'docs');
    const findingIdRegex = /R\d+-FG-\d+/g;
    let totalFindingIds = new Set<string>();
    try {
      const entries = readdirSync(auditDocsDir);
      for (const name of entries) {
        if (!/^audit-\d{4}-\d{2}-\d{2}-round\d+\.md$/.test(name)) continue;
        const text = readFileSync(join(auditDocsDir, name), 'utf8');
        const ids = text.match(findingIdRegex) ?? [];
        for (const id of ids) totalFindingIds.add(id);
      }
    } catch {
      // docs dir missing — bail; the gate isn't load-bearing.
      return;
    }
    const manifest = loadManifest();
    const tracked = new Set(
      manifest.findings.filter((f) => /R\d+-FG-\d+/.test(f.id)).map((f) => f.id),
    );
    const total = totalFindingIds.size;
    const trackedCount = [...tracked].filter((id) => totalFindingIds.has(id)).length;
    console.log(
      `[audit-coverage] manifest tracks ${trackedCount} of ${total} ` +
        `R<N>-FG-<n> findings across audit docs ` +
        `(${total > 0 ? Math.round((trackedCount * 100) / total) : 0}% coverage). ` +
        `Structural-gate entries cover additional findings collectively; ` +
        `see coverageStrategy field on each entry.`,
    );
    assert.ok(true);
  });
});
