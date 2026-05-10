/**
 * R10-FG-1 behavioral test — pendingLedger SADD-after-flush race.
 *
 * Authored 2026-05-09 BEFORE any fix lands, as part of the dissection
 * exercise verifying the hypothesis that "tests catch prior-round
 * archetypes, not current-round introduction archetypes". This test
 * exists to FAIL against current code.
 *
 * R10-FG-1 says: at pendingLedger.ts:287-312 (eager path) the order
 * is `flush() → SADD → LREM`. A Lambda kill between `await
 * store.flush()` and `await redis.sadd(...)` leaves the user balance
 * debited but no applied-set record. Next drain: SISMEMBER → 0 →
 * re-mutates → DOUBLE-DEBIT. The author's own comment at lines
 * 296-308 recommends SADD before flush, but the code does the
 * opposite. R9-FG-6 was NOT actually closed — the window narrowed
 * from 7 days to ~1 round-trip but the archetype is intact.
 *
 * The behavioral invariant: `applyPendingLedgerForUser` must be
 * idempotent against partial-failure replay. Specifically, if a
 * prior drain attempt persisted the balance mutation but failed to
 * record the applied-set membership AND failed to LREM the row
 * (the post-flush, pre-SADD-and-LREM kill state), the next drain
 * MUST NOT re-apply the mutation.
 *
 * Hypothesis-verification protocol: this test MUST FAIL right now.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyPendingLedgerForUser, queuePendingLedgerAdjustment } from '../custodial/pendingLedger.js';
import { KEY_PREFIX } from '../auth/redis.js';
import type {
  UserAccount,
  UserBalances,
  OperatorState,
  DepositRecord,
} from '../custodial/types.js';
import type { IStore } from '../custodial/IStore.js';

// ── Mock RedisLike with in-memory state ─────────────────────────

interface MockState {
  sets: Map<string, Set<string>>;
  kv: Map<string, string>;
  lists: Map<string, string[]>;
  /** When true, sadd rejects (simulating Lambda kill mid-await). */
  saddBroken: boolean;
  /** When true, lrem rejects (simulating Lambda kill mid-await). */
  lremBroken: boolean;
  /** Records the flush + SADD call order for ordering assertions. */
  callLog: string[];
}

