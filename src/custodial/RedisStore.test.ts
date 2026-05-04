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
  saddCalls: number;
  sremCalls: number;
}

function makeSharedState(): SharedRedisState {
  return { sets: new Map(), saddCalls: 0, sremCalls: 0 };
}

function makeMockRedis(state: SharedRedisState): Redis {
  return {
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
  } as unknown as Redis;
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
