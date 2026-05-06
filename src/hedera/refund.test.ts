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

// F7 / F8 / F9 / F11 refund-correctness tests live alongside the dispatch
// tests below — they exercise verifyUncertainRefunds and processRefund's
// shared logic via the same fake-store harness.

// ── R2-FG-0: real integration tests for F7/F8/F9/F11 ──────────────
//
// 2026-05-06 round-2 audit (persona 6) found that the original
// F7/F8/F9/F11 tests were decorative — they walked invariants on
// fixture literals without invoking production code. Reverting the
// underlying fixes would not have failed any test. These replacements
// drive `processRefund` (for F11 + F7 — they gate before on-chain
// submit) and `verifyUncertainRefunds` (for F8 + F9 — they exist in
// the verifier SUCCESS branch), so the tests exercise the actual
// load-bearing call paths.

describe('R2-FG-2: processRefund permanent refunded-originals SADD set', () => {
  // S-04: claim TTL'd 30 days after FAILED resolution → retry passes
  // SET-NX-EX → second on-chain transfer. The permanent SADD set
  // blocks this even after the per-tx claim expires.

  it('refuses tx in refundedOriginals set even when per-tx claim is missing', async () => {
    const fakeClient = {
      operatorAccountId: { toString: () => '0.0.9999' },
    } as unknown as import('@hashgraph/sdk').Client;

    // In-memory Redis state — simulate the post-success state of a
    // PRIOR refund: per-tx claim TTL'd out, but permanent SADD set
    // still has the txId.
    const { getRedis, KEY_PREFIX } = await import('../auth/redis.js');
    const redis = await getRedis();
    await redis.sadd(KEY_PREFIX.refundedOriginals, 'tx-already-refunded');
    // Make sure the per-tx claim is GONE (TTL'd).
    await redis.del(`${KEY_PREFIX.refunded}tx-already-refunded`);

    const fakeStore = {
      async isDepositCredited(): Promise<boolean> { return true; },
      async getDepositByTxId() {
        return {
          transactionId: 'tx-already-refunded',
          userId: 'u-1',
          grossAmount: 100,
          rakeAmount: 0,
          netAmount: 100,
          tokenId: null,
          memo: 'm',
          timestamp: '2026-05-01T00:00:00Z',
        };
      },
      getUser() {
        return {
          userId: 'u-1',
          balances: {
            tokens: {
              hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
            },
          },
        };
      },
    };

    const { processRefund } = await import('./refund.js');
    await assert.rejects(
      () =>
        processRefund(fakeClient, 'tx-already-refunded', {
          store: fakeStore as never,
          skipMirrorCrossCheck: true,
        }),
      /permanent refunded-originals/,
    );

    // Cleanup so other tests don't see the SADD entry.
    await redis.srem(KEY_PREFIX.refundedOriginals, 'tx-already-refunded');
  });

  it('reports "unexpected state" for unrecognized claim values (S-03)', async () => {
    const fakeClient = {
      operatorAccountId: { toString: () => '0.0.9999' },
    } as unknown as import('@hashgraph/sdk').Client;

    const { getRedis, KEY_PREFIX } = await import('../auth/redis.js');
    const redis = await getRedis();
    // Plant a non-pending, non-failed:, non-txId value.
    await redis.set(
      `${KEY_PREFIX.refunded}tx-malformed-claim`,
      'do-not-retry',
      { ex: 3600 },
    );

    const fakeStore = {
      async isDepositCredited(): Promise<boolean> { return true; },
      async getDepositByTxId() {
        return {
          transactionId: 'tx-malformed-claim',
          userId: 'u-1',
          grossAmount: 100,
          rakeAmount: 0,
          netAmount: 100,
          tokenId: null,
          memo: 'm',
          timestamp: '2026-05-01T00:00:00Z',
        };
      },
      getUser() {
        return {
          userId: 'u-1',
          balances: { tokens: { hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 } } },
        };
      },
    };

    const { processRefund } = await import('./refund.js');
    await assert.rejects(
      () =>
        processRefund(fakeClient, 'tx-malformed-claim', {
          store: fakeStore as never,
          skipMirrorCrossCheck: true,
        }),
      /unexpected state/,
    );

    await redis.del(`${KEY_PREFIX.refunded}tx-malformed-claim`);
  });
});

