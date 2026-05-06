/**
 * Service-layer tests for the C2 idempotency-key gate on
 * `withdrawOperatorFees`. The full operator-fee flow couples a real
 * Hedera client + MultiUserAgent + AccountingService; we only test
 * the input-validation gate here. The deeper "open uncertain DL
 * blocks new submit" check lives inside MultiUserAgent and is tested
 * by uncertainTxVerification + force-release route tests via the
 * shape-match contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('userOps.withdrawOperatorFees: idempotency-key gate (C2)', () => {
  it('rejects missing idempotencyKey with invalid_input', async () => {
    const { withdrawOperatorFees } = await import('./userOps.js');
    const fakeDeps = {
      multiUser: {
        operatorWithdrawFees: async () => 'tx-id',
        getOperatorBalance: () => ({ balances: {} }),
      },
      store: {} as never,
    };
    const result = await withdrawOperatorFees(fakeDeps as never, {
      amount: 10,
      to: '0.0.5678',
      token: 'HBAR',
      idempotencyKey: null,
    });
    assert.equal(result.kind, 'invalid_input');
    if (result.kind !== 'invalid_input') return;
    assert.match(result.reason, /idempotencyKey is required/i);
    assert.match(result.reason, /C2/);
  });

  it('rejects empty-string idempotencyKey', async () => {
    const { withdrawOperatorFees } = await import('./userOps.js');
    const fakeDeps = {
      multiUser: {
        operatorWithdrawFees: async () => 'tx-id',
        getOperatorBalance: () => ({ balances: {} }),
      },
      store: {} as never,
    };
    const result = await withdrawOperatorFees(fakeDeps as never, {
      amount: 10,
      to: '0.0.5678',
      token: 'HBAR',
      idempotencyKey: '   ',
    });
    assert.equal(result.kind, 'invalid_input');
  });

  it('rejects missing idempotencyKey BEFORE invoking the underlying agent', async () => {
    let called = false;
    const { withdrawOperatorFees } = await import('./userOps.js');
    const fakeDeps = {
      multiUser: {
        operatorWithdrawFees: async () => {
          called = true;
          return 'tx-id';
        },
        getOperatorBalance: () => ({ balances: {} }),
      },
      store: {} as never,
    };
    await withdrawOperatorFees(fakeDeps as never, {
      amount: 10,
      to: '0.0.5678',
      token: 'HBAR',
    });
    assert.equal(
      called,
      false,
      'agent must NOT be invoked when idempotencyKey is missing — pre-fix, two key-less retries each fired an on-chain transfer',
    );
  });
});
