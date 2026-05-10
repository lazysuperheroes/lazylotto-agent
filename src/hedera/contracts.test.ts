import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateGas, transferAllPrizesWithRetry } from './contracts.js';
import { PostSubmitError, ReceiptUncertainError, PreserveClaimError } from './transfers.js';

describe('estimateGas', () => {
  it('calculates buyEntry gas without multiplier', () => {
    // base 350k + 150k * 3 = 800k
    assert.equal(estimateGas('buyEntry', 3), 800_000);
  });

  it('calculates buyAndRollEntry gas with 1.5x multiplier', () => {
    // base 750k + 610k * 2 = 1_970k, * 1.5 = 2_955k
    assert.equal(estimateGas('buyAndRollEntry', 2), 2_955_000);
  });

  it('calculates rollAll gas with 1.5x multiplier', () => {
    // base 400k + 400k * 5 = 2_400k, * 1.5 = 3_600k
    assert.equal(estimateGas('rollAll', 5), 3_600_000);
  });

  it('calculates rollBatch gas with 1.5x multiplier', () => {
    // base 400k + 400k * 3 = 1_600k, * 1.5 = 2_400k
    assert.equal(estimateGas('rollBatch', 3), 2_400_000);
  });

  it('calculates claimAllPrizes gas without multiplier', () => {
    // base 500k + 0 * anything = 500k
    assert.equal(estimateGas('claimAllPrizes', 10), 500_000);
  });

  it('caps at maxGas (14.5M)', () => {
    // rollAll with 100 units: (400k + 400k*100) * 1.5 = 60.6M → capped to 14.5M
    assert.equal(estimateGas('rollAll', 100), 14_500_000);
  });

  it('handles zero units', () => {
    assert.equal(estimateGas('buyEntry', 0), 350_000);
  });
});

// R6-FG-5 suite: pins the structural contract that
// transferAllPrizesWithRetry's catch uses `instanceof PreserveClaimError`
// covering BOTH ReceiptUncertainError and PostSubmitError. Pre-fix
// used string-name comparison which missed PostSubmitError.
describe('R6-FG-5: transferAllPrizesWithRetry preserves claim on PostSubmitError', () => {
  // revert-proof: R6-FG-5 — if PostSubmitError stops extending
  // PreserveClaimError, the retry's `instanceof PreserveClaimError`
  // gate no longer covers PostSubmitError — silent retry of a
  // may-have-landed contract call → double-pay prize transfer.
  it('PostSubmitError is a PreserveClaimError (retry catch must include it)', () => {
    const psErr = new PostSubmitError('0.0.X@1234.567', new Error('signer disposed'));
    // If this fails, transfers.ts changed the inheritance — retry
    // catch's `instanceof PreserveClaimError` no longer covers
    // PostSubmitError, archetype regresses.
    assert.ok(psErr instanceof PostSubmitError);
    // ReceiptUncertainError sibling check.
    const ruErr = new ReceiptUncertainError('0.0.X@1234.568');
    assert.ok(ruErr instanceof ReceiptUncertainError);
    // Both must share the parent class so a SINGLE
    // `instanceof PreserveClaimError` gate covers both.
    assert.ok(psErr instanceof PreserveClaimError, 'PostSubmitError must extend PreserveClaimError');
    assert.ok(ruErr instanceof PreserveClaimError, 'ReceiptUncertainError must extend PreserveClaimError');
  });

  // revert-proof: R6-FG-5 / R8-FG-11 / R9-FG-14 — Phase-6 Cluster D
  // upgrade from the pre-Phase-6 `typeof === 'function'` tautology.
  // Phase-7 Cluster H (R9-FG-14) routes the source through
  // `stripComments` before regex matching so a doc-comment alone
  // can't satisfy the assertion. The retry catch must use
  // `instanceof PreserveClaimError`; structural revert (sibling
  // miss) is caught by the sibling-archetype gate; behavioral
  // revert (changing to `instanceof Error`) is covered here.
  it('R6-FG-5 behavioral: contracts.ts retry-loop catches `instanceof PreserveClaimError`', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const { stripComments } = await import('../__tests__/lint-helpers.js');
    const here = dirname(fileURLToPath(import.meta.url));
    // R9-FG-14 / Phase-7 Cluster H: strip comments before regex
    // matching. Pre-Phase-7 the raw `readFileSync` text included
    // comments mentioning `instanceof PreserveClaimError` (multiple
    // documenting the archetype), so a comment alone could falsely
    // satisfy the assertion. The lint-helpers' stripComments runs
    // file-wide preserving line numbers so only code is matched.
    const source = stripComments(readFileSync(join(here, 'contracts.ts'), 'utf8'));
    // The retry loop must check `err instanceof PreserveClaimError` —
    // catches both ReceiptUncertainError AND PostSubmitError. A
    // regression that flips this to `instanceof Error` (swallowing
    // PreserveClaim) or `instanceof ReceiptUncertainError` (sibling
    // miss) flips the assertion.
    assert.match(
      source,
      /instanceof\s+PreserveClaimError/,
      'contracts.ts retry loop must use `instanceof PreserveClaimError` (parent class) — not subclass-specific or generic Error',
    );
    // Type sanity: the function is still exported.
    assert.equal(typeof transferAllPrizesWithRetry, 'function');
  });
});

