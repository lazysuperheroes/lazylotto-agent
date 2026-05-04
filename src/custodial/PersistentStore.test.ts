import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentStore } from './PersistentStore.js';
import type { UserAccount } from './types.js';
import { emptyBalances, emptyOperatorState } from './types.js';

// -- Helpers ----------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ps-test-'));
}

function makeUser(overrides: Partial<UserAccount> = {}): UserAccount {
  return {
    userId: 'user-1',
    depositMemo: 'memo-1',
    hederaAccountId: '0.0.1234',
    eoaAddress: '0xabc',
    strategyName: 'conservative',
    strategyVersion: '0.2',
    strategySnapshot: {
      name: 'conservative',
      version: '0.2',
      poolFilter: { type: 'all', feeToken: 'any', minPrizeCount: 1 },
      budget: {
        tokenBudgets: {
          hbar: { maxPerSession: 50, maxPerPool: 10, reserve: 5 },
        },
        maxEntriesPerPool: 10,
      },
      playStyle: {
        action: 'buy_and_roll',
        entriesPerBatch: 1,
        minExpectedValue: -Infinity,
        preferNftPrizes: false,
        transferToOwner: true,
      },
      schedule: { enabled: false, cron: '0 */6 * * *', maxSessionsPerDay: 4 },
    },
    rakePercent: 1,
    balances: emptyBalances(),
    connectionTopicId: null,
    registeredAt: '2026-01-01T00:00:00.000Z',
    lastPlayedAt: null,
    active: true,
    ...overrides,
  };
}

// -- Tests ------------------------------------------------------------------