function makeMockRedis(state: MockState) {
  const api = {
    async get<T = unknown>(key: string): Promise<T | null> {
      return (state.kv.get(key) ?? null) as T | null;
    },
    async set(key: string, value: string, options?: { ex?: number; nx?: boolean }) {
      if (options?.nx && state.kv.has(key)) return null;
      state.kv.set(key, value);
      return 'OK';
    },
    async del(...keys: string[]): Promise<number> {
      let removed = 0;
      for (const k of keys) {
        if (state.kv.delete(k)) removed++;
        if (state.sets.delete(k)) removed++;
        if (state.lists.delete(k)) removed++;
      }
      return removed;
    },
    async sadd(key: string, ...members: string[]): Promise<number> {
      state.callLog.push(`sadd:${key}:${members.join(',')}`);
      if (state.saddBroken) {
        // Simulates Lambda termination mid-await — the pendingLedger
        // body wraps SADD in `.catch(() => 0)` so the throw is
        // silently swallowed, leaving the applied-set un-recorded.
        throw new Error('SADD interrupted (simulated Lambda kill)');
      }
      let set = state.sets.get(key);
      if (!set) state.sets.set(key, (set = new Set()));
      let added = 0;
      for (const m of members) if (!set.has(m)) { set.add(m); added++; }
      return added;
    },
    async sismember(key: string, member: string): Promise<number> {
      return state.sets.get(key)?.has(member) ? 1 : 0;
    },
    async smembers(key: string): Promise<string[]> {
      return Array.from(state.sets.get(key) ?? []);
    },
    async srem(key: string, ...members: string[]): Promise<number> {
      const set = state.sets.get(key);
      if (!set) return 0;
      let removed = 0;
      for (const m of members) if (set.delete(m)) removed++;
      return removed;
    },
    async incr(key: string): Promise<number> {
      const cur = Number(state.kv.get(key) ?? 0);
      const next = cur + 1;
      state.kv.set(key, String(next));
      return next;
    },
    async incrby(key: string, delta: number): Promise<number> {
      const cur = Number(state.kv.get(key) ?? 0);
      const next = cur + delta;
      state.kv.set(key, String(next));
      return next;
    },
    async ttl(_key: string): Promise<number> { return -1; },
    async expire(_key: string, _sec: number): Promise<number> { return 1; },
    async persist(_key: string): Promise<number> { return 1; },
    async getdel<T = unknown>(key: string): Promise<T | null> {
      const v = state.kv.get(key) ?? null;
      state.kv.delete(key);
      return v as T | null;
    },
    async rpush(key: string, value: string): Promise<number> {
      let list = state.lists.get(key);
      if (!list) state.lists.set(key, (list = []));
      list.push(value);
      return list.length;
    },
    async lrange(key: string, start: number, stop: number): Promise<unknown[]> {
      const list = state.lists.get(key) ?? [];
      const end = stop === -1 ? list.length : stop + 1;
      return list.slice(start, end);
    },
    async llen(key: string): Promise<number> {
      return (state.lists.get(key) ?? []).length;
    },
    async lrem(key: string, count: number, value: string): Promise<number> {
      state.callLog.push(`lrem:${key}`);
      if (state.lremBroken) {
        throw new Error('LREM interrupted (simulated Lambda kill)');
      }
      const list = state.lists.get(key);
      if (!list) return 0;
      let removed = 0;
      const limit = count === 0 ? Infinity : Math.abs(count);
      for (let i = list.length - 1; i >= 0 && removed < limit; i--) {
        if (list[i] === value) { list.splice(i, 1); removed++; }
      }
      return removed;
    },
    async eval<T = unknown>(_script: string, keys: string[], _args: string[]): Promise<T> {
      // Simulate eval-not-supported; fencedClaim falls back to plain DEL.
      throw new Error('eval not supported by mock');
    },
    async scan(
      cursor: string | number,
      _options: { match: string; count: number },
    ): Promise<[string | number, string[]]> {
      return [cursor, []];
    },
  };
  return api;
}

// ── Mock IStore (only methods exercised by the eager drain path) ─

/**
 * Mock store that simulates the in-memory-cache vs persisted-state
 * split that production stores have. `live` is the per-Lambda cache
 * (mutated by `updateBalance`); `persisted` is what survives a
 * Lambda restart. `flush()` commits live → persisted; `refreshUser()`
 * pulls persisted → live (mirrors `withUserLock`'s lock-acquire
 * sequence at locks.ts:172).
 *
 * Without this split, a test that exercises a kill mid-protocol
 * conflates the two and falsely reports double-debit on a second
 * drain. Production safety hinges on the contract that callers
 * (`withUserLock`) refresh from persisted before each drain.
 */
function makeMockStore(user: UserAccount, sharedRedis: { lists: Map<string, string[]>; callLog: string[] }): IStore {
  // Deep-clone helpers so live and persisted don't share references.
  const cloneBal = (b: UserBalances): UserBalances => ({
    tokens: Object.fromEntries(
      Object.entries(b.tokens).map(([k, v]) => [k, { ...v }]),
    ),
  });
  let live = user;
  let persisted = cloneBal(user.balances);
  const operator: OperatorState = {
    balances: {},
    totalRakeCollected: {},
    totalGasSpent: 0,
    totalWithdrawnByOperator: {},
  };
  const store: Partial<IStore> = {
    getUser(userId: string): UserAccount | undefined {
      return userId === live.userId ? live : undefined;
    },
    updateBalance(userId: string, updater: (b: UserBalances) => UserBalances): UserBalances {
      if (userId !== live.userId) return { tokens: {} };
      const next = updater(live.balances);
      live = { ...live, balances: next };
      return next;
    },
    updateOperator(updater: (s: OperatorState) => OperatorState): OperatorState {
      const next = updater(operator);
      Object.assign(operator, next);
      return next;
    },
    getOperator(): OperatorState { return operator; },
    async flush(): Promise<void> {
      sharedRedis.callLog.push('flush');
      // Successful flush commits the in-memory mutation to persisted.
      persisted = cloneBal(live.balances);
    },
    async refreshUser(_userId: string): Promise<void> {
      // Restores in-memory cache from persisted state — production
      // pulls this from Redis at withUserLock acquire time.
      live = { ...live, balances: cloneBal(persisted) };
    },
    async getDepositByTxId(_txId: string): Promise<DepositRecord | undefined> { return undefined; },
  };
  return store as IStore;
}

