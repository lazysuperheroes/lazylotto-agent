/**
 * R10-FG-2 + R11-FG-3 behavioral test — store-cache contract.
 *
 * Phase-9 Cluster C closes both findings together via the shared
 * `composeBalanceResponse` helper in `app/api/_lib/composeBalances.ts`.
 * The helper is the canonical implementation; all four
 * balance-bearing routes (`/api/user/status`, `/api/user/check-deposits`,
 * `/api/user/play`, `/api/user/withdraw`) call it. This test now
 * IMPORTS the helper directly instead of holding a verbatim copy —
 * the test/route divergence concern (P1-002, P3-003) that R11
 * raised against the Phase-8 form of this test is gone because
 * there is no copy to drift.
 *
 * The bug-shape invariant under test:
 *   - `user.balances` (the store-cached object passed in) is NEVER
 *     mutated. Two successive calls observe identical underlying
 *     state.
 *   - The returned `responseBalances` reflects pending subtraction
 *     when entries exist; when no entries exist it's reference-
 *     identical to `user.balances` (no allocations on the happy
 *     path).
 *
 * Reverting `composeBalanceResponse` to mutate `user.balances` (or
 * any other route to bypass the helper and reassign on a live
 * reference) flips this test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { queuePendingLedgerAdjustment } from '../custodial/pendingLedger.js';
import { KEY_PREFIX } from '../auth/redis.js';
import type { UserAccount } from '../custodial/types.js';
import { composeBalanceResponse } from '../../app/api/_lib/composeBalances.js';

interface MockState {
  sets: Map<string, Set<string>>;
  kv: Map<string, string>;
  lists: Map<string, string[]>;
}

function makeMockRedis(state: MockState) {
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      return (state.kv.get(key) ?? null) as T | null;
    },
    async set(key: string, value: string, options?: { nx?: boolean; ex?: number }) {
      if (options?.nx && state.kv.has(key)) return null;
      state.kv.set(key, value);
      return 'OK';
    },
    async del(...keys: string[]) {
      let removed = 0;
      for (const k of keys) {
        if (state.kv.delete(k)) removed++;
        if (state.sets.delete(k)) removed++;
        if (state.lists.delete(k)) removed++;
      }
      return removed;
    },
    async sadd(key: string, ...members: string[]) {
      let s = state.sets.get(key);
      if (!s) state.sets.set(key, (s = new Set()));
      let added = 0;
      for (const m of members) if (!s.has(m)) { s.add(m); added++; }
      return added;
    },
    async sismember(key: string, member: string) {
      return state.sets.get(key)?.has(member) ? 1 : 0;
    },
    async smembers(key: string) { return Array.from(state.sets.get(key) ?? []); },
    async srem(_key: string) { return 0; },
    async incr(key: string) {
      const cur = Number(state.kv.get(key) ?? 0); const next = cur + 1;
      state.kv.set(key, String(next)); return next;
    },
    async incrby(key: string, delta: number) {
      const cur = Number(state.kv.get(key) ?? 0); const next = cur + delta;
      state.kv.set(key, String(next)); return next;
    },
    async ttl(_k: string) { return -1; },
    async expire(_k: string, _s: number) { return 1; },
    async persist(_k: string) { return 1; },
    async getdel<T = unknown>(_k: string): Promise<T | null> { return null; },
    async rpush(key: string, value: string) {
      let l = state.lists.get(key);
      if (!l) state.lists.set(key, (l = []));
      l.push(value);
      return l.length;
    },
    async lrange(key: string, start: number, stop: number) {
      const l = state.lists.get(key) ?? [];
      const end = stop === -1 ? l.length : stop + 1;
      return l.slice(start, end);
    },
    async llen(key: string) { return (state.lists.get(key) ?? []).length; },
    async lrem(_k: string, _c: number, _v: string) { return 0; },
    async eval<T = unknown>(_s: string, _k: string[], _a: string[]): Promise<T> {
      throw new Error('eval not supported by mock');
    },
    async scan(cursor: string | number, _o: { match: string; count: number }) {
      return [cursor, []] as [string | number, string[]];
    },
  };
}

function makeUser(userId: string, hbarAvailable: number, hbarTotal: number): UserAccount {
  return {
    userId,
    depositMemo: 'mock-memo',
    hederaAccountId: '0.0.99999',
    eoaAddress: '0x0000000000000000000000000000000000000000',
    strategyName: 'balanced',
    strategyVersion: '1.0.0',
    strategySnapshot: {} as never,
    rakePercent: 0,
    balances: {
      tokens: {
        hbar: {
          available: hbarAvailable,
          reserved: 0,
          totalDeposited: hbarTotal,
          totalWithdrawn: 0,
          totalRake: 0,
        },
      },
    },
    connectionTopicId: null,
    registeredAt: '2026-04-01T00:00:00.000Z',
    lastPlayedAt: null,
    active: true,
  };
}

describe('R10-FG-2 + R11-FG-3: composeBalanceResponse must not mutate the store-cached user', () => {
  // revert-proof: R10-FG-2 + R11-FG-3 — exercising the shared
  // helper directly. Reverting `composeBalanceResponse` to assign
  // `user.balances = adjustedBalances` (or any of the 4 balance-
  // bearing routes to bypass the helper and mutate user) flips
  // this test. The helper IS the production code, so the test no
  // longer relies on a verbatim copy contract.
  it('two consecutive invocations observe identical store-cached balances', async () => {
    const g = globalThis as unknown as { __lazylottoRedisClient__?: unknown };
    const saved = g.__lazylottoRedisClient__;

    const state: MockState = { sets: new Map(), kv: new Map(), lists: new Map() };
    g.__lazylottoRedisClient__ = makeMockRedis(state);

    try {
      const userId = 'user-r10-fg-2';
      const user = makeUser(userId, 100, 100);

      // Snapshot the store-cached balances BEFORE any route logic runs.
      const originalAvailable = user.balances.tokens.hbar!.available;
      assert.equal(originalAvailable, 100);

      // Inject a pending-ledger entry (a refund queued for this user
      // while they were mid-play / mid-withdraw). The route subtracts
      // this from the response's `available` field.
      await queuePendingLedgerAdjustment({
        userId,
        tokenKey: 'hbar',
        amount: 10,
        reason: 'refund',
        sourceTx: '0.0.123@1234567890.000000010',
        createdAt: '2026-04-07T23:58:00.000Z',
      });

      // Sanity: queue populated.
      assert.equal(
        (state.lists.get(KEY_PREFIX.pendingLedger) ?? []).length,
        1,
      );

      // First /status call.
      const firstResult = await composeBalanceResponse(user);
      assert.equal(firstResult.pendingAdjustments.length, 1);
      assert.equal(firstResult.pendingAdjustments[0]!.amount, 10);
      // The dashboard view subtracts pending from available — that's
      // the legitimate UX. The response shows 90; the store stays at 100.
      assert.equal(
        firstResult.responseBalances.tokens.hbar!.available,
        90,
        'response balances reflect the subtracted pending sum',
      );

      // Second /status call on the SAME warm Lambda. The store is
      // unchanged on the backend; only `user.balances` was potentially
      // mutated by the first call. The pending list is unchanged
      // (drain hasn't run between requests).
      //
      // Invariant: the second call must observe the SAME underlying
      // available balance (100) before applying pending adjustments
      // (so it subtracts 10 from 100, not from 90).
      assert.equal(
        user.balances.tokens.hbar!.available,
        originalAvailable,
        `R10-FG-2: store-cached user.balances was mutated by the first ` +
          `/api/user/status invocation. Expected available=${originalAvailable} ` +
          `(unchanged); got ${user.balances.tokens.hbar!.available}. ` +
          `Reassigning user.balances on a live store reference means a ` +
          `subsequent /api/user/withdraw on the same warm Lambda would ` +
          `re-subtract pending → DOUBLE-DEDUCT. Fix: build a separate ` +
          `response object, do not reassign user.balances.`,
      );

      // Belt-and-braces: re-run and confirm idempotence under repeated calls.
      const secondResult = await composeBalanceResponse(user);
      assert.equal(
        user.balances.tokens.hbar!.available,
        originalAvailable,
        'second invocation also leaves store-cached balance unchanged',
      );
      assert.equal(
        secondResult.responseBalances.tokens.hbar!.available,
        90,
        'second response also subtracts the same pending sum from the unchanged store',
      );
      assert.deepStrictEqual(
        secondResult.pendingAdjustments,
        firstResult.pendingAdjustments,
        'consecutive calls return identical pendingAdjustments arrays',
      );
    } finally {
      g.__lazylottoRedisClient__ = saved;
    }
  });
});
