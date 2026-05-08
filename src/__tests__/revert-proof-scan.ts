/**
 * R4-0: helper module for the revert-proof gate. Lives in a non-test
 * file so the maintenance script can import the scan logic without
 * triggering `node:test`'s `describe`/`it` registration at import.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const REPO_ROOT = join(import.meta.dirname, '..', '..');
export const BASELINE_PATH = join(REPO_ROOT, 'src', '__tests__', 'revert-proof-baseline.json');

export interface Baseline {
  version: number;
  generatedAt?: string;
  fileCounts: Record<string, number>;
}

/**
 * Walk a directory recursively returning every `*.test.ts` /
 * `*.test.tsx` path (excluding node_modules / .next / dist / .git).
 */
export function findTestFiles(rootDir: string): string[] {
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
        (name.endsWith('.test.ts') || name.endsWith('.test.tsx'))
      ) {
        out.push(full);
      }
    }
  }
  recurse(rootDir);
  return out;
}

/**
 * Count `it(...)` / `test(...)` blocks in a file that LACK a
 * `revert-proof:` or `smoke-only:` comment within the 10 lines
 * immediately above the declaration.
 */
export function countUndocumentedBlocks(filePath: string): number {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const blockPattern = /^\s*(it|test)(?:\.\w+)?(?:\(|\s*<)/;
  let undocumented = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!blockPattern.test(line)) continue;
    const start = Math.max(0, i - 10);
    let documented = false;
    for (let j = start; j < i; j++) {
      const ln = lines[j]!;
      if (ln.includes('revert-proof:') || ln.includes('smoke-only:')) {
        documented = true;
        break;
      }
    }
    if (!documented) undocumented++;
  }
  return undocumented;
}

export function keyFor(filePath: string): string {
  return relative(REPO_ROOT, filePath).split(sep).join('/');
}

/**
 * Build a fileCounts map by scanning the live filesystem under
 * `src/` and `app/`.
 */
export function computeFileCounts(): Record<string, number> {
  const srcFiles = findTestFiles(join(REPO_ROOT, 'src'));
  const appFiles = findTestFiles(join(REPO_ROOT, 'app'));
  const all = [...srcFiles, ...appFiles].sort();
  const counts: Record<string, number> = {};
  for (const f of all) {
    const k = keyFor(f);
    const c = countUndocumentedBlocks(f);
    if (c > 0) counts[k] = c;
  }
  return counts;
}
