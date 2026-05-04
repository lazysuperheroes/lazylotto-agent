import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Redis } from '@upstash/redis';
import { RedisStore } from './RedisStore.js';

// ── Mock Redis ──────────────────────────────────────────────────
//
// The cross-Lambda dedup race that caused the duplicate-deposit
// incident is fundamentally about TWO RedisStore instances sharing the
// SAME Redis cluster. Their local `processedTxIds` Sets are independent;
// `deposits:processed` SADD is the synchronisation point. To exercise
// that, we hand both stores a mock that points at one shared Set.

interface SharedRedisState {
  sets: Map<string, Set<string>>;
  kv: Map<string, string | number>;
  lists: Map<string, string[]>;
  saddCalls: number;
  sremCalls: number;
  sismemberCalls: number;
  setNxAttempts: number;
  incrCalls: number;
}

function makeSharedState(): SharedRedisState {
  return {
    sets: new Map(),
    kv: new Map(),
    lists: new Map(),
    saddCalls: 0,
    sremCalls: 0,
    sismemberCalls: 0,
    setNxAttempts: 0,
    incrCalls: 0,
  };
}

interface PipelineOp {
  fn: () => Promise<unknown>;
}

function makeMockRedis(state: SharedRedisState): Redis {
  const api = {
    async sadd(key: string, ...members: string[]): Promise<number> {
      state.saddCalls++;
      let set = state.sets.get(key);
      if (!set) {
        set = new Set();
        state.sets.set(key, set);
      }
      let added = 0;
      for (const m of members) {
        if (!set.has(m)) {
          set.add(m);
          added++;
        }
      }
      return added;
    },
    async srem(key: string, ...members: string[]): Promise<number> {
      state.sremCalls++;
      const set = state.sets.get(key);
      if (!set) return 0;
      let removed = 0;
      for (const m of members) {
        if (set.delete(m)) removed++;
      }
      return removed;
    },
    async sismember(key: string, member: string): Promise<number> {
      state.sismemberCalls++;
      return state.sets.get(key)?.has(member) ? 1 : 0;
    },
    async set(
      key: string,
      value: string | number,
      options?: { nx?: boolean },
    ): Promise<string | null> {
      if (options?.nx) {
        state.setNxAttempts++;
        if (state.kv.has(key)) return null; // SETNX: not set
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
      state.incrCalls++;
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
      const iter = count >= 0 ? list : [...list].reverse();
      for (let i = iter.length - 1; i >= 0 && removed < limit; i--) {
        if (iter[i] === value) {
          if (count >= 0) list.splice(i, 1);
          else list.splice(list.length - 1 - i, 1);
          removed++;
        }
      }
      return removed;
    },
    async rpush(key: string, ...values: string[]): Promise<number> {
      let list = state.lists.get(key);
      if (!list) {
        list = [];
        state.lists.set(key, list);
      }
      list.push(...values);
      return list.length;
    },
    pipeline(): PipelineMock {
      const ops: PipelineOp[] = [];
      const chain: PipelineMock = {
        set: (...args: unknown[]) => {
          ops.push({ fn: () => (api.set as (...a: unknown[]) => Promise<unknown>)(...args) });
          return chain;
        },
        lrem: (...args: unknown[]) => {
          ops.push({ fn: () => (api.lrem as (...a: unknown[]) => Promise<unknown>)(...args) });
          return chain;
        },
        rpush: (...args: unknown[]) => {
          ops.push({ fn: () => (api.rpush as (...a: unknown[]) => Promise<unknown>)(...args) });
          return chain;
        },
        sadd: (...args: unknown[]) => {
          ops.push({ fn: () => (api.sadd as (...a: unknown[]) => Promise<unknown>)(...args) });
          return chain;
        },
        async exec() {
          const results: unknown[] = [];
          for (const op of ops) results.push(await op.fn());
          return results;
        },
      };
      return chain;
    },
  };
  return api as unknown as Redis;
}

interface PipelineMock {
  set: (...args: unknown[]) => PipelineMock;
  lrem: (...args: unknown[]) => PipelineMock;
  rpush: (...args: unknown[]) => PipelineMock;
  sadd: (...args: unknown[]) => PipelineMock;
  exec: () => Promise<unknown[]>;
}

/** Find the deposits-processed set regardless of network prefix. */
function depositsProcessedSet(state: SharedRedisState): Set<string> | undefined {
  for (const [key, set] of state.sets) {
    if (key.endsWith(':deposits:processed')) return set;
  }
  return undefined;
}

// ── Tests ───────────────────────────────────────────────────────

describe('RedisStore atomic claim semantics', () => {
  it('tryClaimTransaction returns true on first call, false on duplicate (single instance)', async () => {
    const state = makeSharedState();
    const store = new RedisStore(makeMockRedis(state));

    assert.equal(await store.tryClaimTransaction('tx-A'), true);
    assert.equal(await store.tryClaimTransaction('tx-A'), false);
    assert.equal(store.isTransactionProcessed('tx-A'), true);

    // Independent txId still claims successfully.
    assert.equal(await store.tryClaimTransaction('tx-B'), true);
  });

  it('cross-Lambda race: two RedisStore instances sharing one Redis — only one wins', async () => {
    // The actual incident: two warm Vercel Lambdas, two RedisStore
    // instances, ONE Redis cluster. Without the SADD-based claim, both
    // instances' local Set caches said "not processed" and both
    // credited the deposit. With the fix, the second SADD returns 0
    // (already a member) and tryClaimTransaction returns false.
    const state = makeSharedState();
    const lambdaA = new RedisStore(makeMockRedis(state));
    const lambdaB = new RedisStore(makeMockRedis(state));

    const [resA, resB] = await Promise.all([
      lambdaA.tryClaimTransaction('tx-shared'),
      lambdaB.tryClaimTransaction('tx-shared'),
    ]);

    // Exactly one wins.
    const winners = [resA, resB].filter(Boolean).length;
    assert.equal(winners, 1, 'exactly one Lambda wins the claim');

    // Only the winner has it in its local cache (the loser's SADD
    // returned 0 so we never added it locally).
    const winnerStore = resA ? lambdaA : lambdaB;
    const loserStore = resA ? lambdaB : lambdaA;
    assert.equal(winnerStore.isTransactionProcessed('tx-shared'), true);
    assert.equal(loserStore.isTransactionProcessed('tx-shared'), false);

    // Redis state has it exactly once.
    assert.equal(depositsProcessedSet(state)?.has('tx-shared'), true);
  });

  it('local fast-path: tryClaimTransaction skips Redis when local set already has the txId', async () => {
    const state = makeSharedState();
    const store = new RedisStore(makeMockRedis(state));

    await store.tryClaimTransaction('tx-fast');
    assert.equal(state.saddCalls, 1);

    // Second call: local set already has it, so SADD must NOT fire.
    await store.tryClaimTransaction('tx-fast');
    assert.equal(state.saddCalls, 1, 'local fast-path skips Redis on duplicate');
  });

  it('releaseTransactionClaim issues SREM and clears local cache', async () => {
    const state = makeSharedState();
    const store = new RedisStore(makeMockRedis(state));

    await store.tryClaimTransaction('tx-rollback');
    assert.equal(store.isTransactionProcessed('tx-rollback'), true);
    assert.equal(depositsProcessedSet(state)?.has('tx-rollback'), true);

    await store.releaseTransactionClaim('tx-rollback');
    assert.equal(store.isTransactionProcessed('tx-rollback'), false);
    assert.equal(depositsProcessedSet(state)?.has('tx-rollback'), false);
    assert.equal(state.sremCalls, 1);

    // After release, the same txId can be claimed again.
    assert.equal(await store.tryClaimTransaction('tx-rollback'), true);
  });
});

// ── isDepositCredited (cross-Lambda hard check) ─────────────────

describe('RedisStore.isDepositCredited', () => {
  it('returns true via local fast-path when txId is in local cache', async () => {
    const state = makeSharedState();
    const store = new RedisStore(makeMockRedis(state));

    await store.tryClaimTransaction('tx-local');
    // After a successful claim, the local cache has it. Subsequent
    // isDepositCredited calls should NOT need to hit Redis.
    state.sismemberCalls = 0;
    assert.equal(await store.isDepositCredited('tx-local'), true);
    assert.equal(state.sismemberCalls, 0, 'local fast-path skips SISMEMBER');
  });

  it('hits Redis SISMEMBER when local cache lacks the txId (the cross-Lambda case)', async () => {
    // Lambda A claims the deposit; Lambda B's local cache is empty
    // (cold-started before the claim). Lambda B's isDepositCredited
    // MUST consult Redis or it returns a stale-false result.
    const state = makeSharedState();
    const lambdaA = new RedisStore(makeMockRedis(state));
    const lambdaB = new RedisStore(makeMockRedis(state));

    await lambdaA.tryClaimTransaction('tx-shared-credit');
    // Lambda B never saw the claim — its local cache is empty.
    assert.equal(lambdaB.isTransactionProcessed('tx-shared-credit'), false);

    // The hard check via Redis should still return true.
    assert.equal(await lambdaB.isDepositCredited('tx-shared-credit'), true);
    assert.equal(state.sismemberCalls, 1);

    // After the SISMEMBER hit, Lambda B's local cache is backfilled
    // so future calls take the fast path.
    assert.equal(lambdaB.isTransactionProcessed('tx-shared-credit'), true);
  });

  it('returns false for unknown txId without poisoning the local cache', async () => {
    const state = makeSharedState();
    const store = new RedisStore(makeMockRedis(state));

    assert.equal(await store.isDepositCredited('tx-unknown'), false);
    assert.equal(store.isTransactionProcessed('tx-unknown'), false);
  });
});

// ── HCS-20 v2 agentSeq counter ──────────────────────────────────

describe('RedisStore.seedAgentSeq + nextAgentSeq', () => {
  it('seedAgentSeq + nextAgentSeq produces the documented sequence (last_seen → +1, +2, ...)', async () => {
    const state = makeSharedState();
    const store = new RedisStore(makeMockRedis(state));

    // Mirror scan saw highest agentSeq = 41. Seed with 41; first
    // nextAgentSeq must return 42.
    await store.seedAgentSeq('0.0.123', 41);
    assert.equal(await store.nextAgentSeq('0.0.123'), 42);
    assert.equal(await store.nextAgentSeq('0.0.123'), 43);
    assert.equal(await store.nextAgentSeq('0.0.123'), 44);
  });

  it('empty topic seed (-1) emits 0, 1, 2 — preserves pre-fix semantics', async () => {
    const state = makeSharedState();
    const store = new RedisStore(makeMockRedis(state));

    await store.seedAgentSeq('0.0.999', -1);
    assert.equal(await store.nextAgentSeq('0.0.999'), 0);
    assert.equal(await store.nextAgentSeq('0.0.999'), 1);
  });

  it('seedAgentSeq is SETNX — second call does not overwrite an existing seed', async () => {
    const state = makeSharedState();
    const store = new RedisStore(makeMockRedis(state));

    await store.seedAgentSeq('0.0.A', 100);
    await store.seedAgentSeq('0.0.A', 50); // loser of a cold-start race
    // First nextAgentSeq must reflect the WINNER's seed (100), not 50.
    assert.equal(await store.nextAgentSeq('0.0.A'), 101);
  });

  it('cross-Lambda race: two stores sharing one Redis — INCR returns unique values', async () => {
    // The exact incident shape for agentSeq: two warm Lambdas, one
    // Redis cluster, both writing v2 messages for DIFFERENT users.
    // The per-user lock doesn't serialise across users, so both can
    // call nextAgentSeq concurrently — the values MUST be unique.
    const state = makeSharedState();
    const lambdaA = new RedisStore(makeMockRedis(state));
    const lambdaB = new RedisStore(makeMockRedis(state));

    await lambdaA.seedAgentSeq('0.0.shared', -1);
    // Both Lambdas race for the next 6 sequence numbers.
    const results = await Promise.all([
      lambdaA.nextAgentSeq('0.0.shared'),
      lambdaB.nextAgentSeq('0.0.shared'),
      lambdaA.nextAgentSeq('0.0.shared'),
      lambdaB.nextAgentSeq('0.0.shared'),
      lambdaA.nextAgentSeq('0.0.shared'),
      lambdaB.nextAgentSeq('0.0.shared'),
    ]);

    const unique = new Set(results);
    assert.equal(unique.size, 6, 'every nextAgentSeq result must be unique');
    assert.deepStrictEqual([...unique].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  });

  it('per-agent counters are independent', async () => {
    const state = makeSharedState();
    const store = new RedisStore(makeMockRedis(state));

    await store.seedAgentSeq('0.0.X', -1);
    await store.seedAgentSeq('0.0.Y', 99);

    assert.equal(await store.nextAgentSeq('0.0.X'), 0);
    assert.equal(await store.nextAgentSeq('0.0.Y'), 100);
    assert.equal(await store.nextAgentSeq('0.0.X'), 1);
    assert.equal(await store.nextAgentSeq('0.0.Y'), 101);
  });
});

// ── upsertDeadLetter ─────────────────────────────────────────────

describe('RedisStore.upsertDeadLetter', () => {
  function findIndexList(state: SharedRedisState): string[] {
    for (const [key, val] of state.lists) {
      if (key.endsWith(':deadletters')) return val;
    }
    return [];
  }

  it('appends a fresh entry to the index list', async () => {
    const state = makeSharedState();
    const store = new RedisStore(makeMockRedis(state));

    await store.upsertDeadLetter({
      transactionId: 'tx-1',
      timestamp: '2026-01-01T00:00:00Z',
      error: 'first failure',
    });

    const list = findIndexList(state);
    assert.equal(list.length, 1);
    const parsed = JSON.parse(list[0]!) as { transactionId: string };
    assert.equal(parsed.transactionId, 'tx-1');
  });

  it('REPLACES an existing entry by transactionId — not appended', async () => {
    // The exact bug: dead-letter resolution writes
    // {...original, resolvedAt} and the original unresolved row should
    // vanish, not coexist.
    const state = makeSharedState();
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
      resolutionTxId: '0.0.0@resolution-tx',
    });

    const list = findIndexList(state);
    assert.equal(list.length, 1, 'only one entry remains after upsert');
    const parsed = JSON.parse(list[0]!) as {
      transactionId: string;
      resolvedAt?: string;
    };
    assert.equal(parsed.transactionId, 'tx-resolve');
    assert.equal(parsed.resolvedAt, '2026-01-02T00:00:00Z');

    // In-memory cache also reflects the upsert (no duplicate row).
    const inMemory = store.getDeadLetters();
    assert.equal(inMemory.length, 1);
    assert.equal(inMemory[0]!.resolvedAt, '2026-01-02T00:00:00Z');
  });

  it('migration path: existing entry without by_id pointer still gets replaced on upsert', async () => {
    // Pre-migration state: the LIST has an entry but the by_id key
    // doesn't exist (entry was written by old recordDeadLetter).
    // Upsert must scan the list, find by content, and still replace.
    const state = makeSharedState();
    const mock = makeMockRedis(state);
    const store = new RedisStore(mock);

    // Simulate pre-migration: rpush a JSON entry directly (bypass upsert)
    const oldEntry = {
      transactionId: 'tx-legacy',
      timestamp: '2026-01-01T00:00:00Z',
      error: 'old failure',
    };
    await mock.rpush(
      // Use the same key prefix the store uses for its writes.
      // Discover the key by attempting a fresh upsert, then resetting state.
      // Simpler: make the upsert do its scan path by NOT pre-populating by_id.
      'lla:testnet:store:deadletters',
      JSON.stringify(oldEntry),
    );

    await store.upsertDeadLetter({
      ...oldEntry,
      resolvedAt: '2026-01-02T00:00:00Z',
    });

    const list = findIndexList(state);
    assert.equal(list.length, 1, 'legacy entry replaced, not duplicated');
    const parsed = JSON.parse(list[0]!) as { resolvedAt?: string };
    assert.equal(parsed.resolvedAt, '2026-01-02T00:00:00Z');
  });

  it('different transactionIds coexist in insertion order', async () => {
    const state = makeSharedState();
    const store = new RedisStore(makeMockRedis(state));

    await store.upsertDeadLetter({
      transactionId: 'tx-A',
      timestamp: '2026-01-01T00:00:00Z',
      error: 'A failed',
    });
    await store.upsertDeadLetter({
      transactionId: 'tx-B',
      timestamp: '2026-01-01T00:00:01Z',
      error: 'B failed',
    });

    const list = findIndexList(state);
    assert.equal(list.length, 2);
    const txIds = list.map((row) => (JSON.parse(row) as { transactionId: string }).transactionId);
    assert.deepStrictEqual(txIds, ['tx-A', 'tx-B']);
  });
});
