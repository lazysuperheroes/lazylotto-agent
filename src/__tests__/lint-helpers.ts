/**
 * Phase-6 Cluster B: shared scanner for the structural lint gates.
 *
 * Background: pre-Phase-6 each archetype gate
 * (`sibling-archetype-gate.ts`, `claim-archetype-gate.ts`) had its
 * own line-by-line scanner. Multi-line patterns slipped through —
 * R8-FG-3 (claim gate) and R8-FG-29 (sibling gate's per-line block-
 * comment strip false-positives) both stem from that.
 *
 * This module is the canonical scanner. Both gates call it. The
 * scanner:
 *
 *   1. Reads each file's text in full (NOT line-by-line).
 *   2. Strips block comments and line comments file-wide while
 *      preserving line numbers (each comment char becomes a space).
 *   3. Runs each pattern in multi-line mode so `redis.set(\n  KEY,\n
 *      { nx: true })` matches even when split across lines.
 *   4. Returns line numbers via offset → line mapping.
 *
 * If a pattern matches, the gate fails CI. The migration story is
 * always "either route through the approved primitive or add the
 * file to ALLOWED_PATHS with documented rationale".
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const REPO_ROOT = join(import.meta.dirname, '..', '..');

export interface LintPattern {
  regex: RegExp;
  description: string;
}

export interface LintViolation {
  file: string;
  line: number;
  text: string;
  pattern: string;
}

/**
 * Walk a directory recursively returning every TypeScript source
 * file (`.ts`/`.tsx`), excluding node_modules / .next / dist / .git.
 */
export function findSourceFiles(rootDir: string): string[] {
  const out: string[] = [];
  function recurse(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.next' || name === 'dist' || name === '.git') {
        continue;
      }
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        recurse(full);
      } else if (
        st.isFile() &&
        (name.endsWith('.ts') || name.endsWith('.tsx')) &&
        !name.endsWith('.d.ts')
      ) {
        out.push(full);
      }
    }
  }
  recurse(rootDir);
  return out;
}

export function keyFor(filePath: string): string {
  return relative(REPO_ROOT, filePath).split(sep).join('/');
}

/**
 * File-wide COMMENT strip that preserves line numbers. Replaces
 * every character inside a block comment or line comment with a
 * space (newlines preserved). After this pass, regex matches in
 * comments cannot fire — exactly the R8-FG-29 false-positive
 * defense.
 *
 * Strings are NOT stripped. The name-string sibling-miss patterns
 * (R8-FG-4: `err.name === 'PostSubmitError'`) match the string
 * literal's inside content; stripping strings would mask the
 * pattern. Code that puts the forbidden text in a string literal
 * (rare) can grandfather the file in ALLOWED_PATHS.
 *
 * Line numbers preserved by replacing each non-newline char with
 * a space.
 *
 * R9-P1-004 / R9-P10-002 / Phase-7 Cluster H: renamed from
 * `stripCommentsAndStrings`. The pre-Phase-7 name implied a two-
 * step strip but the body only stripped comments. The new name
 * matches the actual behavior.
 */
export function stripComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const c2 = text[i + 1];
    // Block comment: /* ... */
    if (c === '/' && c2 === '*') {
      out.push('  '); // replace `/*`
      i += 2;
      while (i < text.length) {
        const cc = text[i]!;
        const cc2 = text[i + 1];
        if (cc === '*' && cc2 === '/') {
          out.push('  '); // replace `*/`
          i += 2;
          break;
        }
        out.push(cc === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }
    // Line comment: // ... \n
    if (c === '/' && c2 === '/') {
      out.push('  '); // replace `//`
      i += 2;
      while (i < text.length && text[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }
    // Strings pass through unchanged (R8-FG-4 fix: name-string
    // patterns need to see literal contents).
    out.push(c);
    i++;
  }
  return out.join('');
}

/**
 * Scan a list of files for forbidden patterns. Returns one
 * violation per match. Skips files in `allowedPaths`.
 *
 * `patterns` MUST use the `g` flag for multi-match. The scanner
 * runs each pattern over the full file text (not per-line) so
 * multi-line patterns like `redis.set(\n  KEY,\n  { nx: true })`
 * are caught — exactly the R8-FG-3 archetype.
 */
export function scanForViolations(
  files: string[],
  allowedPaths: ReadonlySet<string>,
  patterns: readonly LintPattern[],
): LintViolation[] {
  const violations: LintViolation[] = [];
  for (const fullPath of files) {
    const relPath = keyFor(fullPath);
    if (allowedPaths.has(relPath)) continue;
    const raw = readFileSync(fullPath, 'utf8');
    const stripped = stripComments(raw);
    // Build offset → line table for the stripped text. Since we
    // preserved newlines, the same offset maps to the same line in
    // both raw and stripped.
    const lines = raw.split(/\r?\n/);
    const lineOffsets: number[] = [0];
    for (let k = 0; k < raw.length; k++) {
      if (raw[k] === '\n') lineOffsets.push(k + 1);
    }
    const offsetToLine = (offset: number): number => {
      // Binary search.
      let lo = 0;
      let hi = lineOffsets.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (lineOffsets[mid]! <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };

    for (const { regex, description } of patterns) {
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(stripped)) !== null) {
        const offset = m.index;
        const lineNum = offsetToLine(offset);
        violations.push({
          file: relPath,
          line: lineNum,
          text: (lines[lineNum - 1] ?? '').trim(),
          pattern: description,
        });
        if (m.index === regex.lastIndex) regex.lastIndex++; // safety for zero-width matches
      }
    }
  }
  return violations;
}

/**
 * Convenience: scan both `src/` and `app/` (the project's
 * production roots). Both archetype gates use this entrypoint.
 */
export function scanProductionRoots(
  allowedPaths: ReadonlySet<string>,
  patterns: readonly LintPattern[],
): LintViolation[] {
  const srcFiles = findSourceFiles(join(REPO_ROOT, 'src'));
  const appFiles = findSourceFiles(join(REPO_ROOT, 'app'));
  const all = [...srcFiles, ...appFiles].sort();
  return scanForViolations(all, allowedPaths, patterns);
}

/**
 * Test-only entrypoint: run the same comment-stripping + pattern
 * matching used by `scanForViolations`, but against synthetic text
 * instead of files. Used by the gate test files to author
 * deliberate-plant fixtures asserting the patterns fire.
 */
export function scanText(
  text: string,
  patterns: readonly LintPattern[],
): { description: string; line: number }[] {
  const stripped = stripComments(text);
  const matches: { description: string; line: number }[] = [];
  const lineOffsets: number[] = [0];
  for (let k = 0; k < text.length; k++) {
    if (text[k] === '\n') lineOffsets.push(k + 1);
  }
  const offsetToLine = (offset: number): number => {
    let lo = 0;
    let hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineOffsets[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  for (const { regex, description } of patterns) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(stripped)) !== null) {
      matches.push({ description, line: offsetToLine(m.index) });
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }
  }
  return matches;
}
