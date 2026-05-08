/**
 * R6 Phase 1: structural lint gate against the R5-FG-3 sibling-miss
 * archetype.
 *
 * Background: R5 introduced `safeSubmit` + `PostSubmitError` (a sibling
 * subclass of `ReceiptUncertainError` under the parent `PreserveClaimError`).
 * Every callsite that used `instanceof ReceiptUncertainError` to gate
 * "preserve the idempotency claim / reserve" became a sibling miss —
 * a `PostSubmitError` (the new shape covering signer-disposed, V8 OOM,
 * network reset between execute() and awaitReceipt) fell through and
 * triggered a release. The R6 audit found 5 critical double-spend
 * windows of this archetype.
 *
 * The structural fix: callers MUST gate on the parent class
 * `PreserveClaimError`, never on a specific subclass. The parent now
 * exposes `transactionId` so `instanceof PreserveClaimError` narrows
 * correctly. The lint enforces this — any `instanceof
 * ReceiptUncertainError` or `instanceof PostSubmitError` outside
 * `src/hedera/transfers.ts` (where the classes are defined) and the
 * test files that exercise them is REJECTED.
 *
 * This file is the helper module; the gate test lives at
 * `src/__tests__/sibling-archetype-gate.test.ts`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const REPO_ROOT = join(import.meta.dirname, '..', '..');

/**
 * Files allowed to use `instanceof ReceiptUncertainError` /
 * `instanceof PostSubmitError` directly:
 *   - the source file where the classes are declared
 *   - the unit-test files that exercise the classes' contracts
 */
const ALLOWED_PATHS = new Set<string>([
  'src/hedera/transfers.ts',
  'src/hedera/transfers.test.ts',
  'src/hedera/contracts.test.ts', // R6-FG-5: test asserts both subclasses extend PreserveClaimError
  'src/lib/idempotency.test.ts',
  // The gate's own files reference the forbidden patterns in
  // comments, error messages, and regex sources. Self-reference is
  // intrinsic to the gate's job; allow.
  'src/__tests__/sibling-archetype-gate.ts',
  'src/__tests__/sibling-archetype-gate.test.ts',
  // Test files that build the error types as test fixtures are allowed
  // to reference them by name. Adding a file here is a documented
  // exception — review at PR time.
]);

const FORBIDDEN_PATTERNS: { regex: RegExp; description: string }[] = [
  {
    regex: /\binstanceof\s+ReceiptUncertainError\b/g,
    description: 'instanceof ReceiptUncertainError',
  },
  {
    regex: /\binstanceof\s+PostSubmitError\b/g,
    description: 'instanceof PostSubmitError',
  },
];

export interface Violation {
  file: string;
  line: number;
  text: string;
  pattern: string;
}

/**
 * Walk a directory recursively returning every TypeScript source file
 * (`.ts`/`.tsx`), excluding node_modules / .next / dist / .git.
 */
function findSourceFiles(rootDir: string): string[] {
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
 * Scan the codebase for forbidden `instanceof` patterns. Returns one
 * Violation per match.
 */
export function findViolations(): Violation[] {
  const srcFiles = findSourceFiles(join(REPO_ROOT, 'src'));
  const appFiles = findSourceFiles(join(REPO_ROOT, 'app'));
  const all = [...srcFiles, ...appFiles].sort();
  const violations: Violation[] = [];
  for (const fullPath of all) {
    const relPath = keyFor(fullPath);
    if (ALLOWED_PATHS.has(relPath)) continue;
    const text = readFileSync(fullPath, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Skip comments — `// instanceof ReceiptUncertainError` is fine.
      const codeOnly = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const { regex, description } of FORBIDDEN_PATTERNS) {
        regex.lastIndex = 0;
        if (regex.test(codeOnly)) {
          violations.push({
            file: relPath,
            line: i + 1,
            text: line.trim(),
            pattern: description,
          });
        }
      }
    }
  }
  return violations;
}