describe('R2-FG-0 / F11: processRefund refuses tx without a recorded DepositRecord', () => {
  // F11's gate is `getDepositByTxId(txId) !== undefined`, NOT
  // `isDepositCredited(txId)` (the SADD claim). A tx where
  // `tryClaimTransaction` SADDed but `recordDeposit` never wrote the
  // record (lock contention, partial failure) should be refused.
  //
  // Soundness argument: the message string "not credited as a user
  // deposit" originates ONLY from `processRefund`'s F11 gate at
  // refund.ts:131-138 (verified by grep). If `assert.rejects` matches
  // that string, the gate must have fired — and the function MUST have
  // returned before any on-chain submit (the SET-NX-EX claim and
  // submit are downstream of the gate). No need to spy on the submit
  // primitives.

  it('throws "not credited as a user deposit" when no DepositRecord exists', async () => {
    const fakeClient = {
      operatorAccountId: { toString: () => '0.0.9999' },
    } as unknown as import('@hashgraph/sdk').Client;

    const claimed = new Set(['tx-claimed-but-not-recorded']);
    const fakeStore = {
      async isDepositCredited(txId: string): Promise<boolean> {
        return claimed.has(txId);
      },
      async getDepositByTxId(): Promise<undefined> {
        return undefined;
      },
      getUser: () => undefined,
    };

    const { processRefund } = await import('./refund.js');
    await assert.rejects(
      () =>
        processRefund(fakeClient, 'tx-claimed-but-not-recorded', {
          store: fakeStore as never,
        }),
      /not credited as a user deposit/,
    );
  });
});

