import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeSubmit,
  PreserveClaimError,
  PostSubmitError,
  ReceiptUncertainError,
} from './transfers.js';

// ── Test fixtures ─────────────────────────────────────────────
//
// safeSubmit's contract is the load-bearing piece for R5-FG-3:
//   1. Pre-submit errors propagate as-is (claim safe to release).
//   2. ANY post-submit error lifts to PreserveClaimError (claim must
//      survive — on-chain status unknown).
//
// We exercise the contract with synthetic clients/responses so we
// don't need a live Hedera connection.

interface FakeResponse {
  transactionId: { toString(): string };
  getReceipt(client: unknown): Promise<unknown>;
}

function makeResponse(
  txId: string,
  receiptBehavior: 'ok' | 'throw-vanilla' | 'throw-receipt-uncertain' | 'never-resolve',
  vanillaError?: Error,
): FakeResponse {
  return {
    transactionId: { toString: () => txId },
    getReceipt: async () => {
      if (receiptBehavior === 'ok') {
        return { status: { toString: () => 'SUCCESS' } };
      }
      if (receiptBehavior === 'throw-vanilla') {
        throw vanillaError ?? new Error('signer disposed mid-fetch');
      }
      if (receiptBehavior === 'throw-receipt-uncertain') {
        throw new ReceiptUncertainError(txId);
      }
      // never-resolve: return a promise that hangs; awaitReceipt's
      // ceiling fires the timeout instead.
      return new Promise(() => {
        /* never */
      });
    },
  };
}

describe('safeSubmit (R5-FG-3)', () => {
  // revert-proof: if the safeSubmit catch is removed (or narrowed
  // back to ReceiptUncertainError only), this test fails — a vanilla
  // post-submit Error would bubble up unwrapped and `isPreserveClaim`
  // would NOT trigger in withIdempotency, DELing the claim while the
  // on-chain submit may have landed → double-spend window.
  it('lifts a post-submit vanilla Error to PostSubmitError (PreserveClaim subclass)', async () => {
    const fakeClient = {} as unknown as Parameters<typeof safeSubmit>[0];
    const txId = '0.0.X@1234567890.123456789';
    let thrown: unknown;
    try {
      await safeSubmit(
        fakeClient,
        async () => makeResponse(txId, 'throw-vanilla') as never,
        { ceilingMs: 200 },
      );
      assert.fail('safeSubmit should have thrown');
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      thrown instanceof PostSubmitError,
      `expected PostSubmitError, got ${(thrown as Error).constructor.name}`,
    );
    assert.ok(
      thrown instanceof PreserveClaimError,
      'PostSubmitError must extend PreserveClaimError so withIdempotency keeps the claim',
    );
    const psErr = thrown as PostSubmitError;
    assert.equal(psErr.transactionId, txId, 'PostSubmitError carries the txId for mirror cross-check');
    assert.equal(
      (psErr.originalError as Error).message,
      'signer disposed mid-fetch',
      'original cause preserved',
    );
  });

  // revert-proof: if safeSubmit re-wraps a ReceiptUncertainError, the
  // outer instanceof check fails — the receipt-uncertain semantics
  // are lost (callers branch on instanceof ReceiptUncertainError to
  // dead-letter the tx as `*_uncertain`).
  it('passes through ReceiptUncertainError unchanged', async () => {
    const fakeClient = {} as unknown as Parameters<typeof safeSubmit>[0];
    const txId = '0.0.X@1234567890.987654321';
    let thrown: unknown;
    try {
      await safeSubmit(
        fakeClient,
        async () => makeResponse(txId, 'throw-receipt-uncertain') as never,
        { ceilingMs: 200 },
      );
      assert.fail('safeSubmit should have thrown');
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      thrown instanceof ReceiptUncertainError,
      'ReceiptUncertainError must NOT be re-wrapped as PostSubmitError',
    );
  });

  // revert-proof: if safeSubmit moves the build() call inside the
  // try/catch (or the catch is widened to wrap pre-submit errors),
  // this test fails — pre-submit failures (validation, signing)
  // would be lifted to PreserveClaim and permanently retain claims
  // for every legitimate input-rejection.
  it('pre-submit error from build() propagates as-is (not PreserveClaim)', async () => {
    const fakeClient = {} as unknown as Parameters<typeof safeSubmit>[0];
    const preSubmitErr = new Error('signature build failed');
    let thrown: unknown;
    try {
      await safeSubmit(
        fakeClient,
        async () => {
          throw preSubmitErr;
        },
        { ceilingMs: 200 },
      );
      assert.fail('safeSubmit should have thrown');
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      !(thrown instanceof PreserveClaimError),
      'pre-submit errors MUST NOT be lifted — claim release is safe',
    );
    assert.equal(thrown, preSubmitErr, 'pre-submit error propagates verbatim');
  });
});