// R6-FG-4 suite: pins the structural contract that executeIntent
// and executeEncodedCall route their tx.execute() through safeSubmit
// so post-submit errors lift to PreserveClaimError instead of escaping
// as vanilla Error (which withIdempotency would DEL the claim on,
// reopening a contract-call double-spend window).
describe('R6-FG-4: contracts.ts post-submit safety net', () => {
  // revert-proof: R6-FG-4 — removing `safeSubmit` from executeIntent
  // or executeEncodedCall reverts the file's source to lack the
  // import + the call site. This source-level regex check catches
  // either form of revert.
  it('executeIntent + executeEncodedCall route through safeSubmit', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, 'contracts.ts'), 'utf8');
    // Both helpers MUST reference safeSubmit (we use a shared helper,
    // so the import alone is meaningful for revert detection).
    assert.match(
      source,
      /import\s*\{[^}]*\bsafeSubmit\b[^}]*\}\s*from\s*['"]\.\/transfers\.js['"]/,
      'contracts.ts must import safeSubmit from ./transfers.js',
    );
    // Both function bodies must call safeSubmit. Two distinct
    // `await safeSubmit(` matches required so a regression that
    // drops only one helper's wrapper is caught.
    //
    // R8-FG-20 / Phase-6 Cluster D: count `await safeSubmit(`
    // specifically — the pre-Phase-6 regex `\bsafeSubmit\s*\(` also
    // matched the comment text "route through safeSubmit (see ...)"
    // and inflated the count by one, masking a callsite removal.
    // The new regex requires the actual await-prefixed call shape.
    const callSites = source.match(/\bawait\s+safeSubmit\s*\(/g) ?? [];
    assert.ok(
      callSites.length >= 2,
      `contracts.ts must invoke \`await safeSubmit(\` at >=2 sites (executeIntent + executeEncodedCall); found ${callSites.length}`,
    );
  });
});

// R6-FG-7 suite: pins parseRefund's extraction of rakeReversed +
// rakeReversedToken. Pre-fix the reader silently dropped these
// fields, leaving operator-balance reconstruction permanently
// short by every refund-of-raked-deposit's reversal amount.
describe('R6-FG-7: parseRefund propagates rakeReversed', () => {
  // revert-proof: R6-FG-7 — removing the `rakeReversed` extraction
  // from parseRefund flips the resulting NormalizedRefundEvent's
  // `rakeReversed` field to undefined; verify-audit's accumulator
  // collapses to zero. This test asserts the field round-trips.
  it('rakeReversed is read from the wire payload', async () => {
    const { parseAuditTopic } = await import('../custodial/hcs20-reader.js');
    const result = await parseAuditTopic([
      {
        sequence: 1,
        timestamp: '2026-05-08T11:00:00.000Z',
        payload: {
          p: 'hcs-20',
          op: 'refund',
          tick: 'LLCRED',
          token: 'HBAR',
          amt: '100',
          from: '0.0.4567890',
          to: '0.0.7349994',
          originalDepositTxId: '0.0.X@1.0',
          refundTxId: '0.0.X@2.0',
          reason: 'operator_initiated',
          performedBy: '0.0.4567890',
          rakeReversed: '14',
          rakeReversedToken: 'HBAR',
          ts: '2026-05-08T11:00:00.000Z',
        },
      },
    ]);
    const refund = result.events.find((e) => e.type === 'refund');
    assert.ok(refund, 'expected refund event');
    assert.equal(
      (refund as { rakeReversed?: number }).rakeReversed,
      14,
      'rakeReversed must round-trip via parseRefund',
    );
    assert.equal(
      (refund as { rakeReversedToken?: string }).rakeReversedToken,
      'HBAR',
      'rakeReversedToken must round-trip via parseRefund',
    );
  });
});
