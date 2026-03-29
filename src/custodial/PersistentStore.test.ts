import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentStore } from './PersistentStore.js';
import type { UserAccount } from './types.js';
import { emptyBalances, emptyOperatorState } from './types.js';

// ── Helpers ────────────────────────────────────────────────────

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
    strategyVersion: '1.0.0',
    strategySnapshot: {
      name: 'conservative',
      version: '1.0.0',
      poolFilter: { type: 'all', feeToken: 'any', minPrizeCount: 1 },
      budget: {
        maxSpendPerSession: 50,
        maxSpendPerPool: 10,
        maxEntriesPerPool: 10,
        reserveBalance: 5,
        currency: 'LAZY',
      },
      playStyle: {
        action: 'buy_and_roll',
        entriesPerBatch: 1,
        minExpectedValue: -Infinity,
        claimImmediately: true,
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

// ── Tests ──────────────────────────────────────────────────────

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
        available: 50,
        reserved: 30,
        totalDeposited: 80,
        totalWithdrawn: 0,
        totalRake: 0,
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
    assert.equal(recovered.balances.available, 80); // 50 + 30
    assert.equal(recovered.balances.reserved, 0);
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
      platformBalance: 42,
      totalRakeCollected: 42,
      totalGasSpent: 3.5,
    }));

    await store.flush();
    await store.close();

    // Reload and verify
    const store2 = new PersistentStore(dir);
    await store2.load();

    const reloaded = store2.getOperator();
    assert.equal(reloaded.platformBalance, 42);
    assert.equal(reloaded.totalRakeCollected, 42);
    assert.equal(reloaded.totalGasSpent, 3.5);
    assert.equal(reloaded.totalWithdrawnByOperator, 0);
    await store2.close();
  });
});