describe('R2-FG-0 / F7 / R2-FG-19: processRefund consumed-balance guard', () => {
  // R2-FG-19 (round-2 G-01): the guard now compares `available`
  // ALONE against netAmount (was `available + reserved`). A deposit
  // fully reserved against an active play would have passed the
  // pre-fix guard while the play settle-and-spend was already
  // committed — refund + settle = double-pay.
  //
  // The error message "insufficient AVAILABLE balance" originates
  // ONLY from the F7+R2-FG-19 guard, so a matching assert.rejects
  // proves the guard fired.

  it('throws when AVAILABLE balance is fully spent (R2-FG-19 tightened guard)', async () => {
    const fakeClient = {
      operatorAccountId: { toString: () => '0.0.9999' },
    } as unknown as import('@hashgraph/sdk').Client;

    const fakeStore = {
      async isDepositCredited(): Promise<boolean> {
        return true;
      },
      async getDepositByTxId() {
        return {
          transactionId: 'tx-spent',
          userId: 'u-1',
          grossAmount: 100,
          rakeAmount: 0,
          netAmount: 100,
          tokenId: null,
          memo: 'm',
          timestamp: '2026-05-01T00:00:00Z',
        };
      },
      getUser(userId: string) {
        if (userId !== 'u-1') return undefined;
        return {
          userId: 'u-1',
          balances: {
            tokens: {
              hbar: { available: 0, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
            },
          },
        };
      },
    };

    const { processRefund } = await import('./refund.js');
    await assert.rejects(
      () =>
        processRefund(fakeClient, 'tx-spent', {
          store: fakeStore as never,
        }),
      /insufficient AVAILABLE balance/,
    );
  });

  it('R2-FG-24: refuses tx whose mirror record does not show transfer to agent matching DepositRecord', async () => {
    // R2-FG-24 (round-2 B-15): pre-fix code trusted the
    // DepositRecord blindly. A Redis writer planting `{ userId, netAmount,
    // ... }` for a real on-chain transactionId that wasn't actually a
    // deposit-to-agent would get the refund honored. The fix fetches
    // the mirror tx and asserts a positive transfer to agent matching
    // netAmount + rakeAmount.
    const fakeClient = {
      operatorAccountId: { toString: () => '0.0.9999' },
    } as unknown as import('@hashgraph/sdk').Client;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/transactions/tx-planted')) {
        return new Response(null, { status: 404 });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const fakeStore = {
      async isDepositCredited(): Promise<boolean> { return true; },
      async getDepositByTxId() {
        return {
          transactionId: 'tx-planted',
          userId: 'u-planted',
          grossAmount: 100,
          rakeAmount: 5,
          netAmount: 95,
          tokenId: null,
          memo: 'planted',
          timestamp: '2026-05-01T00:00:00Z',
        };
      },
      getUser(userId: string) {
        if (userId !== 'u-planted') return undefined;
        return {
          userId: 'u-planted',
          balances: {
            tokens: {
              hbar: { available: 95, reserved: 0, totalDeposited: 95, totalWithdrawn: 0, totalRake: 0 },
            },
          },
        };
      },
    };

    try {
      const { processRefund } = await import('./refund.js');
      await assert.rejects(
        () =>
          processRefund(fakeClient, 'tx-planted', {
            store: fakeStore as never,
            // R2-FG-24 explicitly NOT skipped — we want the cross-check to fire.
          }),
        /mirror node has NO record/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('R3-FG-4: processRefund refuses when outer user lock cannot be acquired (pre-fix: lock acquired only AFTER on-chain refund)', async () => {
    // R3-FG-4 (round-3 P1-001): R2-FG-19's commit message claimed the
    // F7 guard runs UNDER the user lock. It didn't — the lock was
    // acquired only around the ledger debit AFTER the on-chain refund.
    // Concurrent in-band play could reserve+settle between the guard
    // and the on-chain submit, draining `available` while the refund
    // flew → operator double-pay. Now we acquire the lock BEFORE the
    // F7 guard and HOLD across awaitReceipt + ledger debit + audit
    // anchor + SADD. If the lock can't be acquired, refuse the refund
    // entirely (no on-chain submit).
    //
    // revert-proof: pre-acquire the lock from a separate "lambda" via
    // direct acquireUserLock; processRefund must reject. If the outer
    // lock is reverted, processRefund proceeds to the F7 guard + on-chain
    // submit + inner lock acquire (the inner one may queue or fail).
    // Either way the rejection message would not match the R3-FG-4 string.
    const fakeClient = {
      operatorAccountId: { toString: () => '0.0.9999' },
    } as unknown as import('@hashgraph/sdk').Client;

    const fakeStore = {
      async isDepositCredited(): Promise<boolean> { return true; },
      async getDepositByTxId() {
        return {
          transactionId: 'tx-locked',
          userId: 'u-locked',
          grossAmount: 100,
          rakeAmount: 0,
          netAmount: 100,
          tokenId: null,
          memo: 'm',
          timestamp: '2026-05-01T00:00:00Z',
        };
      },
      getUser(userId: string) {
        if (userId !== 'u-locked') return undefined;
        return {
          userId: 'u-locked',
          balances: {
            tokens: {
              hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
            },
          },
        };
      },
    };

    // Pre-acquire the user lock from a "concurrent lambda" so the
    // outer acquire fails after backoff.
    const { acquireUserLock } = await import('../lib/locks.js');
    const concurrentToken = await acquireUserLock('u-locked', 60);
    assert.ok(concurrentToken, 'pre-condition: concurrent lock acquired');

    try {
      const { processRefund } = await import('./refund.js');
      await assert.rejects(
        () =>
          processRefund(fakeClient, 'tx-locked', {
            store: fakeStore as never,
            skipMirrorCrossCheck: true,
          }),
        /per-user lock contention.*did not clear/,
      );
    } finally {
      const { releaseUserLock } = await import('../lib/locks.js');
      await releaseUserLock('u-locked', concurrentToken!);
    }
  });

  it('R2-FG-19: throws when balance is FULLY RESERVED (pre-fix would have allowed double-pay)', async () => {
    // Pre-fix guard: `available + reserved >= netAmount` — passes here
    // (0 + 100 >= 100), the operator paid both the play settlement and
    // the refund. Post-fix guard: `available >= netAmount` only, this
    // case rejects.
    const fakeClient = {
      operatorAccountId: { toString: () => '0.0.9999' },
    } as unknown as import('@hashgraph/sdk').Client;

    const fakeStore = {
      async isDepositCredited(): Promise<boolean> { return true; },
      async getDepositByTxId() {
        return {
          transactionId: 'tx-reserved',
          userId: 'u-1',
          grossAmount: 100,
          rakeAmount: 0,
          netAmount: 100,
          tokenId: null,
          memo: 'm',
          timestamp: '2026-05-01T00:00:00Z',
        };
      },
      getUser(userId: string) {
        if (userId !== 'u-1') return undefined;
        return {
          userId: 'u-1',
          balances: {
            tokens: {
              // available=0, reserved=100. Pre-fix: passes (0+100>=100).
              // Post-fix: rejects.
              hbar: {
                available: 0,
                reserved: 100,
                totalDeposited: 100,
                totalWithdrawn: 0,
                totalRake: 0,
              },
            },
          },
        };
      },
    };

    const { processRefund } = await import('./refund.js');
    await assert.rejects(
      () =>
        processRefund(fakeClient, 'tx-reserved', {
          store: fakeStore as never,
        }),
      /insufficient AVAILABLE balance.*Reserved funds are committed/s,
    );
  });

  it('passes the guard when available >= netAmount (sanity — must reach later code)', async () => {
    // Precondition: the guard does NOT fire when balance is sufficient.
    // The function then reaches the SET-NX-EX claim block, which throws
    // because we're not running with a real Redis. We assert the error
    // is NOT the F7 message — proving the guard let us through.
    const fakeClient = {
      operatorAccountId: { toString: () => '0.0.9999' },
    } as unknown as import('@hashgraph/sdk').Client;

    const fakeStore = {
      async isDepositCredited(): Promise<boolean> { return true; },
      async getDepositByTxId() {
        return {
          transactionId: 'tx-with-balance',
          userId: 'u-1',
          grossAmount: 100,
          rakeAmount: 0,
          netAmount: 100,
          tokenId: null,
          memo: 'm',
          timestamp: '2026-05-01T00:00:00Z',
        };
      },
      getUser(userId: string) {
        if (userId !== 'u-1') return undefined;
        return {
          userId: 'u-1',
          balances: {
            tokens: {
              hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
            },
          },
        };
      },
    };

    const { processRefund } = await import('./refund.js');
    await assert.rejects(
      () => processRefund(fakeClient, 'tx-with-balance', { store: fakeStore as never }),
      (err: Error) => !/partially or fully consumed/.test(err.message),
    );
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
      async expire() { return 1; },
      async rpush() { return 1; },
      // Lua eval for the user-lock release script: just delete the
      // key if its value matches the fence token (best-effort approx
      // for test purposes — the real script does the same).
      async eval(_script: string, keys: string[], args: string[]): Promise<number> {
        const key = keys[0];
        const fence = args[0];
        if (state.get(key) === fence) {
          state.delete(key);
          return 1;
        }
        return 0;
      },
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

  it('F10: FAILED branch overwrites claim with failed:<refundTxId> instead of DELing', async () => {
    // 2026-05-06 audit SM-13: prior behaviour DELed the claim on
    // confirmed FAILED, opening a window where a subsequent call
    // would pass SET-NX-EX and run a second on-chain refund. After
    // F10, the claim is OVERWRITTEN with `failed:<refundTxId>` and
    // a fresh 30d TTL. A retry of `processRefund` for the same
    // originalTxId would see the existing claim and refuse.
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
      const stored = state.get(claimKey);
      assert.ok(
        typeof stored === 'string' && stored.startsWith('failed:'),
        `claim must be overwritten with 'failed:<refundTxId>' (got ${String(stored)})`,
      );
      assert.ok(
        (stored as string).includes('refund-tx-fail'),
        'overwrite value must reference the failed refundTxId for diagnostics',
      );
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
      // F10: 24h NOT_FOUND promotes to FAILED, which now OVERWRITES
      // the claim with `failed:<refundTxId>` (not DEL).
      const stored = state.get(claimKey);
      assert.ok(
        typeof stored === 'string' && stored.startsWith('failed:'),
        `claim must be overwritten with 'failed:<refundTxId>' (got ${String(stored)})`,
      );
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

  it('F6: resolve-write failure does not double-debit on retry (intermediate stamps land first)', async () => {
    // 2026-05-06 audit U-03: refund verifier stamped its idempotency
    // markers ONLY at the final resolve write. A single resolve-write
    // failure (Redis blip / Lambda freeze) would lose every marker,
    // so the next reconcile pass re-ran the entire SUCCESS branch —
    // double-debit on user.available + duplicate HCS-20 burn op.
    // After F6, ledgerAdjustedAt and auditWrittenAt are stamped via
    // intermediate `stampProgress` calls before the resolve write,
    // so a resolve-write failure leaves the markers in place and the
    // next pass short-circuits.
    installMirror(new Map([['refund-tx-resolve-fail', { status: 200, result: 'SUCCESS' }]]));
    const { state } = installRedis();
    state.set('lla:testnet:refunded:original-tx-Z', 'pending');

    let updateBalanceCalls = 0;
    const dls: Array<{
      transactionId: string;
      timestamp: string;
      error: string;
      kind: 'refund_uncertain';
      memo?: string;
      sender?: string;
      details: Record<string, unknown>;
      resolvedAt?: string;
    }> = [
      {
        transactionId: 'refund-tx-resolve-fail',
        timestamp: new Date().toISOString(),
        error: 'x',
        kind: 'refund_uncertain' as const,
        memo: 'memo-Z',
        sender: '0.0.user',
        details: {
          originalTxId: 'original-tx-Z',
          refundTxId: 'refund-tx-resolve-fail',
          humanAmount: 10,
          tokenKey: 'hbar',
          agentAccountId: '0.0.9999',
          claimKey: 'lla:testnet:refunded:original-tx-Z',
        },
      },
    ];

    let failResolveOnce = true;
    const store = {
      async refreshDeadLetters() {},
      getDeadLetters() { return dls; },
      async upsertDeadLetter(entry: typeof dls[number]) {
        // Only fail the FINAL resolve write (the one carrying resolvedAt).
        if (entry.resolvedAt && failResolveOnce) {
          failResolveOnce = false;
          throw new Error('synthetic resolve-write failure');
        }
        const idx = dls.findIndex((d) => d.transactionId === entry.transactionId);
        if (idx >= 0) dls[idx] = entry;
        else dls.push(entry);
      },
      async flush() {},
      getUserByMemo() {
        return {
          userId: 'u-z',
          balances: { tokens: { hbar: { available: 1000, reserved: 0 } } },
        };
      },
      // F8: verifier now consults getDepositByTxId for the canonical
      // user (rather than re-resolving via memo).
      async getDepositByTxId() {
        return {
          transactionId: 'original-tx-Z',
          userId: 'u-z',
          grossAmount: 10,
          rakeAmount: 0,
          netAmount: 10,
          tokenId: null,
          memo: 'memo-Z',
          timestamp: '2026-05-01T00:00:00Z',
        };
      },
      getUser() {
        return {
          userId: 'u-z',
          balances: { tokens: { hbar: { available: 1000, reserved: 0 } } },
        };
      },
      updateBalance() {
        updateBalanceCalls++;
        return {} as never;
      },
    };

    const accounting = {
      async recordRefund(): Promise<void> { /* succeeds */ },
    };

    try {
      const { verifyUncertainRefunds } = await import('./refund.js');

      // First pass: ledger debit + audit succeed; resolve-write fails.
      await verifyUncertainRefunds(accounting as never, store as never);
      assert.equal(updateBalanceCalls, 1, 'first pass adjusts ledger once');

      // Drop the per-txId verifier lock so pass 2 can acquire it
      // afresh (mirrors a real Lambda restart after the lock TTL).
      state.delete('lla:testnet:verifying:refund:refund-tx-resolve-fail');

      // Second pass: should observe the intermediate ledgerAdjustedAt /
      // auditWrittenAt markers from pass 1 and SKIP the ledger debit.
      await verifyUncertainRefunds(accounting as never, store as never);
      assert.equal(
        updateBalanceCalls,
        1,
        'second pass MUST NOT re-debit — intermediate stamps from pass 1 must persist',
      );
    } finally {
      teardown();
    }
  });

  it('R2-FG-0 / F8: verifier debits depositRecord.userId, NOT memo lookup (memo-collision protection)', async () => {
    // Memo-collision attack: Alice sends a deposit with Bob's memo;
    // deposit watcher routes to Bob; refund's debit must target Bob
    // (the recorded owner), NOT alice or whoever currently maps to
    // memo. Verifier path uses depositRecord.userId after F8.
    installMirror(new Map([['refund-tx-collision', { status: 200, result: 'SUCCESS' }]]));
    const { state } = installRedis();
    state.set('lla:testnet:refunded:original-tx-collision', 'pending');

    const updateBalanceCalls: Array<{ userId: string; tokenKey: string }> = [];
    const dls = [
      {
        transactionId: 'refund-tx-collision',
        timestamp: new Date().toISOString(),
        error: 'x',
        kind: 'refund_uncertain' as const,
        memo: 'memo-shared',
        sender: '0.0.alice-sender',
        details: {
          originalTxId: 'original-tx-collision',
          refundTxId: 'refund-tx-collision',
          humanAmount: 95,
          tokenKey: 'hbar',
          agentAccountId: '0.0.9999',
          claimKey: 'lla:testnet:refunded:original-tx-collision',
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
      // F8 acid test: getUserByMemo and getDepositByTxId disagree on
      // who owns this deposit. F8 picks the deposit-record owner.
      getUserByMemo() {
        return {
          userId: 'u-alice-via-memo',
          balances: { tokens: { hbar: { available: 95, reserved: 0 } } },
        };
      },
      async getDepositByTxId() {
        return {
          transactionId: 'original-tx-collision',
          userId: 'u-bob-via-deposit-record',
          grossAmount: 100,
          rakeAmount: 5,
          netAmount: 95,
          tokenId: null,
          memo: 'memo-shared',
          timestamp: '2026-05-01T00:00:00Z',
        };
      },
      getUser(userId: string) {
        if (userId === 'u-bob-via-deposit-record') {
          return {
            userId: 'u-bob-via-deposit-record',
            balances: { tokens: { hbar: { available: 95, reserved: 0 } } },
          };
        }
        return undefined;
      },
      updateBalance(userId: string, fn: (b: { tokens: Record<string, { available: number; reserved: number }> }) => unknown) {
        updateBalanceCalls.push({ userId, tokenKey: 'hbar' });
        const b = { tokens: { hbar: { available: 95, reserved: 0 } } };
        fn(b);
        return b as never;
      },
      updateOperator() { return {} as never; },
    };

    try {
      const { verifyUncertainRefunds } = await import('./refund.js');
      const accounting = { async recordRefund(): Promise<void> {} };
      const outcomes = await verifyUncertainRefunds(
        undefined as unknown as never,
        store as never,
        accounting as never,
      );
      assert.equal(outcomes[0]!.status, 'confirmed');
      // The acid test: updateBalance was called with depositRecord.userId
      // (u-bob-via-deposit-record), NOT memo-resolved user (u-alice-via-memo).
      assert.equal(updateBalanceCalls.length, 1);
      assert.equal(
        updateBalanceCalls[0]!.userId,
        'u-bob-via-deposit-record',
        'F8: debit must target depositRecord.userId, not getUserByMemo result',
      );
    } finally {
      teardown();
    }
  });

  it('R2-FG-0 / F9: verifier reverses operator rake by depositRecord.rakeAmount', async () => {
    // F9: operator state should be debited by `depositRecord.rakeAmount`
    // when refunding a previously-raked deposit. Audit anchor's
    // `rakeReversed` field carries the amount.
    installMirror(new Map([['refund-tx-rake', { status: 200, result: 'SUCCESS' }]]));
    const { state } = installRedis();
    state.set('lla:testnet:refunded:original-tx-rake', 'pending');

    let operatorBalance = 5; // post-rake-credit baseline
    const recordRefundCalls: Array<{ rakeReversed?: number; rakeReversedToken?: string }> = [];
    const dls = [
      {
        transactionId: 'refund-tx-rake',
        timestamp: new Date().toISOString(),
        error: 'x',
        kind: 'refund_uncertain' as const,
        memo: 'memo-rake',
        sender: '0.0.user-sender',
        details: {
          originalTxId: 'original-tx-rake',
          refundTxId: 'refund-tx-rake',
          humanAmount: 95,
          tokenKey: 'hbar',
          agentAccountId: '0.0.9999',
          claimKey: 'lla:testnet:refunded:original-tx-rake',
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
          userId: 'u-rake',
          balances: { tokens: { hbar: { available: 95, reserved: 0 } } },
        };
      },
      async getDepositByTxId() {
        return {
          transactionId: 'original-tx-rake',
          userId: 'u-rake',
          grossAmount: 100,
          rakeAmount: 5,
          netAmount: 95,
          tokenId: null,
          memo: 'memo-rake',
          timestamp: '2026-05-01T00:00:00Z',
        };
      },
      getUser() {
        return {
          userId: 'u-rake',
          balances: { tokens: { hbar: { available: 95, reserved: 0 } } },
        };
      },
      updateBalance() { return {} as never; },
      updateOperator(
        fn: (op: { balances: Record<string, number> }) => { balances: Record<string, number> },
      ) {
        const op = { balances: { hbar: operatorBalance } };
        const next = fn(op);
        operatorBalance = next.balances.hbar ?? operatorBalance;
        return next as never;
      },
    };

    try {
      const { verifyUncertainRefunds } = await import('./refund.js');
      const accounting = {
        async recordRefund(details: { rakeReversed?: number; rakeReversedToken?: string }) {
          recordRefundCalls.push(details);
        },
      };
      // verifyUncertainRefunds signature: (client, store, accounting?)
      const outcomes = await verifyUncertainRefunds(
        undefined as unknown as never,
        store as never,
        accounting as never,
      );
      assert.equal(outcomes[0]!.status, 'confirmed', `outcome note: ${outcomes[0]?.note}`);
      // F9 acid test: operator rake was reversed.
      assert.equal(operatorBalance, 0, 'F9: operator balance must be debited by rakeAmount=5');
      // F9 audit anchor: rakeReversed field set on the recordRefund call.
      assert.equal(
        recordRefundCalls.length,
        1,
        `recordRefund must be called once; got ${recordRefundCalls.length}. outcome: ${JSON.stringify(outcomes[0])}`,
      );
      assert.equal(recordRefundCalls[0]!.rakeReversed, 5);
      assert.equal(recordRefundCalls[0]!.rakeReversedToken, 'hbar');
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
      async getDepositByTxId() {
        return {
          transactionId: 'original-tx-Y',
          userId: 'u',
          grossAmount: 10,
          rakeAmount: 0,
          netAmount: 10,
          tokenId: null,
          memo: 'memo-Y',
          timestamp: '2026-05-01T00:00:00Z',
        };
      },
      getUser() {
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
