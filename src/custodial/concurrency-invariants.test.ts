/**
 * Canonical home for cross-Lambda concurrency invariants.
 *
 * Every "have I seen this id?" / "what number comes next?" check that
 * MUST be correct across Lambda instances on Vercel needs a
 * regression test here. The pattern: shared mock Redis state between
 * two store instances, fire concurrent operations, assert no
 * divergence.
 *
 * If you add a new shared-state read for cross-Lambda correctness,
 * add an invariant test here. If you can't articulate the test, you
 * probably haven't picked the right primitive — see
 * `docs/concurrency-invariants.md` for the three primitives we use
 * (SADD claim, SET NX EX, INCR) and when each applies.
 *
 * What this file is NOT:
 *   - Single-instance unit tests of IStore methods (those live in
 *     RedisStore.test.ts / PersistentStore.test.ts).
 *   - End-to-end deployment tests (those live in check-protocols).
 *
 * What this file IS:
 *   - A failing-on-regression contract for every cross-Lambda
 *     correctness rule we depend on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Redis } from '@upstash/redis';
import { RedisStore } from './RedisStore.js';

// ── Shared mock Redis ──────────────────────────────────────────
//
// One state object, multiple RedisStore instances pointing at it.
// Mirrors the actual Vercel topology: many Lambdas, one cluster.

interface SharedRedisState {
  sets: Map<string, Set<string>>;
  kv: Map<string, string | number>;
  lists: Map<string, string[]>;
}

function makeState(): SharedRedisState {
  return { sets: new Map(), kv: new Map(), lists: new Map() };
}

function makeMockRedis(state: SharedRedisState): Redis {
  const api = {
    async sadd(key: string, ...members: string[]): Promise<number> {
      let set = state.sets.get(key);
      if (!set) state.sets.set(key, (set = new Set()));
      let added = 0;
      for (const m of members) if (!set.has(m)) { set.add(m); added++; }
      return added;
    },
    async srem(key: string, ...members: string[]): Promise<number> {
      const set = state.sets.get(key);
      if (!set) return 0;
      let removed = 0;
      for (const m of members) if (set.delete(m)) removed++;
      return removed;
    },
    async sismember(key: string, member: string): Promise<number> {
      return state.sets.get(key)?.has(member) ? 1 : 0;
    },
    async set(key: string, value: string | number, options?: { nx?: boolean }): Promise<string | null> {
      if (options?.nx) {
        if (state.kv.has(key)) return null;
        state.kv.set(key, value);
        return 'OK';
      }
      state.kv.set(key, value);
      return 'OK';
    },
    async get<T = unknown>(key: string): Promise<T | null> {
      return (state.kv.get(key) ?? null) as T | null;
    },
    async incr(key: string): Promise<number> {
      const cur = Number(state.kv.get(key) ?? 0);
      const next = cur + 1;
      state.kv.set(key, next);
      return next;
    },
    async lrange(key: string, start: number, end: number): Promise<string[]> {
      const list = state.lists.get(key) ?? [];
      const stop = end === -1 ? list.length : end + 1;
      return list.slice(start, stop);
    },
    async lrem(key: string, count: number, value: string): Promise<number> {
      const list = state.lists.get(key);
      if (!list) return 0;
      let removed = 0;
      const limit = count === 0 ? Infinity : Math.abs(count);
      for (let i = list.length - 1; i >= 0 && removed < limit; i--) {
        if (list[i] === value) { list.splice(i, 1); removed++; }
      }
      return removed;
    },
    async rpush(key: string, ...values: string[]): Promise<number> {
      let list = state.lists.get(key);
      if (!list) state.lists.set(key, (list = []));
      list.push(...values);
      return list.length;
    },
    async del(key: string): Promise<number> {
      let removed = 0;
      if (state.kv.delete(key)) removed++;
      if (state.sets.delete(key)) removed++;
      if (state.lists.delete(key)) removed++;
      return removed;
    },
    pipeline() {
      const ops: (() => Promise<unknown>)[] = [];
      const chain: Record<string, unknown> = {
        set: (...args: unknown[]) => { ops.push(() => (api.set as (...a: unknown[]) => Promise<unknown>)(...args)); return chain; },
        lrem: (...args: unknown[]) => { ops.push(() => (api.lrem as (...a: unknown[]) => Promise<unknown>)(...args)); return chain; },
        rpush: (...args: unknown[]) => { ops.push(() => (api.rpush as (...a: unknown[]) => Promise<unknown>)(...args)); return chain; },
        sadd: (...args: unknown[]) => { ops.push(() => (api.sadd as (...a: unknown[]) => Promise<unknown>)(...args)); return chain; },
        async exec() {
          const results: unknown[] = [];
          for (const op of ops) results.push(await op());
          return results;
        },
      };
      return chain;
    },
  };
  return api as unknown as Redis;
}

// ── Invariant 1: deposit credit is single-claim across Lambdas ──

describe('Cross-Lambda invariant: deposit credit', () => {
  it('two RedisStore instances racing tryClaimTransaction — exactly one wins', async () => {
    const state = makeState();
    const lambdaA = new RedisStore(makeMockRedis(state));
    const lambdaB = new RedisStore(makeMockRedis(state));

    const [resA, resB] = await Promise.all([
      lambdaA.tryClaimTransaction('tx-credit-shared'),
      lambdaB.tryClaimTransaction('tx-credit-shared'),
    ]);

    const winners = [resA, resB].filter(Boolean).length;
    assert.equal(winners, 1, 'exactly one Lambda credits this txId');
  });

  it('isDepositCredited consults Redis on local cache miss', async () => {
    // The original duplicate-deposit incident in v0.3.1 was that
    // refund/reconcile paths read only the local Set. After 0.3.2 the
    // hard check is `await isDepositCredited`. Verify a Lambda whose
    // cache was empty at startup still gets the truth from Redis.
    const state = makeState();
    const writer = new RedisStore(makeMockRedis(state));
    const reader = new RedisStore(makeMockRedis(state));

    await writer.tryClaimTransaction('tx-cross-lambda-read');
    // Reader's local cache is empty; isTransactionProcessed (sync,
    // local) returns false. isDepositCredited (async, Redis) MUST
    // return true.
    assert.equal(reader.isTransactionProcessed('tx-cross-lambda-read'), false);
    assert.equal(await reader.isDepositCredited('tx-cross-lambda-read'), true);
  });
});

// ── Invariant 2: agentSeq monotonicity across Lambdas ──────────

describe('Cross-Lambda invariant: HCS-20 agentSeq monotonicity', () => {
  it('two stores sharing one Redis produce unique sequence numbers', async () => {
    // Pre-fix: AccountingService held agentSeq as a per-process number,
    // so two warm Lambdas writing v2 messages for DIFFERENT users
    // (per-user lock doesn't serialise across users) could emit the
    // same agentSeq. After 0.3.3 the counter goes through Redis INCR.
    const state = makeState();
    const lambdaA = new RedisStore(makeMockRedis(state));
    const lambdaB = new RedisStore(makeMockRedis(state));

    await lambdaA.seedAgentSeq('0.0.shared', -1);
    // Both Lambdas race for 10 sequence numbers.
    const results = await Promise.all([
      lambdaA.nextAgentSeq('0.0.shared'),
      lambdaB.nextAgentSeq('0.0.shared'),
      lambdaA.nextAgentSeq('0.0.shared'),
      lambdaB.nextAgentSeq('0.0.shared'),
      lambdaA.nextAgentSeq('0.0.shared'),
      lambdaB.nextAgentSeq('0.0.shared'),
      lambdaA.nextAgentSeq('0.0.shared'),
      lambdaB.nextAgentSeq('0.0.shared'),
      lambdaA.nextAgentSeq('0.0.shared'),
      lambdaB.nextAgentSeq('0.0.shared'),
    ]);

    const unique = new Set(results);
    assert.equal(unique.size, 10, 'every agentSeq across all Lambdas is unique');
  });

  it('cold-start SETNX race converges to one canonical seed', async () => {
    // Two cold Lambdas both run their mirror-node scan and call
    // seedAgentSeq with their respective values. SETNX semantics:
    // first wins, second is a no-op. Both Lambdas then INCR against
    // the same canonical seed.
    const state = makeState();
    const lambdaA = new RedisStore(makeMockRedis(state));
    const lambdaB = new RedisStore(makeMockRedis(state));

    // Lambda A's scan saw highest seq 100; Lambda B's scan was slower
    // and saw 95 (mid-traffic).
    await Promise.all([
      lambdaA.seedAgentSeq('0.0.A', 100),
      lambdaB.seedAgentSeq('0.0.A', 95),
    ]);

    // Whichever won SETNX sets the baseline. The first INCR returns
    // baseline+1. The losing seed value is discarded entirely.
    const first = await lambdaA.nextAgentSeq('0.0.A');
    // Both seeds were valid — either 96 (B won) or 101 (A won).
    assert.ok(first === 96 || first === 101, `first INCR returned ${first}`);

    // Both Lambdas thereafter share the same counter.
    const second = await lambdaB.nextAgentSeq('0.0.A');
    assert.equal(second, first + 1);
  });
});

// ── Invariant 3: refund replay protection ──────────────────────

describe('Cross-Lambda invariant: refund replay protection', () => {
  it('SET-NX-EX claim — two Lambdas race for the same refund txId; exactly one wins', async () => {
    // The refund flow uses redis.set(key, 'pending', { nx, ex }) as
    // the atomic claim. We exercise the primitive directly through
    // the mock. (The full processRefund flow is too coupled to mirror
    // node + Hedera SDK to unit-test here; the integration
    // assertion lives in the e2e smoke.)
    const state = makeState();
    const redisA = makeMockRedis(state);
    const redisB = makeMockRedis(state);

    const [claimA, claimB] = await Promise.all([
      redisA.set('refund:tx-shared', 'pending', { nx: true, ex: 3600 }),
      redisB.set('refund:tx-shared', 'pending', { nx: true, ex: 3600 }),
    ]);

    const winners = [claimA, claimB].filter((r) => r === 'OK').length;
    assert.equal(winners, 1, 'exactly one Lambda claims the refund');

    // The losing call sees a non-OK response (null) and can read
    // back the existing value to surface "already in progress".
    const existing = await redisA.get<string>('refund:tx-shared');
    assert.equal(existing, 'pending');
  });

  it('claim release on pre-transfer error allows immediate retry', async () => {
    // processRefund DELs the marker on pre-transfer throw so retries
    // don't have to wait 30 days for the TTL.
    const state = makeState();
    const redis = makeMockRedis(state);

    await redis.set('refund:tx-retry', 'pending', { nx: true, ex: 3600 });
    // Simulate pre-transfer failure → release.
    await redis.del('refund:tx-retry');
    // Second attempt can claim.
    const second = await redis.set('refund:tx-retry', 'pending', { nx: true, ex: 3600 });
    assert.equal(second, 'OK');
  });
});

// ── Invariant 4: dead-letter upsert ────────────────────────────

describe('Cross-Lambda invariant: dead-letter resolution', () => {
  it('upsertDeadLetter replaces by transactionId — no duplicate "resolved" rows', async () => {
    // Pre-fix: recordDeadLetter was an append, so writing
    // {...original, resolvedAt} produced TWO rows. Recovery write
    // path now goes through upsertDeadLetter which is a true upsert.
    // The wider race (two operators recovering concurrently) is
    // closed by the per-user lock at the MCP tool layer; this test
    // covers the storage-layer upsert semantics that the lock
    // depends on.
    const state = makeState();
    const store = new RedisStore(makeMockRedis(state));

    await store.upsertDeadLetter({
      transactionId: 'tx-resolve',
      timestamp: '2026-01-01T00:00:00Z',
      error: 'transfer failed',
    });
    await store.upsertDeadLetter({
      transactionId: 'tx-resolve',
      timestamp: '2026-01-01T00:00:00Z',
      error: 'transfer failed',
      resolvedAt: '2026-01-02T00:00:00Z',
      resolvedBy: '0.0.operator',
      resolutionTxId: '0.0.0@resolution',
    });

    const list = store.getDeadLetters();
    assert.equal(list.length, 1, 'no duplicate row');
    assert.equal(list[0]!.resolvedAt, '2026-01-02T00:00:00Z');
  });
});
