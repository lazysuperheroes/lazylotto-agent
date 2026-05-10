#!/usr/bin/env -S tsx
/**
 * Phase-3 R7: revert-drill runner.
 *
 * Annotation-counting (R4-0) and manifest cross-referencing (the
 * Phase-3 gate) only verify that a test claims to lock a fix. They
 * don't verify the test actually FAILS when the fix is reverted —
 * the whole point of "revert-proof". A test could pass before AND
 * after the revert (placebo); R2-FG-0 / R3-P8 / R4-P8 / R5-P8 /
 * R6-P8 each found ~4-12 such placebos.
 *
 * The drill physically validates the claim:
 *
 *   1. Look up the finding's `revertDrill` entry in audit-coverage.json.
 *   2. Apply the patch under `src/__tests__/revert-drills/<id>.patch`
 *      to the working tree (via `git apply`).
 *   3. Run the locked test(s) via `node --test --test-name-pattern`.
 *   4. Assert the test(s) FAIL. Pass = drill failed (test is a placebo).
 *   5. Revert the patch (always — even on error paths).
 *
 * Usage:
 *   npm run audit:revert-drill -- R6-FG-5
 *   npm run audit:revert-drill -- --list
 *   npm run audit:revert-drill -- --all   # run every drill in the manifest
 *
 * Safety: the runner refuses to run on a dirty worktree. It applies
 * patches to tracked files only and uses `git apply -R` to revert.
 * If reversion fails, it prints recovery instructions and exits 2 —
 * an operator-touchable signal that the worktree needs manual reset.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  COVERAGE_PATH,
  REPO_ROOT,
  drillPatchPath,
  loadManifest,
  type FindingEntry,
} from '../__tests__/audit-coverage-scan.js';

interface DrillResult {
  finding: string;
  status: 'passed' | 'failed_drill_did_not_fire' | 'patch_failed' | 'no_drill';
  detail: string;
}

function ensureCleanWorktree(): void {
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (status.status !== 0) {
    throw new Error(`git status failed: ${status.stderr}`);
  }
  if ((status.stdout ?? '').trim().length > 0) {
    throw new Error(
      `worktree is dirty — commit or stash before running the revert drill (it modifies tracked files):\n${status.stdout}`,
    );
  }
}

function runGitApply(patch: string, reverse: boolean): { ok: boolean; out: string } {
  const args = ['apply', ...(reverse ? ['-R'] : []), '--whitespace=nowarn', patch];
  const r = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: r.status === 0,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
}

function runTestPattern(pattern: string): { exitCode: number; output: string } {
  // node --test exits 1 when any test fails; that's what we WANT
  // here — drill PASS means tests fail.
  const r = spawnSync(
    'node',
    [
      '--test',
      '--import',
      'tsx',
      '--test-name-pattern',
      pattern,
      // Limit scope so unrelated tests' results don't pollute our
      // pass/fail signal. The manifest's test refs already name the
      // file; we run the entire test runner over src/ but the
      // pattern filters to the targeted block.
      'src',
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    },
  );
  return {
    exitCode: r.status ?? -1,
    output: `${r.stdout ?? ''}\n${r.stderr ?? ''}`,
  };
}

async function runDrill(finding: FindingEntry): Promise<DrillResult> {
  if (!finding.revertDrill) {
    return {
      finding: finding.id,
      status: 'no_drill',
      detail: 'no revertDrill spec on this entry — author one to enable physical verification',
    };
  }
  const patch = drillPatchPath(finding.revertDrill.patch);
  console.log(`\n[drill ${finding.id}] applying ${finding.revertDrill.patch}…`);
  const apply = runGitApply(patch, false);
  if (!apply.ok) {
    return {
      finding: finding.id,
      status: 'patch_failed',
      detail: `git apply failed:\n${apply.out}`,
    };
  }
  let allFailed = true;
  const detail: string[] = [];
  try {
    for (const pattern of finding.revertDrill.expectFail) {
      console.log(`[drill ${finding.id}] running tests matching /${pattern}/ — expecting FAIL…`);
      const r = runTestPattern(pattern);
      if (r.exitCode === 0) {
        // Tests still pass with the patch applied — the locked test
        // is a PLACEBO. The drill failed.
        allFailed = false;
        detail.push(
          `pattern "${pattern}" exited 0 (tests passed with revert patch applied) — locked test is a placebo`,
        );
      } else {
        detail.push(`pattern "${pattern}" exited ${r.exitCode} (tests failed as expected ✓)`);
      }
    }
  } finally {
    const revert = runGitApply(patch, true);
    if (!revert.ok) {
      console.error(
        `[drill ${finding.id}] CRITICAL: failed to revert patch — worktree may be left dirty.\n` +
          `Run \`git checkout -- .\` to reset.\n` +
          `Revert output:\n${revert.out}`,
      );
      process.exit(2);
    }
    console.log(`[drill ${finding.id}] patch reverted.`);
  }
  return {
    finding: finding.id,
    status: allFailed ? 'passed' : 'failed_drill_did_not_fire',
    detail: detail.join('\n'),
  };
}

function listDrills(manifest: ReturnType<typeof loadManifest>): void {
  console.log('Available revert-drills:');
  for (const f of manifest.findings) {
    if (!f.revertDrill) continue;
    console.log(
      `  ${f.id}  ←  ${f.revertDrill.patch}  (${f.revertDrill.expectFail.length} pattern${f.revertDrill.expectFail.length === 1 ? '' : 's'})`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(
      `usage:\n` +
        `  npm run audit:revert-drill -- <finding-id>   # run a single drill\n` +
        `  npm run audit:revert-drill -- --list         # list all drills\n` +
        `  npm run audit:revert-drill -- --all          # run every drill in the manifest\n`,
    );
    return;
  }
  const manifest = loadManifest();
  if (args.includes('--list')) {
    listDrills(manifest);
    return;
  }

  ensureCleanWorktree();

  const targets = args.includes('--all')
    ? manifest.findings.filter((f) => f.revertDrill !== null)
    : args
        .map((id) => manifest.findings.find((f) => f.id === id))
        .filter((f): f is FindingEntry => Boolean(f));

  if (targets.length === 0) {
    console.error(`no matching findings (or no revertDrill on the requested ids).`);
    console.error(`run with --list to see available drills.`);
    process.exit(1);
  }

  const results: DrillResult[] = [];
  for (const f of targets) {
    results.push(await runDrill(f));
  }

  console.log('\n=== Revert-drill summary ===');
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const emoji = r.status === 'passed' ? '✓' : r.status === 'no_drill' ? '·' : '✗';
    console.log(`  ${emoji} ${r.finding}: ${r.status}`);
    if (r.detail) console.log(`      ${r.detail.replace(/\n/g, '\n      ')}`);
    if (r.status === 'passed') passed++;
    else if (r.status !== 'no_drill') failed++;
  }
  console.log(`  passed: ${passed}, failed: ${failed}, no-drill: ${results.length - passed - failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[run-revert-drill] fatal:', err);
  process.exit(2);
});
