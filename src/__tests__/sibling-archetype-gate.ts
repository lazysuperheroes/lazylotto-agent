/**
 * R6 Phase 1 + Phase-6 Cluster B: structural lint gate against the
 * R5-FG-3 sibling-miss archetype.
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
 * correctly.
 *
 * Phase-6 R8-FG-4 / R6-FG-17 closure: the gate now ALSO forbids
 * `err.name === 'ReceiptUncertainError'` and
 * `err.constructor.name === 'PostSubmitError'` (and variants). Pre-fix
 * `idempotency.ts:60`'s cross-bundle name fallback was the EXACT
 * R5-FG-3 archetype inside the helper meant to defend against it —
 * because the gate only looked for `instanceof X` patterns.
 *
 * Phase-6 R8-FG-29 closure: the gate now uses the shared
 * `lint-helpers.ts` whole-file scanner that strips block comments
 * file-wide preserving line numbers. Pre-fix the per-line strip
 * could false-positive on multi-line block comments mentioning
 * forbidden patterns.
 *
 * This file is the helper module; the gate test lives at
 * `src/__tests__/sibling-archetype-gate.test.ts`.
 */

import {
  scanProductionRoots,
  type LintPattern,
  type LintViolation,
} from './lint-helpers.js';

export { REPO_ROOT, keyFor } from './lint-helpers.js';

/**
 * Files allowed to use `instanceof ReceiptUncertainError` /
 * `instanceof PostSubmitError` (or the name-string variants) directly:
 *   - the source file where the classes are declared
 *   - the unit-test files that exercise the classes' contracts
 *   - the gate's own files (regex source self-references)
 */
const ALLOWED_PATHS = new Set<string>([
  'src/hedera/transfers.ts',
  'src/hedera/transfers.test.ts',
  'src/hedera/contracts.test.ts', // R6-FG-5: test asserts both subclasses extend PreserveClaimError
  'src/lib/idempotency.test.ts',
  // R8-FG-4 / R6-FG-17 closure: `idempotency.ts` is the CANONICAL
  // host for the cross-bundle name-string fallback (the
  // `isPreserveClaim` helper). It MUST check both subclass names
  // by string because the whole point is the defense-in-depth path
  // when `instanceof PreserveClaimError` fails under module-bundle
  // drift. The gate forbids this archetype EVERYWHERE ELSE so the
  // helper is the single audited source of truth.
  'src/lib/idempotency.ts',
  // The gate's own files reference the forbidden patterns in
  // comments, error messages, and regex sources. Self-reference is
  // intrinsic to the gate's job; allow.
  'src/__tests__/sibling-archetype-gate.ts',
  'src/__tests__/sibling-archetype-gate.test.ts',
  'src/__tests__/lint-helpers.ts',
  // Test files that build the error types as test fixtures are allowed
  // to reference them by name. Adding a file here is a documented
  // exception — review at PR time.
]);

export const FORBIDDEN_PATTERNS: LintPattern[] = [
  {
    regex: /\binstanceof\s+ReceiptUncertainError\b/g,
    description: 'instanceof ReceiptUncertainError',
  },
  {
    regex: /\binstanceof\s+PostSubmitError\b/g,
    description: 'instanceof PostSubmitError',
  },
  {
    // R8-FG-4 / R6-FG-17: name-string checks on PreserveClaim subclasses.
    // Pre-Phase-6 `isPreserveClaim`'s cross-bundle fallback at
    // idempotency.ts:60 used `err.name === 'ReceiptUncertainError'` —
    // never updated when PostSubmitError shipped. Same archetype, same
    // sibling-miss vector. The gate now covers it.
    regex: /\.\s*name\s*===\s*['"](?:ReceiptUncertainError|PostSubmitError)['"]/g,
    description: '.name === "<PreserveClaim subclass>"',
  },
  {
    regex: /\.\s*constructor\s*\.\s*name\s*===\s*['"](?:ReceiptUncertainError|PostSubmitError)['"]/g,
    description: '.constructor.name === "<PreserveClaim subclass>"',
  },
  {
    // R9-P3-009 / Phase-7 Cluster C: identity comparison sibling-miss
    // variant. `err.constructor === ReceiptUncertainError` is the same
    // archetype as `instanceof X` modulo prototype chain semantics —
    // misses sibling subclass instances. Same fix: route through the
    // parent `instanceof PreserveClaimError`.
    regex: /\.\s*constructor\s*===\s*(?:ReceiptUncertainError|PostSubmitError)\b/g,
    description: '.constructor === <PreserveClaim subclass>',
  },
  {
    // R9-FG-5 / Phase-7 Cluster C: message-substring discrimination
    // archetype. The R8-FG-25 closure retired this pattern in
    // refund.ts and MultiUserAgent.ts but `auth/verify.ts:107` still
    // had it, and the gate didn't see message-substring at all. The
    // archetype has the same regression mechanism as name-string
    // discrimination — a future copy-edit on the writer-side string
    // silently flips the catch's branch. Replace with typed sentinel
    // + `instanceof`. This pattern flags ANY `.message.includes('...')`
    // in source — too broad? Yes by design: every site is a
    // sibling-miss seed and the canonical fix is a typed Error
    // subclass. If you genuinely need substring matching (e.g. for
    // Hedera SDK error coercion), grandfather the file with rationale.
    regex: /\.\s*message\s*\.\s*includes\s*\(\s*['"]/g,
    description: '.message.includes("<literal>") discriminator',
  },
];

export type Violation = LintViolation;

/**
 * Scan the codebase for forbidden `instanceof` and name-string
 * patterns. Returns one Violation per match.
 */
export function findViolations(): Violation[] {
  return scanProductionRoots(ALLOWED_PATHS, FORBIDDEN_PATTERNS);
}
