/**
 * Phase-3 R7: helper module for the audit-coverage gate.
 *
 * Reads `src/__tests__/audit-coverage.json` (the manifest pairing
 * each audit finding ID with its fix files + locking tests + an
 * optional revert-drill patch) and provides validated lookups for
 * the gate test + the drill runner script.
 *
 * Lives in a non-test file so the gate test, the doc generator, and
 * the drill runner can share one schema without triggering
 * `node:test` `describe`/`it` registration on import.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, resolve } from 'node:path';
import { z } from 'zod';

export const REPO_ROOT = join(import.meta.dirname, '..', '..');
export const COVERAGE_PATH = join(REPO_ROOT, 'src', '__tests__', 'audit-coverage.json');
export const DRILLS_DIR = join(REPO_ROOT, 'src', '__tests__', 'revert-drills');

// ── Manifest schema (single source of truth for JSON shape) ─

const FindingIdSchema = z
  .string()
  .regex(/^[A-Z]+\d+-FG-\d+$|^R\d+-Phase-\d+$|^F\d+$/)
  .describe(
    'Audit finding identifier. Patterns: "R<round>-FG-<index>" (per-round finding), "R<round>-Phase-<n>" (structural multi-finding fix), or "F<n>" (legacy 2026-05-06 audit).',
  );

const TestRefSchema = z.object({
  /** Repo-relative path with forward slashes. */
  file: z
    .string()
    .regex(/^[^\\]+$/, 'use forward slashes only')
    .describe('Repo-relative test file (forward slashes; e.g. "src/custodial/AccountingService.test.ts")'),
  /**
   * Substring of the `it(...)` / `test(...)` name. The gate looks
   * for any line in `file` where this substring appears inside a
   * test-block declaration. Make it precise enough to match exactly
   * one test (the gate enforces uniqueness).
   */
  name: z.string().min(3).describe('Substring uniquely identifying the test block in `file`'),
});

const FixLocationSchema = z.object({
  file: z.string().describe('Repo-relative source file containing the fix'),
  /** Optional line range — informative, not enforced. */
  lines: z.string().optional().describe('Line range or anchor (e.g. "1414-1474" or "submitV2Message")'),
});

export const FindingEntrySchema = z.object({
  id: FindingIdSchema,
  round: z.string().describe('Round identifier — "R6", "structural", "F", etc.'),
  severity: z
    .enum(['critical', 'high', 'medium', 'low', 'structural', 'doc'])
    .describe('Triage severity from the originating audit'),
  summary: z.string().min(10).describe('One-sentence description of the bug class'),
  /**
   * R8-FG-12 / Phase-6 Cluster D: explicit coverage-strategy enum
   * replaces the pre-Phase-6 `notes`-substring exemption. Pre-fix
   * the bidirectional cross-check soft-allowed any entry whose
   * `notes` field contained the words 'structural', 'Locked by',
   * 'locked by', or 'archetype' — accidental keyword matches let
   * ~4 of 11 entries silently bypass the per-finding annotation
   * requirement. The enum makes the bypass an explicit, auditable
   * decision per entry.
   *
   *   - 'individual'        → entry has its own per-finding
   *                           revert-proof-annotated locking test;
   *                           the gate enforces both annotation +
   *                           test-existence cross-references.
   *   - 'structural-gate'   → entry is locked by a STRUCTURAL gate
   *                           (e.g. claim-archetype-gate.test.ts)
   *                           that catches the archetype across
   *                           multiple findings collectively. The
   *                           per-finding annotation requirement
   *                           is waived; the test-existence check
   *                           still runs.
   *   - 'documentation-only' → entry exists for record-keeping only;
   *                           no locking test at all.
   */
  coverageStrategy: z
    .enum(['individual', 'structural-gate', 'documentation-only'])
    .default('individual')
    .describe('Phase-6 R8-FG-12 / R9-P10-008 Phase-7 default: explicit per-entry coverage strategy. Replaces accidental notes-substring exemption. Defaults to `individual` so a backport that omits the field gets the strictest setting (annotation cross-check required) rather than failing the whole gate at parse time.'),
  fix: z.object({
    files: z.array(FixLocationSchema).min(1).describe('Source locations the fix touched'),
    commit: z.string().optional().describe('Git SHA (or a short prefix) where the fix landed'),
  }),
  tests: z
    .array(TestRefSchema)
    .describe('Test blocks that should fail if the fix is reverted (may be empty for documentation-only entries)'),
  revertDrill: z
    .object({
      patch: z.string().describe('Filename under src/__tests__/revert-drills/ (e.g. "R6-FG-1.patch")'),
      expectFail: z
        .array(z.string())
        .min(1)
        .describe('node:test --test-name-pattern values that MUST fail when the patch is applied'),
    })
    .nullable()
    .describe(
      'When present, `npm run audit:revert-drill <id>` applies the patch and asserts the listed tests fail. Null while authoring is in progress; new R7+ findings SHOULD ship with one.',
    ),
  notes: z.string().optional().describe('Free-form context (why no test, related findings, etc.)'),
});

