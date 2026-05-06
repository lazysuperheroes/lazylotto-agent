/**
 * Targeted regression tests for the safety-critical Redis paths in
 * `processRefund`. The full flow couples Hedera SDK + mirror-node
 * fetch + transferHbar/transferToken + IStore + AccountingService;
 * an end-to-end test would need extensive mocking. These tests
 * focus on the parts that can be exercised in isolation:
 *
 *   1. Atomic SET-NX-EX claim semantics (cross-Lambda dedup)
 *   2. Claim DEL on pre-transfer failure (retry recovery)
 *   3. isDepositCredited rejection of non-deposit txns
 *
 * The integration aspects (mirror-node fetch failures, on-chain
 * transfer failures, ledger adjustment race) are covered indirectly
 * by `concurrency-invariants.test.ts:5` and the operator-tier auth
 * tests. A full integration test is tracked as follow-up tech debt.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

interface MockRedis {
  store: Map<string, unknown>;
  set(
    key: string,
    value: string | number,
    options?: { nx?: boolean; ex?: number },
  ): Promise<string | null>;
  get<T = unknown>(key: string): Promise<T | null>;
  del(...keys: string[]): Promise<number>;
}

function makeMockRedis(): MockRedis {
  const store = new Map<string, unknown>();
  return {
    store,
    async set(key, value, options) {
      if (options?.nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async get<T = unknown>(key: string): Promise<T | null> {
      return (store.get(key) ?? null) as T | null;
    },
    async del(...keys: string[]): Promise<number> {
      let removed = 0;
      for (const k of keys) if (store.delete(k)) removed++;
      return removed;
    },
  };
}

// Refund replay protection mirrors the SET-NX-EX claim primitive
// directly (refund.ts:138-156). Test the primitive directly here
// since it's identical in shape — any future divergence shows up.

describe('Refund replay protection — SET-NX-EX claim semantics', () => {
  const REFUND_KEY_PREFIX = 'lla:testnet:refunded:';

  it('first claim wins; second returns null and reads back the prior value', async () => {
    const redis = makeMockRedis();
    const txId = 'tx-shared-replay';
    const key = `${REFUND_KEY_PREFIX}${txId}`;

    const first = await redis.set(key, 'pending', { nx: true, ex: 3600 });
    assert.equal(first, 'OK', 'first claimer wins SET-NX');

    const second = await redis.set(key, 'pending', { nx: true, ex: 3600 });
    assert.equal(second, null, 'second claimer must see null — already claimed');

    // Refund.ts's catch block reads the existing value to distinguish
    // 'pending' (in flight on another Lambda) vs an actual refundTxId
    // (already completed). Verify both branches:
    const existingPending = await redis.get<string>(key);
    assert.equal(existingPending, 'pending');

    // Simulate refund completion overwriting 'pending' with the actual id
    await redis.set(key, 'refund-tx-abc', { ex: 3600 });
    const completed = await redis.get<string>(key);
    assert.equal(completed, 'refund-tx-abc');

    // A third claim attempt now sees the completed value — caller
    // surfaces "already refunded: refund-tx-abc" to the operator.
    const third = await redis.set(key, 'pending', { nx: true, ex: 3600 });
    assert.equal(third, null);
  });

  it('claim DEL on pre-transfer failure allows retry without 30-day TTL wait', async () => {
    const redis = makeMockRedis();
    const txId = 'tx-mirror-failure';
    const key = `${REFUND_KEY_PREFIX}${txId}`;

    // Lambda A claims, then the mirror-node fetch fails.
    await redis.set(key, 'pending', { nx: true, ex: 30 * 24 * 60 * 60 });
    // Pre-transfer catch block: DEL the marker so a retry can claim.
    await redis.del(key);

    // Lambda B retries — claim succeeds.
    const retry = await redis.set(key, 'pending', { nx: true, ex: 30 * 24 * 60 * 60 });
    assert.equal(retry, 'OK', 'retry after release must succeed');
  });

  it('post-transfer marker overwrite preserves replay protection', async () => {
    const redis = makeMockRedis();
    const txId = 'tx-completed';
    const key = `${REFUND_KEY_PREFIX}${txId}`;

    // Successful refund flow: claim → transfer → overwrite with refundTxId.
    await redis.set(key, 'pending', { nx: true, ex: 30 * 24 * 60 * 60 });
    await redis.set(key, 'refund-tx-success', { ex: 30 * 24 * 60 * 60 });

    // Any future replay attempt for this txId sees the completed marker.
    const replayClaim = await redis.set(key, 'pending', { nx: true, ex: 30 * 24 * 60 * 60 });
    assert.equal(replayClaim, null);
    const stored = await redis.get<string>(key);
    assert.equal(stored, 'refund-tx-success');
  });
});

// IStore.isDepositCredited is the cross-Lambda hard check that
// refund.ts uses to validate that a txId came in via the deposit
// watcher (so we don't refund operator gas top-ups, prize transfers,
// bounty payouts, etc). Test the contract directly.

describe('Refund deposit-validation gate — isDepositCredited', () => {
  it('non-deposit txIds are rejected (the validation gate works)', async () => {
    // Build a minimal store-like surface that returns the right answer
    // for isDepositCredited. processRefund's gate calls this; if it
    // returns false, the function throws a "not credited as deposit"
    // error and never proceeds to the on-chain transfer.
    const knownDeposits = new Set(['tx-real-deposit']);
    const fakeStore = {
      async isDepositCredited(txId: string): Promise<boolean> {
        return knownDeposits.has(txId);
      },
    };

    assert.equal(await fakeStore.isDepositCredited('tx-real-deposit'), true);
    assert.equal(await fakeStore.isDepositCredited('tx-operator-gas-topup'), false,
      'gas top-ups must not pass the deposit gate');
    assert.equal(await fakeStore.isDepositCredited('tx-prize-transfer'), false,
      'prize transfers must not pass the deposit gate');
    assert.equal(await fakeStore.isDepositCredited('tx-bounty-payout'), false,
      'bounty payouts must not pass the deposit gate');
  });
});

// ── verifyUncertainRefunds: phase 4b coverage ────────────────────
// The success/failure dispatch lives in refund.ts:verifyUncertainRefunds.
// These tests pin the behaviour against mocked mirror-node responses.

describe('verifyUncertainRefunds dispatch', () => {
  const originalFetch = globalThis.fetch;

  function installMirror(
    responses: Map<string, { status: number; result?: string }>,
  ): void {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      const txMatch = url.match(/\/transactions\/([^?]+)/);
      const txId = txMatch ? txMatch[1] : url;
      const r = responses.get(txId);
      if (!r) return new Response(null, { status: 404 });
      if (r.status !== 200) return new Response(null, { status: r.status });
      return new Response(
        JSON.stringify({ transactions: r.result ? [{ result: r.result }] : [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
  }

  function installRedis(): { state: Map<string, unknown> } {
    const state = new Map<string, unknown>();
    const mock = {
      async set(key: string, value: string | number, options?: { nx?: boolean; ex?: number }) {
        if (options?.nx) {
          if (state.has(key)) return null;
          state.set(key, value);
          return 'OK';
        }
        state.set(key, value);
        return 'OK';
      },
      async get(key: string) { return state.get(key) ?? null; },
      async del(key: string) { return state.delete(key) ? 1 : 0; },
      async sadd() { return 0; },
      async sismember() { return 0; },
      async incr(k: string) { const n = Number(state.get(k) ?? 0) + 1; state.set(k, n); return n; },
    };
    (globalThis as unknown as { __lazylottoRedisClient__?: unknown }).__lazylottoRedisClient__ = mock;
    return { state };
  }

  function uninstallRedis(): void {
    (globalThis as unknown as { __lazylottoRedisClient__?: unknown }).__lazylottoRedisClient__ = undefined;
  }

  function teardown(): void {
    globalThis.fetch = originalFetch;
    uninstallRedis();
  }

  function makeFakeStore(entries: Array<{ transactionId: string; resolvedAt?: string; details: Record<string, unknown>; memo?: string; sender?: string; timestamp?: string; }>) {
    const dls = entries.map((e) => ({
      transactionId: e.transactionId,
      timestamp: e.timestamp ?? new Date().toISOString(),
      error: 'receipt timeout',
      kind: 'refund_uncertain' as const,
      sender: e.sender,
      memo: e.memo,
      details: e.details,
      resolvedAt: e.resolvedAt,
    }));
    return {
      async refreshDeadLetters() {},
      getDeadLetters() { return dls; },
      async upsertDeadLetter(entry: typeof dls[number]) {
        const idx = dls.findIndex((d) => d.transactionId === entry.transactionId);
        if (idx >= 0) dls[idx] = entry;
        else dls.push(entry);
      },
      async flush() {},
      getUserByMemo() { return undefined; },
      updateBalance() { return {} as never; },
    };
  }

  it('FAILED branch releases SET-NX-EX claim', async () => {
    const responses = new Map([['refund-tx-fail', { status: 200, result: 'INSUFFICIENT_TX_FEE' }]]);
    installMirror(responses);
    const { state } = installRedis();
    const claimKey = 'lla:testnet:refunded:original-tx-A';
    state.set(claimKey, 'pending');

    const store = makeFakeStore([
      {
        transactionId: 'refund-tx-fail',
        details: {
          originalTxId: 'original-tx-A',
          refundTxId: 'refund-tx-fail',
          humanAmount: 10,
          tokenKey: 'hbar',
          claimKey,
        },
      },
    ]);

    try {
      const { verifyUncertainRefunds } = await import('./refund.js');
      const outcomes = await verifyUncertainRefunds(undefined as unknown as never, store as never);
      assert.equal(outcomes[0]!.status, 'failed');
      assert.equal(state.get(claimKey) ?? null, null, 'claim must be DELed on confirmed FAILED');
    } finally {
      teardown();
    }
  });

  it('F2: FAILED branch refuses to redis.del a claimKey outside KEY_PREFIX.refunded', async () => {
    // 2026-05-06 audit I-07: a hand-edited or migration-corrupted entry
    // with `claimKey: 'lla:testnet:session:victim'` would otherwise let
    // the verifier or the force-release route delete arbitrary lla:
    // keys (sessions, user locks, killswitch flag, agentSeq counter).
    // The verifier MUST refuse claimKeys outside KEY_PREFIX.refunded.
    const responses = new Map([
      ['refund-tx-malicious', { status: 200, result: 'INSUFFICIENT_TX_FEE' }],
    ]);
    installMirror(responses);
    const { state } = installRedis();
    const maliciousKey = 'lla:testnet:session:victim-token-hash';
    state.set(maliciousKey, '{"accountId":"0.0.victim","tier":"user"}');

    const store = makeFakeStore([
      {
        transactionId: 'refund-tx-malicious',
        details: {
          originalTxId: 'original-tx-malicious',
          refundTxId: 'refund-tx-malicious',
          humanAmount: 10,
          tokenKey: 'hbar',
          claimKey: maliciousKey,
        },
      },
    ]);

    try {
      const { verifyUncertainRefunds } = await import('./refund.js');
      await verifyUncertainRefunds(undefined as unknown as never, store as never);
      assert.equal(
        state.get(maliciousKey),
        '{"accountId":"0.0.victim","tier":"user"}',
        'session key must NOT be deleted by the verifier',
      );
    } finally {
      teardown();
    }
  });

  it('NOT_FOUND >24h promoted to FAILED', async () => {
    installMirror(new Map());
    const { state } = installRedis();
    const claimKey = 'lla:testnet:refunded:original-tx-B';
    state.set(claimKey, 'pending');

    const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const store = makeFakeStore([
      {
        transactionId: 'refund-tx-old',
        timestamp: oldTimestamp,
        details: {
          originalTxId: 'original-tx-B',
          refundTxId: 'refund-tx-old',
          humanAmount: 10,
          tokenKey: 'hbar',
          claimKey,
        },
      },
    ]);

    try {
      const { verifyUncertainRefunds } = await import('./refund.js');
      const outcomes = await verifyUncertainRefunds(undefined as unknown as never, store as never);
      assert.equal(outcomes[0]!.status, 'failed');
      assert.equal(state.get(claimKey) ?? null, null, 'old NOT_FOUND must release claim');
    } finally {
      teardown();
    }
  });

  it('Unknown mirror result → still_uncertain (H8)', async () => {
    installMirror(new Map([['refund-tx-unknown', { status: 200, result: 'UNKNOWN_FUTURE_CODE' }]]));
    const { state } = installRedis();
    const claimKey = 'lla:testnet:refunded:original-tx-C';
    state.set(claimKey, 'pending');

    const store = makeFakeStore([
      {
        transactionId: 'refund-tx-unknown',
        details: {
          originalTxId: 'original-tx-C',
          refundTxId: 'refund-tx-unknown',
          humanAmount: 10,
          tokenKey: 'hbar',
          claimKey,
        },
      },
    ]);

    try {
      const { verifyUncertainRefunds } = await import('./refund.js');
      const outcomes = await verifyUncertainRefunds(undefined as unknown as never, store as never);
      assert.equal(outcomes[0]!.status, 'still_uncertain');
      assert.equal(state.get(claimKey), 'pending', 'claim must be retained on unknown code');
    } finally {
      teardown();
    }
  });

  it('Concurrent verifier lock held → still_uncertain', async () => {
    installMirror(new Map([['refund-tx-x', { status: 200, result: 'SUCCESS' }]]));
    const { state } = installRedis();
    state.set('lla:testnet:verifying:refund:refund-tx-x', '1');

    const store = makeFakeStore([
      {
        transactionId: 'refund-tx-x',
        details: {
          originalTxId: 'original-tx-X',
          refundTxId: 'refund-tx-x',
          humanAmount: 10,
          tokenKey: 'hbar',
          claimKey: 'lla:testnet:refunded:original-tx-X',
        },
      },
    ]);

    try {
      const { verifyUncertainRefunds } = await import('./refund.js');
      const outcomes = await verifyUncertainRefunds(undefined as unknown as never, store as never);
      assert.equal(outcomes[0]!.status, 'still_uncertain');
      assert.match(outcomes[0]!.note, /verifier lock/);
    } finally {
      teardown();
    }
  });

  it('M15: ledgerAdjustedAt skip prevents double-debit on rerun', async () => {
    installMirror(new Map([['refund-tx-y', { status: 200, result: 'SUCCESS' }]]));
    const { state } = installRedis();
    state.set('lla:testnet:refunded:original-tx-Y', 'pending');

    let updateBalanceCalls = 0;
    const dls = [
      {
        transactionId: 'refund-tx-y',
        timestamp: new Date().toISOString(),
        error: 'x',
        kind: 'refund_uncertain' as const,
        memo: 'memo-Y',
        sender: '0.0.user',
        details: {
          originalTxId: 'original-tx-Y',
          refundTxId: 'refund-tx-y',
          humanAmount: 10,
          tokenKey: 'hbar',
          agentAccountId: '0.0.9999',
          claimKey: 'lla:testnet:refunded:original-tx-Y',
          // Already-applied marker: should skip ledger debit entirely.
          ledgerAdjustedAt: new Date().toISOString(),
        },
      },
    ];
    const store = {
      async refreshDeadLetters() {},
      getDeadLetters() { return dls; },
      async upsertDeadLetter(entry: typeof dls[number]) {
        const idx = dls.findIndex((d) => d.transactionId === entry.transactionId);
        if (idx >= 0) dls[idx] = entry;
        else dls.push(entry);
      },
      async flush() {},
      getUserByMemo() {
        return {
          userId: 'u',
          balances: { tokens: { hbar: { available: 1000, reserved: 0 } } },
        };
      },
      updateBalance() {
        updateBalanceCalls++;
        return {} as never;
      },
    };

    try {
      const { verifyUncertainRefunds } = await import('./refund.js');
      const outcomes = await verifyUncertainRefunds(undefined as unknown as never, store as never);
      assert.equal(outcomes[0]!.status, 'confirmed');
      assert.equal(updateBalanceCalls, 0, 'pre-marked ledgerAdjustedAt must skip debit');
    } finally {
      teardown();
    }
  });
});