function makeUser(userId: string, hbarAvailable: number): UserAccount {
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
          totalDeposited: hbarAvailable,
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

// ── Test ────────────────────────────────────────────────────────

describe('R10-FG-1: pendingLedger eager drain must be idempotent across mid-protocol kill', () => {
  // revert-proof: R10-FG-1 + R9-FG-6 — call-order assertion. Reverting
  // `pendingLedger.ts` to record SADD AFTER flush flips this test. Same
  // ordering invariant Phase-7 Cluster E claimed for R9-FG-6 (Phase-9
  // re-promoted that entry to link here).
  it('SADD records applied-set membership BEFORE flush', async () => {
    // Strong post-fix invariant: a single happy-path drain records
    // the applied-set entry before the persisted flush. Reverting to
    // flush-then-SADD reopens the kill window R10-FG-1 names.
    const g = globalThis as unknown as { __lazylottoRedisClient__?: unknown };
    const saved = g.__lazylottoRedisClient__;
    const state: MockState = {
      sets: new Map(), kv: new Map(), lists: new Map(),
      saddBroken: false, lremBroken: false, callLog: [],
    };
    g.__lazylottoRedisClient__ = makeMockRedis(state);
    try {
      const userId = 'user-r10-fg-1-order';
      const user = makeUser(userId, 100);
      const store = makeMockStore(user, state);
      await queuePendingLedgerAdjustment({
        userId,
        tokenKey: 'hbar',
        amount: 10,
        reason: 'refund',
        sourceTx: '0.0.123@1234567890.000000010',
        createdAt: '2026-04-07T23:58:00.000Z',
      });
      await applyPendingLedgerForUser(store, userId);

      const saddIdx = state.callLog.findIndex(
        (s) => s.startsWith(`sadd:${KEY_PREFIX.pendingLedgerAppliedSet}`),
      );
      const flushIdx = state.callLog.indexOf('flush');
      assert.ok(saddIdx >= 0, `expected SADD on applied-set in callLog; got ${JSON.stringify(state.callLog)}`);
      assert.ok(flushIdx >= 0, `expected flush in callLog; got ${JSON.stringify(state.callLog)}`);
      assert.ok(
        saddIdx < flushIdx,
        `R10-FG-1: SADD must be recorded BEFORE flush. Got sadd@${saddIdx}, ` +
          `flush@${flushIdx}. Reverting to flush-then-SADD reopens the kill ` +
          `window between flush success and SADD entry.`,
      );
      assert.equal(
        store.getUser(userId)!.balances.tokens.hbar!.available, 90,
        'happy-path drain debited exactly once',
      );
    } finally {
      g.__lazylottoRedisClient__ = saved;
    }
  });

  // revert-proof: R10-FG-1 + R9-FG-6 — end-to-end idempotence under
  // mid-protocol kill. Reverting the SADD-before-flush ordering or
  // re-introducing `.catch(() => 0)` on SADD/flush flips this test.
  // Same body-idempotency invariant R9-FG-6 documented; Phase-9
  // re-promoted R9-FG-6 to link here.
  it('partial-failure replay (SADD aborted) does not double-debit on next drain', async () => {
    // Save and replace the global Redis client so getRedis() returns
    // our mock for both pendingLedger and fencedClaim.
    const g = globalThis as unknown as { __lazylottoRedisClient__?: unknown };
    const saved = g.__lazylottoRedisClient__;

    const state: MockState = {
      sets: new Map(),
      kv: new Map(),
      lists: new Map(),
      saddBroken: false,
      lremBroken: false,
      callLog: [],
    };
    const mockRedis = makeMockRedis(state);
    g.__lazylottoRedisClient__ = mockRedis;

    try {
      const userId = 'user-r10-fg-1';
      const user = makeUser(userId, 100);
      const store = makeMockStore(user, state);

      // Queue a single pending refund debit via the public API.
      await queuePendingLedgerAdjustment({
        userId,
        tokenKey: 'hbar',
        amount: 10,
        reason: 'refund',
        sourceTx: '0.0.123@1234567890.000000001',
        createdAt: '2026-04-07T23:58:00.000Z',
      });

      // Sanity: row queued.
      assert.equal(
        (state.lists.get(KEY_PREFIX.pendingLedger) ?? []).length,
        1,
        'pre-condition: exactly one row in the pending-ledger list',
      );

      // ── Drain 1: simulate a Lambda kill at SADD time.
      //
      // Under the post-fix order (SADD-before-flush, no catch on
      // either): SADD throws first; the body propagates; fencedClaim
      // releases the fence; flush never runs; mutation lives only
      // in the (Lambda-local) live cache.
      //
      // Net post-state: live=90 (uncommitted), persisted=100 (flush
      // never ran), applied-set=empty, LIST row=still queued, claim
      // released.
      state.saddBroken = true;
      state.lremBroken = true;
      await applyPendingLedgerForUser(store, userId);

      // Verify the partial-failure state we set up.
      assert.equal(
        (state.sets.get(KEY_PREFIX.pendingLedgerAppliedSet) ?? new Set()).size,
        0,
        'drain 1: applied-set empty (SADD aborted)',
      );
      assert.equal(
        (state.lists.get(KEY_PREFIX.pendingLedger) ?? []).length,
        1,
        'drain 1: row still in queue (no LREM ran)',
      );

      // ── Lambda restart.
      //
      // Production sequence at locks.ts:172 — withUserLock runs
      // store.refreshUser BEFORE the eager drain on every lock
      // acquire. This pulls persisted state into the live cache,
      // dropping any uncommitted in-memory mutation from the
      // previous Lambda's interrupted body.
      state.saddBroken = false;
      state.lremBroken = false;
      await store.refreshUser(userId);
      assert.equal(
        store.getUser(userId)!.balances.tokens.hbar!.available,
        100,
        'after restart-equivalent refreshUser: live cache reads ' +
          'persisted (uncommitted mutation dropped)',
      );

      // ── Drain 2: SADD/LREM restored. The invariant: balance must
      // be 90 after this — debit applied exactly once across both
      // attempts. Pre-fix this returned 80 (DOUBLE-DEBIT).
      await applyPendingLedgerForUser(store, userId);

      const userAfterDrain2 = store.getUser(userId);
      assert.equal(
        userAfterDrain2!.balances.tokens.hbar!.available,
        90,
        `R10-FG-1: post-kill replay either re-debited or lost the ` +
          `debit. Expected 90 (debit applied exactly once); got ` +
          `${userAfterDrain2!.balances.tokens.hbar!.available}. ` +
          `Pre-Phase-8 the order was flush → SADD with all three ` +
          `wrapped in .catch — a kill between flush and SADD left ` +
          `the balance debited and the applied-set empty, so the next ` +
          `drain re-applied. The fix moves SADD before flush and ` +
          `lets both throw to fencedClaim's catch (claim released, ` +
          `mutation rolled back via refreshUser).`,
      );
    } finally {
      g.__lazylottoRedisClient__ = saved;
    }
  });

  // revert-proof: R11-FG-4 — withUserLock-faithful simulation. The
  // production sequence (locks.ts:158-200) is:
  //   1. acquireUserLock
  //   2. refreshUser (live ← persisted)
  //   3. applyPendingLedgerForUser (the drain — may mutate live)
  //   4. fn() (the user's withdraw/play; reads live)
  //   5. store.flush() (live → persisted)
  //   6. releaseUserLock
  //
  // Phase-9 Cluster D moved updateBalance AFTER SADD inside the drain
  // body. So a SADD throw in step 3 leaves live UNCHANGED. Step 5
  // therefore commits a clean live, persisted stays at the original
  // value, and the next drain (on a different Lambda) replays
  // cleanly: one debit applied, total.
  //
  // Reverting the SADD<->updateBalance order (back to Phase-8: mutate
  // first, then SADD) flips this test: step 3 leaves live=90, step 5
  // commits persisted=90 with no applied-set anchor, and the next
  // drain re-debits → DOUBLE-DEBIT through the sibling channel
  // R11-FG-4 named.
  //
  // revert-proof: R11-FG-4 — close-to-test annotation so the
  // audit-coverage gate's 10-line lookback finds it.
  it('R11-FG-4: SADD-throw under withUserLock simulator does not double-debit', async () => {
    const g = globalThis as unknown as { __lazylottoRedisClient__?: unknown };
    const saved = g.__lazylottoRedisClient__;
    const state: MockState = {
      sets: new Map(), kv: new Map(), lists: new Map(),
      saddBroken: false, lremBroken: false, callLog: [],
    };
    g.__lazylottoRedisClient__ = makeMockRedis(state);

    try {
      const userId = 'user-r11-fg-4';
      const user = makeUser(userId, 100);
      const store = makeMockStore(user, state);
      await queuePendingLedgerAdjustment({
        userId,
        tokenKey: 'hbar',
        amount: 10,
        reason: 'refund',
        sourceTx: '0.0.123@1234567890.000000004',
        createdAt: '2026-04-07T23:58:00.000Z',
      });

      // === Lambda A: withUserLock for an unrelated user op ===
      // Step 2: refreshUser
      await store.refreshUser(userId);

      // Step 3: drain runs. Simulate SADD failure.
      state.saddBroken = true;
      await applyPendingLedgerForUser(store, userId);
      state.saddBroken = false;

      // Step 4: fn() runs. We don't simulate user logic here —
      // the assertion under test is that fn() reads the original
      // (clean) live balance, NOT the dirty post-mutation 90.
      assert.equal(
        store.getUser(userId)!.balances.tokens.hbar!.available,
        100,
        `R11-FG-4: live cache must remain clean after SADD-throw. ` +
          `Reverting the Phase-9 SADD-before-mutation order would ` +
          `make this 90 (Phase-8 ordering: updateBalance ran before ` +
          `SADD, mutation persists into withUserLock's flush even ` +
          `though SADD threw).`,
      );

      // Step 5: withUserLock's post-body flush. Commits live to
      // persisted. Live is clean, so persisted stays at 100.
      await store.flush();

      // === Lambda B: withUserLock for a different request ===
      // Step 2: refreshUser pulls persisted into Lambda B's live.
      await store.refreshUser(userId);
      // Step 3: drain runs cleanly this time (saddBroken=false).
      await applyPendingLedgerForUser(store, userId);
      // Step 5: flush.
      await store.flush();

      const finalAvailable = store.getUser(userId)!.balances.tokens.hbar!.available;
      assert.equal(
        finalAvailable,
        90,
        `R11-FG-4: after SADD-throw + clean retry, balance must reflect ` +
          `EXACTLY ONE debit. Got ${finalAvailable}. Phase-8 ordering ` +
          `would produce 80 (double-debit) because the dirty live from ` +
          `Lambda A's interrupted drain bleeds into withUserLock's flush, ` +
          `committing the debit without anchor; Lambda B's drain then ` +
          `re-debits because SISMEMBER=0.`,
      );
    } finally {
      g.__lazylottoRedisClient__ = saved;
    }
  });
});