export const CoverageManifestSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().describe('ISO date the manifest was last hand-edited'),
  description: z.string().describe('Short prose explaining the manifest purpose'),
  findings: z.array(FindingEntrySchema).describe('Per-finding coverage entries'),
});

export type CoverageManifest = z.infer<typeof CoverageManifestSchema>;
export type FindingEntry = z.infer<typeof FindingEntrySchema>;
export type TestRef = z.infer<typeof TestRefSchema>;

// ── Manifest IO ─────────────────────────────────────────────

export function loadManifest(): CoverageManifest {
  const raw = readFileSync(COVERAGE_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return CoverageManifestSchema.parse(parsed);
}

// ── Test-existence checks ───────────────────────────────────

/**
 * Verify that a test block matching `ref.name` exists in `ref.file`.
 * Returns the line number on the unique match, `null` when not
 * found, or throws when the name substring matches MORE than one
 * test block.
 *
 * R8-FG-30 / Phase-6 Cluster D: uniqueness enforced. Pre-fix
 * `findTestLine` returned the FIRST match, so two `it('...')` blocks
 * sharing a substring (e.g. `'releases the claim on a non-preserve
 * throw'` vs a future `'... with delay'`) made the manifest lock
 * the wrong test silently. The schema docstring promised
 * uniqueness; the implementation didn't enforce it.
 */
export function findTestLine(ref: TestRef): number | null {
  const fullPath = resolve(REPO_ROOT, ref.file);
  if (!existsSync(fullPath)) return null;
  const text = readFileSync(fullPath, 'utf8');
  const lines = text.split(/\r?\n/);
  // Match `it('...'`, `it("...","`, `test(`...etc., then look for the
  // name substring inside the literal.
  const blockPattern = /^\s*(it|test)(?:\.\w+)?\s*[<(]/;
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!blockPattern.test(lines[i]!)) continue;
    if (lines[i]!.includes(ref.name)) matches.push(i + 1);
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `[audit-coverage] test name "${ref.name}" in ${ref.file} matches ${matches.length} blocks ` +
        `(at lines ${matches.join(', ')}). The manifest's test reference must be unique. ` +
        `Tighten the substring so it identifies exactly one block.`,
    );
  }
  return matches[0]!;
}

/**
 * Verify that the locking test has a `revert-proof:` annotation
 * within 10 lines above its declaration that mentions the finding
 * id. This is the bidirectional consistency check between Phase-3
 * coverage and the R4-0 gate's annotation discipline.
 */
export function findRevertProofAnnotation(
  ref: TestRef,
  findingId: string,
): { line: number; text: string } | null {
  const fullPath = resolve(REPO_ROOT, ref.file);
  if (!existsSync(fullPath)) return null;
  const text = readFileSync(fullPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const blockPattern = /^\s*(it|test)(?:\.\w+)?\s*[<(]/;
  for (let i = 0; i < lines.length; i++) {
    if (!blockPattern.test(lines[i]!)) continue;
    if (!lines[i]!.includes(ref.name)) continue;
    const start = Math.max(0, i - 10);
    for (let j = start; j < i; j++) {
      const ln = lines[j]!;
      if (ln.includes('revert-proof:') && ln.includes(findingId)) {
        return { line: j + 1, text: ln.trim() };
      }
    }
    return null;
  }
  return null;
}

/**
 * Verify the fix file actually exists on disk. A fix entry pointing
 * to a renamed/deleted file is a stale manifest — the gate flags it.
 */
export function fixFileExists(file: string): boolean {
  return existsSync(resolve(REPO_ROOT, file));
}

// ── Drill patch lookup ──────────────────────────────────────

export function listDrillPatches(): string[] {
  if (!existsSync(DRILLS_DIR)) return [];
  return readdirSync(DRILLS_DIR)
    .filter((n) => n.endsWith('.patch') && statSync(join(DRILLS_DIR, n)).isFile())
    .sort();
}

export function drillPatchPath(filename: string): string {
  return join(DRILLS_DIR, filename);
}

export function keyFor(filePath: string): string {
  return relative(REPO_ROOT, filePath).split(sep).join('/');
}