describe('PersistentStore', () => {
  let dir: string;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates data directory on load if missing', async () => {
    dir = join(tmpdir(), `ps-test-missing-${Date.now()}`);
    assert.equal(existsSync(dir), false);

    const store = new PersistentStore(dir);
    await store.load();

    assert.equal(existsSync(dir), true);
    await store.close();
  });

  it('saves and loads users', async () => {
    dir = makeTempDir();
    const store = new PersistentStore(dir);
    await store.load();

    const user = makeUser();
    store.saveUser(user);
    await store.flush();
    await store.close();

    // Load into a fresh instance
    const store2 = new PersistentStore(dir);
    await store2.load();

    const loaded = store2.getUser('user-1');
    assert.ok(loaded);
    assert.equal(loaded.userId, 'user-1');
    assert.equal(loaded.depositMemo, 'memo-1');
    assert.equal(loaded.hederaAccountId, '0.0.1234');
    await store2.close();
  });

  it('memo index works for getUserByMemo', async () => {
    dir = makeTempDir();
    const store = new PersistentStore(dir);
    await store.load();

    store.saveUser(makeUser({ userId: 'u-a', depositMemo: 'memo-alpha' }));
    store.saveUser(makeUser({ userId: 'u-b', depositMemo: 'memo-beta' }));
    await store.flush();

    // Look up by memo
    const a = store.getUserByMemo('memo-alpha');
    assert.ok(a);
    assert.equal(a.userId, 'u-a');

    const b = store.getUserByMemo('memo-beta');
    assert.ok(b);
    assert.equal(b.userId, 'u-b');

    assert.equal(store.getUserByMemo('no-such-memo'), undefined);

    // Verify index survives a reload
    await store.close();
    const store2 = new PersistentStore(dir);
    await store2.load();

    const a2 = store2.getUserByMemo('memo-alpha');
    assert.ok(a2);
    assert.equal(a2.userId, 'u-a');
    await store2.close();
  });

  it('accountId index works for getUserByAccountId', async () => {
    dir = makeTempDir();
    const store = new PersistentStore(dir);
    await store.load();

    store.saveUser(makeUser({ userId: 'u-x', hederaAccountId: '0.0.5555' }));
    store.saveUser(makeUser({ userId: 'u-y', hederaAccountId: '0.0.6666' }));
    await store.flush();

    const x = store.getUserByAccountId('0.0.5555');
    assert.ok(x);
    assert.equal(x.userId, 'u-x');

    const y = store.getUserByAccountId('0.0.6666');
    assert.ok(y);
    assert.equal(y.userId, 'u-y');

    assert.equal(store.getUserByAccountId('0.0.0000'), undefined);

    // Verify index survives a reload
    await store.close();
    const store2 = new PersistentStore(dir);
    await store2.load();

    const x2 = store2.getUserByAccountId('0.0.5555');
    assert.ok(x2);
    assert.equal(x2.userId, 'u-x');
    await store2.close();
  });

  it('tryClaimTransaction returns true on first call, false on duplicate', async () => {
    dir = makeTempDir();
    const store = new PersistentStore(dir);
    await store.load();

    assert.equal(await store.tryClaimTransaction('tx-claim-1'), true);
    assert.equal(await store.tryClaimTransaction('tx-claim-1'), false);
    assert.equal(store.isTransactionProcessed('tx-claim-1'), true);

    // Independent txId still claims successfully
    assert.equal(await store.tryClaimTransaction('tx-claim-2'), true);

    await store.close();
  });

  it('releaseTransactionClaim allows the same txId to be re-claimed', async () => {
    dir = makeTempDir();
    const store = new PersistentStore(dir);
    await store.load();

    assert.equal(await store.tryClaimTransaction('tx-rollback'), true);
    assert.equal(await store.tryClaimTransaction('tx-rollback'), false);

    await store.releaseTransactionClaim('tx-rollback');
    assert.equal(store.isTransactionProcessed('tx-rollback'), false);
    assert.equal(await store.tryClaimTransaction('tx-rollback'), true);

    await store.close();
  });

  it('concurrent tryClaimTransaction: only one wins', async () => {
    dir = makeTempDir();
    const store = new PersistentStore(dir);
    await store.load();

    // Fire 8 concurrent claims for the same txId. JS event loop is
    // single-threaded so this is a fair single-process race test.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.tryClaimTransaction('tx-race')),
    );

    const winners = results.filter((r) => r === true).length;
    assert.equal(winners, 1, 'exactly one caller wins the claim');

    await store.close();
  });

  it('isDepositCredited reflects local processed set', async () => {
    dir = makeTempDir();
    const store = new PersistentStore(dir);
    await store.load();

    assert.equal(await store.isDepositCredited('tx-credited'), false);
    await store.tryClaimTransaction('tx-credited');
    assert.equal(await store.isDepositCredited('tx-credited'), true);

    await store.close();
  });

  it('seedAgentSeq + nextAgentSeq produces last_seen → +1, +2 sequence', async () => {
    dir = makeTempDir();
    const store = new PersistentStore(dir);
    await store.load();

    await store.seedAgentSeq('0.0.A', 41);
    assert.equal(await store.nextAgentSeq('0.0.A'), 42);
    assert.equal(await store.nextAgentSeq('0.0.A'), 43);

    await store.close();
  });

  it('seedAgentSeq is idempotent — second seed does not overwrite', async () => {
    dir = makeTempDir();
    const store = new PersistentStore(dir);
    await store.load();

    await store.seedAgentSeq('0.0.A', 100);
    await store.seedAgentSeq('0.0.A', 50);
    assert.equal(await store.nextAgentSeq('0.0.A'), 101);

    await store.close();
  });

  it('agentSeq counters per agentAccountId are independent', async () => {
    dir = makeTempDir();
    const store = new PersistentStore(dir);
    await store.load();

    await store.seedAgentSeq('0.0.X', -1);
    await store.seedAgentSeq('0.0.Y', 99);

    assert.equal(await store.nextAgentSeq('0.0.X'), 0);
    assert.equal(await store.nextAgentSeq('0.0.Y'), 100);
    assert.equal(await store.nextAgentSeq('0.0.X'), 1);

    await store.close();
  });

  it('upsertDeadLetter replaces existing entry by transactionId', async () => {
    dir = makeTempDir();
    const store = new PersistentStore(dir);
    await store.load();

    await store.upsertDeadLetter({
      transactionId: 'tx-1',
      timestamp: '2026-01-01T00:00:00Z',
      error: 'original',
    });
    await store.upsertDeadLetter({
      transactionId: 'tx-1',
      timestamp: '2026-01-01T00:00:00Z',
      error: 'original',
      resolvedAt: '2026-01-02T00:00:00Z',
    });

    const list = store.getDeadLetters();
    assert.equal(list.length, 1, 'no duplicate row');
    assert.equal(list[0]!.resolvedAt, '2026-01-02T00:00:00Z');

    await store.close();
  });

  it('upsertDeadLetter appends distinct entries', async () => {
    dir = makeTempDir();
    const store = new PersistentStore(dir);
    await store.load();

    await store.upsertDeadLetter({
      transactionId: 'tx-1',
      timestamp: '2026-01-01T00:00:00Z',
      error: 'first',
    });
    await store.upsertDeadLetter({
      transactionId: 'tx-2',
      timestamp: '2026-01-01T00:00:01Z',
      error: 'second',
    });

    const list = store.getDeadLetters();
    assert.equal(list.length, 2);
    assert.deepStrictEqual(
      list.map((e) => e.transactionId),
      ['tx-1', 'tx-2'],
    );

    await store.close();
  });

  it('tracks processed transaction IDs', async () => {
    dir = makeTempDir();
    const store = new PersistentStore(dir);
    await store.load();

    assert.equal(store.isTransactionProcessed('tx-1'), false);

    store.recordDeposit({
      transactionId: 'tx-1',
      userId: 'user-1',
      grossAmount: 100,
      rakeAmount: 1,
      netAmount: 99,
      tokenId: null,
      memo: 'memo-1',
      timestamp: new Date().toISOString(),
    });

    assert.equal(store.isTransactionProcessed('tx-1'), true);
    assert.equal(store.isTransactionProcessed('tx-2'), false);

    // Verify persistence across reload
    await store.flush();
    await store.close();

    const store2 = new PersistentStore(dir);
    await store2.load();
    assert.equal(store2.isTransactionProcessed('tx-1'), true);
    assert.equal(store2.isTransactionProcessed('tx-2'), false);
    await store2.close();
  });

  it('recovers orphaned reserves on load', async () => {
    dir = makeTempDir();
    const store = new PersistentStore(dir);
    await store.load();

    // Save a user with funds in reserved (simulating a crash mid-play)
    const user = makeUser({
      balances: {
        tokens: {
          hbar: {
            available: 50,
            reserved: 30,
            totalDeposited: 80,
            totalWithdrawn: 0,
            totalRake: 0,
          },
        },
      },
    });
    store.saveUser(user);
    await store.flush();
    await store.close();

    // Reload -- orphaned reserves should be moved back to available
    const store2 = new PersistentStore(dir);
    await store2.load();

    const recovered = store2.getUser('user-1');
    assert.ok(recovered);
    assert.equal(recovered.balances.tokens.hbar.available, 80); // 50 + 30
    assert.equal(recovered.balances.tokens.hbar.reserved, 0);
    await store2.close();
  });

  it('watermark persists across load/flush cycles', async () => {
    dir = makeTempDir();
    const store = new PersistentStore(dir);
    await store.load();

    assert.equal(store.getWatermark(), '');

    store.setWatermark('2026-03-01T12:00:00.000Z');
    assert.equal(store.getWatermark(), '2026-03-01T12:00:00.000Z');

    await store.flush();
    await store.close();

    const store2 = new PersistentStore(dir);
    await store2.load();
    assert.equal(store2.getWatermark(), '2026-03-01T12:00:00.000Z');

    // Update watermark and verify again
    store2.setWatermark('2026-03-15T08:30:00.000Z');
    await store2.flush();
    await store2.close();

    const store3 = new PersistentStore(dir);
    await store3.load();
    assert.equal(store3.getWatermark(), '2026-03-15T08:30:00.000Z');
    await store3.close();
  });

  it('operator state persists', async () => {
    dir = makeTempDir();
    const store = new PersistentStore(dir);
    await store.load();

    // Verify initial state
    const initial = store.getOperator();
    assert.deepStrictEqual(initial, emptyOperatorState());

    // Modify operator state
    store.updateOperator((op) => ({
      ...op,
      balances: { hbar: 42 },
      totalRakeCollected: { hbar: 42 },
      totalGasSpent: 3.5,
    }));

    await store.flush();
    await store.close();

    // Reload and verify
    const store2 = new PersistentStore(dir);
    await store2.load();

    const reloaded = store2.getOperator();
    assert.equal(reloaded.balances.hbar, 42);
    assert.equal(reloaded.totalRakeCollected.hbar, 42);
    assert.equal(reloaded.totalGasSpent, 3.5);
    assert.deepStrictEqual(reloaded.totalWithdrawnByOperator, {});
    await store2.close();
  });
});
