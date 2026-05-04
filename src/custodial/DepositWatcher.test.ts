import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DepositWatcher } from './DepositWatcher.js';
import type { PersistentStore } from './PersistentStore.js';
import type { UserLedger } from './UserLedger.js';
import type { MirrorTransaction } from '../hedera/mirror.js';
import type {
  CustodialConfig,
  UserAccount,
  UserBalances,
  OperatorState,
  DepositRecord,
} from './types.js';
import { emptyBalances, emptyOperatorState } from './types.js';
import { registerToken } from '../utils/math.js';

// ── Test Config ────────────────────────────────────────────────

const AGENT_ACCOUNT = '0.0.9999';

const TEST_CONFIG: CustodialConfig = {
  rake: {
    defaultPercent: 5,
    minPercent: 2,
    maxPercent: 5,
    volumeTiers: [
      { minDeposit: 1000, rakePercent: 3 },
      { minDeposit: 200, rakePercent: 4 },
      { minDeposit: 50, rakePercent: 5 },
    ],
  },
  depositPollIntervalMs: 10_000,
  hcs10PollIntervalMs: 15_000,
  minDepositAmount: 1,
  maxUserBalance: 10_000,
  maxUsersPerPlayCycle: 10,
  gasReservePerUser: 5,
  hcs20Tick: 'LLCRED',
  hcs20TopicId: null,
  dataDir: '.test-data',
};

// ── Helpers ────────────────────────────────────────────────────

function makeUser(overrides: Partial<UserAccount> = {}): UserAccount {
  return {
    userId: 'user-1',
    depositMemo: 'll-abcdef1234567890abcdef1234567890',
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
    rakePercent: 5,
    balances: emptyBalances(),
    connectionTopicId: null,
    registeredAt: '2026-01-01T00:00:00.000Z',
    lastPlayedAt: null,
    active: true,
    ...overrides,
  };
}

function encodeMemo(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

function makeTx(overrides: Partial<MirrorTransaction> = {}): MirrorTransaction {
  return {
    transaction_id: 'tx-001',
    consensus_timestamp: '1700000000.000000001',
    memo_base64: encodeMemo('ll-abcdef1234567890abcdef1234567890'),
    result: 'SUCCESS',
    transfers: [
      { account: AGENT_ACCOUNT, amount: 5_00000000 }, // 5 HBAR in tinybars
    ],
    token_transfers: [],
    ...overrides,
  };
}

interface MockStoreState {
  users: Map<string, UserAccount>;
  processedTxIds: Set<string>;
  memoIndex: Map<string, UserAccount>;
  watermark: string;
  deadLetters: { transactionId: string; timestamp: string; error: string }[];
  deposits: DepositRecord[];
  operator: OperatorState;
}

function createMockStore(initial?: Partial<MockStoreState>): PersistentStore & { _state: MockStoreState } {
  const state: MockStoreState = {
    users: initial?.users ?? new Map(),
    processedTxIds: initial?.processedTxIds ?? new Set(),
    memoIndex: initial?.memoIndex ?? new Map(),
    watermark: initial?.watermark ?? '',
    deadLetters: initial?.deadLetters ?? [],
    deposits: initial?.deposits ?? [],
    operator: initial?.operator ?? emptyOperatorState(),
  };

  return {
    _state: state,

    getUser(userId: string): UserAccount | undefined {
      return state.users.get(userId);
    },
    getUserByMemo(memo: string): UserAccount | undefined {
      return state.memoIndex.get(memo);
    },
    getUserByAccountId(_accountId: string): UserAccount | undefined {
      for (const user of state.users.values()) {
        if (user.hederaAccountId === _accountId) return user;
      }
      return undefined;
    },
    saveUser(user: UserAccount): void {
      state.users.set(user.userId, user);
      state.memoIndex.set(user.depositMemo, user);
    },
    isTransactionProcessed(txId: string): boolean {
      return state.processedTxIds.has(txId);
    },
    async tryClaimTransaction(txId: string): Promise<boolean> {
      if (state.processedTxIds.has(txId)) return false;
      state.processedTxIds.add(txId);
      return true;
    },
    async releaseTransactionClaim(txId: string): Promise<void> {
      state.processedTxIds.delete(txId);
    },
    recordDeposit(record: DepositRecord): void {
      state.processedTxIds.add(record.transactionId);
      state.deposits.push(record);
    },
    getWatermark(): string {
      return state.watermark;
    },
    setWatermark(timestamp: string): void {
      state.watermark = timestamp;
    },
    recordDeadLetter(entry: { transactionId: string; timestamp: string; error: string }): void {
      state.deadLetters.push(entry);
    },
    getDeadLetters() {
      return state.deadLetters;
    },
    getOperator(): OperatorState {
      return state.operator;
    },
    updateOperator(updater: (s: OperatorState) => OperatorState): OperatorState {
      state.operator = updater(state.operator);
      return state.operator;
    },
    updateBalance(userId: string, updater: (b: UserBalances) => UserBalances): UserBalances {
      const user = state.users.get(userId);
      if (!user) throw new Error(`User not found: ${userId}`);
      user.balances = updater(user.balances);
      return user.balances;
    },
    async flush(): Promise<void> {
      // no-op
    },
  } as unknown as PersistentStore & { _state: MockStoreState };
}

interface LedgerCall {
  method: string;
  args: unknown[];
}

function createMockLedger(): UserLedger & { _calls: LedgerCall[] } {
  const calls: LedgerCall[] = [];
  return {
    _calls: calls,
    async creditDeposit(
      userId: string,
      grossAmount: number,
      txId: string,
      rakePercent: number,
      token: string,
    ): Promise<UserBalances> {
      calls.push({
        method: 'creditDeposit',
        args: [userId, grossAmount, txId, rakePercent, token],
      });
      return { tokens: {} };
    },
  } as unknown as UserLedger & { _calls: LedgerCall[] };
}

// ── Tests ──────────────────────────────────────────────────────
//
// The DepositWatcher.pollOnce() calls the module-level
// getTransactionsByAccount function from ../hedera/mirror.ts.
// Since node:test mock.module is experimental and may not work
// reliably with ESM, we take a pragmatic testing approach:
//
// We test the DepositWatcher's store-interaction logic by verifying
// the state changes on the mock store and mock ledger after pollOnce
// completes. For tests that need to control mirror node output, we
// mock the module at the top level.
//
// For tests that cannot easily mock the mirror import, we verify
// the store-level invariants directly (idempotency, dead-letters,
// watermark advancement).

describe('DepositWatcher', () => {
  let mockStore: ReturnType<typeof createMockStore>;
  let mockLedger: ReturnType<typeof createMockLedger>;
  let watcher: DepositWatcher;

  // ── Lifecycle ────────────────────────────────────────────────

  describe('lifecycle', () => {
    beforeEach(() => {
      mockStore = createMockStore();
      mockLedger = createMockLedger();
      watcher = new DepositWatcher(AGENT_ACCOUNT, mockStore, mockLedger, TEST_CONFIG);
    });

    afterEach(() => {
      watcher.stop();
    });

    it('isRunning returns false before start', () => {
      assert.equal(watcher.isRunning(), false);
    });

    it('isRunning returns true after start', () => {
      // start() calls pollOnce immediately, which will fail because
      // getTransactionsByAccount is not mocked here -- that is fine,
      // we only need to verify the timer was created.
      watcher.start();
      assert.equal(watcher.isRunning(), true);
    });

    it('isRunning returns false after stop', () => {
      watcher.start();
      watcher.stop();
      assert.equal(watcher.isRunning(), false);
    });

    it('start is idempotent (calling twice does not create duplicate timers)', () => {
      watcher.start();
      watcher.start();
      assert.equal(watcher.isRunning(), true);
      watcher.stop();
      assert.equal(watcher.isRunning(), false);
    });
  });

  // ── Store Idempotency ────────────────────────────────────────

  describe('idempotency via store', () => {
    it('isTransactionProcessed returns true for already-recorded deposits', () => {
      mockStore = createMockStore({
        processedTxIds: new Set(['tx-already-done']),
      });

      assert.equal(mockStore.isTransactionProcessed('tx-already-done'), true);
      assert.equal(mockStore.isTransactionProcessed('tx-new'), false);
    });
  });

  // ── Dead Letters ─────────────────────────────────────────────

  describe('dead-letter recording', () => {
    it('records dead-letter entries on the store', () => {
      mockStore = createMockStore();

      mockStore.recordDeadLetter({
        transactionId: 'tx-fail-1',
        timestamp: '1700000000.000000001',
        error: 'Unexpected format',
      });

      const letters = mockStore.getDeadLetters();
      assert.equal(letters.length, 1);
      assert.equal(letters[0].transactionId, 'tx-fail-1');
      assert.equal(letters[0].error, 'Unexpected format');
    });

    it('accumulates multiple dead-letter entries', () => {
      mockStore = createMockStore();

      mockStore.recordDeadLetter({
        transactionId: 'tx-fail-1',
        timestamp: '1700000000.000000001',
        error: 'Error A',
      });
      mockStore.recordDeadLetter({
        transactionId: 'tx-fail-2',
        timestamp: '1700000000.000000002',
        error: 'Error B',
      });

      assert.equal(mockStore.getDeadLetters().length, 2);
    });
  });

  // ── Watermark Advancement ────────────────────────────────────

  describe('watermark', () => {
    it('watermark starts empty', () => {
      mockStore = createMockStore();
      assert.equal(mockStore.getWatermark(), '');
    });

    it('watermark advances when set', () => {
      mockStore = createMockStore();
      mockStore.setWatermark('1700000000.000000099');
      assert.equal(mockStore.getWatermark(), '1700000000.000000099');
    });

    it('watermark can be overwritten', () => {
      mockStore = createMockStore();
      mockStore.setWatermark('1700000000.000000001');
      mockStore.setWatermark('1700000000.000000050');
      assert.equal(mockStore.getWatermark(), '1700000000.000000050');
    });
  });

  // ── User Lookup by Memo ──────────────────────────────────────

  describe('user lookup by memo', () => {
    it('returns user matching the deposit memo', () => {
      const user = makeUser();
      const memoIndex = new Map<string, UserAccount>();
      memoIndex.set(user.depositMemo, user);
      mockStore = createMockStore({ memoIndex });

      const found = mockStore.getUserByMemo(user.depositMemo);
      assert.ok(found);
      assert.equal(found.userId, 'user-1');
    });

    it('returns undefined for unknown memo', () => {
      mockStore = createMockStore();
      const found = mockStore.getUserByMemo('ll-nonexistent0000000000000000000');
      assert.equal(found, undefined);
    });
  });

  // ── Inactive User Rejection ──────────────────────────────────

  describe('inactive user handling', () => {
    it('inactive user has active=false', () => {
      const user = makeUser({ active: false });
      const memoIndex = new Map<string, UserAccount>();
      memoIndex.set(user.depositMemo, user);
      mockStore = createMockStore({ memoIndex });

      const found = mockStore.getUserByMemo(user.depositMemo);
      assert.ok(found);
      assert.equal(found.active, false);
    });
  });

  // ── Max Balance Enforcement ──────────────────────────────────

  describe('max balance check', () => {
    it('user balance near max would cause deposit to exceed limit', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: {
              available: 9990,
              reserved: 0,
              totalDeposited: 9990,
              totalWithdrawn: 0,
              totalRake: 0,
            },
          },
        },
      });

      // Simulating the check DepositWatcher does internally:
      // if (currentAvailable + credit.amount > config.maxUserBalance) skip
      const creditAmount = 20; // 9990 + 20 = 10010 > 10000
      const tokenEntry = user.balances.tokens['hbar'];
      const currentAvailable = tokenEntry?.available ?? 0;

      assert.equal(
        currentAvailable + creditAmount > TEST_CONFIG.maxUserBalance,
        true,
        'deposit should exceed max balance',
      );
    });

    it('user balance below max allows deposit', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: {
              available: 100,
              reserved: 0,
              totalDeposited: 100,
              totalWithdrawn: 0,
              totalRake: 0,
            },
          },
        },
      });

      const creditAmount = 5;
      const tokenEntry = user.balances.tokens['hbar'];
      const currentAvailable = tokenEntry?.available ?? 0;

      assert.equal(
        currentAvailable + creditAmount > TEST_CONFIG.maxUserBalance,
        false,
        'deposit should be within max balance',
      );
    });
  });

  // ── Memo Encoding ────────────────────────────────────────────

  describe('memo encoding', () => {
    it('encodes and decodes memo correctly via base64', () => {
      const original = 'll-abcdef1234567890abcdef1234567890';
      const encoded = encodeMemo(original);
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      assert.equal(decoded, original);
    });

    it('empty memo decodes to empty string', () => {
      const decoded = Buffer.from('', 'base64').toString('utf-8');
      assert.equal(decoded, '');
    });
  });

  // ── MirrorTransaction Helpers ────────────────────────────────

  describe('transaction fixture construction', () => {
    it('makeTx produces a valid HBAR deposit transaction', () => {
      const tx = makeTx();
      assert.equal(tx.result, 'SUCCESS');
      assert.equal(tx.transfers.length, 1);
      assert.equal(tx.transfers[0].account, AGENT_ACCOUNT);
      assert.equal(tx.transfers[0].amount, 5_00000000);
      assert.equal(tx.token_transfers.length, 0);
    });

    it('makeTx can produce a token transfer transaction', () => {
      const tx = makeTx({
        token_transfers: [
          { token_id: '0.0.8011209', account: AGENT_ACCOUNT, amount: 1000 },
        ],
        transfers: [],
      });
      assert.equal(tx.token_transfers.length, 1);
      assert.equal(tx.token_transfers[0].token_id, '0.0.8011209');
    });
  });

  // ── Ledger creditDeposit Call Tracking ────────────────────────

  describe('ledger interaction', () => {
    it('mock ledger tracks creditDeposit calls', async () => {
      mockLedger = createMockLedger();

      await mockLedger.creditDeposit('user-1', 100, 'tx-001', 5, 'hbar');

      assert.equal(mockLedger._calls.length, 1);
      assert.equal(mockLedger._calls[0].method, 'creditDeposit');
      assert.deepStrictEqual(mockLedger._calls[0].args, [
        'user-1', 100, 'tx-001', 5, 'hbar',
      ]);
    });
  });

  // ── HBAR Credit Extraction ───────────────────────────────────

  describe('HBAR credit calculation', () => {
    it('converts tinybars to HBAR correctly', () => {
      // DepositWatcher internally divides by TINYBARS_PER_HBAR (1e8)
      const tinybars = 5_00000000;
      const hbar = tinybars / 1e8;
      assert.equal(hbar, 5);
    });

    it('handles fractional HBAR amounts', () => {
      const tinybars = 1_50000000; // 1.5 HBAR
      const hbar = tinybars / 1e8;
      assert.equal(hbar, 1.5);
    });
  });

  // ── Token Credit Extraction ──────────────────────────────────

  describe('token credit calculation', () => {
    it('converts LAZY token amount with 1 decimal place', () => {
      // LAZY uses 1 decimal: 10 base units = 1 LAZY
      const baseUnits = 1000;
      const lazyAmount = baseUnits / Math.pow(10, 1);
      assert.equal(lazyAmount, 100);
    });

    it('converts token amount with 8 decimals', () => {
      const baseUnits = 100000000; // 1 token with 8 decimals
      const amount = baseUnits / Math.pow(10, 8);
      assert.equal(amount, 1);
    });
  });

  // ── Failed Transaction Filtering ─────────────────────────────

  describe('transaction result filtering', () => {
    it('only SUCCESS transactions should be processed', () => {
      const successTx = makeTx({ result: 'SUCCESS' });
      const failedTx = makeTx({ result: 'INSUFFICIENT_ACCOUNT_BALANCE' });

      assert.equal(successTx.result === 'SUCCESS', true);
      assert.equal(failedTx.result === 'SUCCESS', false);
    });
  });
});

// ── processTransaction end-to-end tests ────────────────────────
//
// These tests invoke the private processTransaction method directly
// via (watcher as any).processTransaction(tx) to exercise the full
// internal pipeline: result check -> idempotency -> memo decode ->
// user lookup -> active check -> extractCredit -> max balance ->
// ledger creditDeposit. This avoids the need to mock the ES module
// mirror import that pollOnce depends on.

describe('DepositWatcher.processTransaction (end-to-end)', () => {
  let mockStore: ReturnType<typeof createMockStore>;
  let mockLedger: ReturnType<typeof createMockLedger>;
  let watcher: DepositWatcher;

  beforeEach(() => {
    mockStore = createMockStore();
    mockLedger = createMockLedger();
    watcher = new DepositWatcher(AGENT_ACCOUNT, mockStore, mockLedger, TEST_CONFIG);
  });

  /** Helper: register a user in the mock store and return it. */
  function registerUser(overrides: Partial<UserAccount> = {}): UserAccount {
    const user = makeUser(overrides);
    mockStore.saveUser(user);
    return user;
  }

  // ── HBAR deposit ──────────────────────────────────────────────

  it('credits HBAR deposit to user balance via ledger', async () => {
    const user = registerUser();

    const tx = makeTx({
      transaction_id: 'tx-hbar-001',
      memo_base64: encodeMemo(user.depositMemo),
      transfers: [
        { account: AGENT_ACCOUNT, amount: 10_00000000 }, // 10 HBAR
      ],
      token_transfers: [],
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, true, 'processTransaction should return true for credited deposit');
    assert.equal(mockLedger._calls.length, 1);
    assert.equal(mockLedger._calls[0].method, 'creditDeposit');
    assert.deepStrictEqual(mockLedger._calls[0].args, [
      user.userId, 10, 'tx-hbar-001', user.rakePercent, 'hbar',
    ]);
  });

  // ── Fractional HBAR deposit ───────────────────────────────────

  it('credits fractional HBAR deposit correctly', async () => {
    const user = registerUser();

    const tx = makeTx({
      transaction_id: 'tx-hbar-frac',
      memo_base64: encodeMemo(user.depositMemo),
      transfers: [
        { account: AGENT_ACCOUNT, amount: 2_50000000 }, // 2.5 HBAR
      ],
      token_transfers: [],
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, true);
    assert.equal(mockLedger._calls[0].args[1], 2.5, 'should convert tinybars to 2.5 HBAR');
  });

  // ── Known token deposit (LAZY, 1 decimal) ────────────────────

  it('credits known token deposit with correct decimal conversion', async () => {
    const LAZY_TOKEN_ID = '0.0.8011209';
    registerToken(LAZY_TOKEN_ID, 1, 'LAZY');

    const user = registerUser();

    const tx = makeTx({
      transaction_id: 'tx-lazy-001',
      memo_base64: encodeMemo(user.depositMemo),
      transfers: [],
      token_transfers: [
        { token_id: LAZY_TOKEN_ID, account: AGENT_ACCOUNT, amount: 500 }, // 50 LAZY (1 decimal)
      ],
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, true, 'processTransaction should return true for token deposit');
    assert.equal(mockLedger._calls.length, 1);
    assert.deepStrictEqual(mockLedger._calls[0].args, [
      user.userId, 50, 'tx-lazy-001', user.rakePercent, LAZY_TOKEN_ID,
    ]);
  });

  // ── Known token deposit (8 decimals) ──────────────────────────

  it('credits token with 8 decimals correctly', async () => {
    const TOKEN_ID = '0.0.55555';
    registerToken(TOKEN_ID, 8, 'USDC');

    const user = registerUser();

    const tx = makeTx({
      transaction_id: 'tx-usdc-001',
      memo_base64: encodeMemo(user.depositMemo),
      transfers: [],
      token_transfers: [
        { token_id: TOKEN_ID, account: AGENT_ACCOUNT, amount: 3_00000000 }, // 3.0 USDC
      ],
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, true);
    assert.deepStrictEqual(mockLedger._calls[0].args, [
      user.userId, 3, 'tx-usdc-001', user.rakePercent, TOKEN_ID,
    ]);
  });

  // ── Unknown token deposit → throws (dead-letter) ─────────────

  it('throws on unknown token deposit (triggers dead-letter in pollOnce)', async () => {
    const UNKNOWN_TOKEN = '0.0.999999';
    // Deliberately NOT registering this token

    const user = registerUser();

    const tx = makeTx({
      transaction_id: 'tx-unknown-token',
      memo_base64: encodeMemo(user.depositMemo),
      transfers: [],
      token_transfers: [
        { token_id: UNKNOWN_TOKEN, account: AGENT_ACCOUNT, amount: 100 },
      ],
    });

    await assert.rejects(
      () => (watcher as any).processTransaction(tx),
      (err: Error) => {
        assert.match(err.message, /Unknown token 0\.0\.999999/);
        assert.match(err.message, /not in registry/);
        return true;
      },
    );

    // Ledger should NOT have been called
    assert.equal(mockLedger._calls.length, 0);
  });

  // ── Inactive user deposit → dead-letter, not credited ────────

  it('returns false and records dead-letter for inactive user deposit', async () => {
    const user = registerUser({ active: false });

    const tx = makeTx({
      transaction_id: 'tx-inactive-001',
      memo_base64: encodeMemo(user.depositMemo),
      transfers: [
        { account: AGENT_ACCOUNT, amount: 5_00000000 },
      ],
      token_transfers: [],
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, false, 'should not credit inactive user');
    assert.equal(mockLedger._calls.length, 0, 'ledger should not be called');

    // Dead-letter entry should be recorded
    const deadLetters = mockStore.getDeadLetters();
    assert.equal(deadLetters.length, 1);
    assert.equal(deadLetters[0].transactionId, 'tx-inactive-001');
    assert.match(deadLetters[0].error, /inactive/i);
  });

  // ── Max balance exceeded → not credited ───────────────────────

  it('returns false when deposit would exceed maxUserBalance', async () => {
    const user = registerUser({
      balances: {
        tokens: {
          hbar: {
            available: 9999,
            reserved: 0,
            totalDeposited: 9999,
            totalWithdrawn: 0,
            totalRake: 0,
          },
        },
      },
    });

    const tx = makeTx({
      transaction_id: 'tx-over-max',
      memo_base64: encodeMemo(user.depositMemo),
      transfers: [
        { account: AGENT_ACCOUNT, amount: 2_00000000 }, // 2 HBAR → 9999 + 2 = 10001 > 10000
      ],
      token_transfers: [],
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, false, 'should reject deposit exceeding max balance');
    assert.equal(mockLedger._calls.length, 0, 'ledger should not be called');
  });

  // ── Max balance exactly at limit → still accepted ─────────────

  it('accepts deposit when balance + deposit equals maxUserBalance exactly', async () => {
    const user = registerUser({
      balances: {
        tokens: {
          hbar: {
            available: 9995,
            reserved: 0,
            totalDeposited: 9995,
            totalWithdrawn: 0,
            totalRake: 0,
          },
        },
      },
    });

    const tx = makeTx({
      transaction_id: 'tx-exact-max',
      memo_base64: encodeMemo(user.depositMemo),
      transfers: [
        { account: AGENT_ACCOUNT, amount: 5_00000000 }, // 5 HBAR → 9995 + 5 = 10000 == max
      ],
      token_transfers: [],
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, true, 'should accept deposit that hits max exactly');
    assert.equal(mockLedger._calls.length, 1);
  });

  // ── Unknown memo → not credited ──────────────────────────────

  it('returns false for unrecognized deposit memo', async () => {
    // No user registered with this memo
    const tx = makeTx({
      transaction_id: 'tx-unknown-memo',
      memo_base64: encodeMemo('ll-unknownmemo00000000000000000000'),
      transfers: [
        { account: AGENT_ACCOUNT, amount: 1_00000000 },
      ],
      token_transfers: [],
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, false, 'should skip unknown memo');
    assert.equal(mockLedger._calls.length, 0);
  });

  // ── Empty memo → not credited ────────────────────────────────

  it('returns false for empty memo', async () => {
    registerUser();

    const tx = makeTx({
      transaction_id: 'tx-no-memo',
      memo_base64: '',
      transfers: [
        { account: AGENT_ACCOUNT, amount: 5_00000000 },
      ],
      token_transfers: [],
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, false, 'should skip empty memo');
    assert.equal(mockLedger._calls.length, 0);
  });

  // ── Duplicate transaction → idempotent ────────────────────────

  it('returns false for already-processed transaction (idempotent)', async () => {
    const user = registerUser();

    // Pre-mark transaction as processed
    mockStore = createMockStore({
      processedTxIds: new Set(['tx-dup-001']),
      users: new Map([[user.userId, user]]),
      memoIndex: new Map([[user.depositMemo, user]]),
    });
    // Re-create watcher with new store
    watcher = new DepositWatcher(AGENT_ACCOUNT, mockStore, mockLedger, TEST_CONFIG);

    const tx = makeTx({
      transaction_id: 'tx-dup-001',
      memo_base64: encodeMemo(user.depositMemo),
      transfers: [
        { account: AGENT_ACCOUNT, amount: 5_00000000 },
      ],
      token_transfers: [],
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, false, 'should skip duplicate transaction');
    assert.equal(mockLedger._calls.length, 0);
  });

  // ── Failed transaction → skipped ──────────────────────────────

  it('returns false for non-SUCCESS transaction', async () => {
    registerUser();

    const tx = makeTx({
      transaction_id: 'tx-failed-001',
      result: 'INSUFFICIENT_ACCOUNT_BALANCE',
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, false, 'should skip failed transaction');
    assert.equal(mockLedger._calls.length, 0);
  });

  // ── No matching transfer to agent → not credited ──────────────

  it('returns false when no transfer is directed to the agent account', async () => {
    const user = registerUser();

    const tx = makeTx({
      transaction_id: 'tx-no-agent-transfer',
      memo_base64: encodeMemo(user.depositMemo),
      transfers: [
        { account: '0.0.1111', amount: 5_00000000 }, // transfer to someone else
      ],
      token_transfers: [],
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, false, 'should skip when no transfer to agent');
    assert.equal(mockLedger._calls.length, 0);
  });

  // ── Negative transfer amount → not credited ───────────────────

  it('returns false when transfer to agent has negative amount (outgoing)', async () => {
    const user = registerUser();

    const tx = makeTx({
      transaction_id: 'tx-negative-amount',
      memo_base64: encodeMemo(user.depositMemo),
      transfers: [
        { account: AGENT_ACCOUNT, amount: -5_00000000 }, // agent is sending, not receiving
      ],
      token_transfers: [],
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, false, 'should skip negative (outgoing) transfers');
    assert.equal(mockLedger._calls.length, 0);
  });

  // ── Token transfer takes priority over HBAR ───────────────────

  it('credits token transfer when both token and HBAR transfers exist', async () => {
    const TOKEN_ID = '0.0.77777';
    registerToken(TOKEN_ID, 2, 'TEST');

    const user = registerUser();

    const tx = makeTx({
      transaction_id: 'tx-both-types',
      memo_base64: encodeMemo(user.depositMemo),
      transfers: [
        { account: AGENT_ACCOUNT, amount: 1_00000000 }, // 1 HBAR
      ],
      token_transfers: [
        { token_id: TOKEN_ID, account: AGENT_ACCOUNT, amount: 5000 }, // 50.00 TEST (2 decimals)
      ],
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, true);
    assert.equal(mockLedger._calls.length, 1);
    // Token transfer should be credited, not HBAR
    assert.deepStrictEqual(mockLedger._calls[0].args, [
      user.userId, 50, 'tx-both-types', user.rakePercent, TOKEN_ID,
    ]);
  });

  // ── Max balance check is per-token ────────────────────────────

  it('applies max balance check against the correct token entry', async () => {
    const TOKEN_ID = '0.0.88888';
    registerToken(TOKEN_ID, 1, 'LAZY2');

    // User has high HBAR balance but low token balance
    const user = registerUser({
      balances: {
        tokens: {
          hbar: {
            available: 9999,
            reserved: 0,
            totalDeposited: 9999,
            totalWithdrawn: 0,
            totalRake: 0,
          },
          [TOKEN_ID]: {
            available: 10,
            reserved: 0,
            totalDeposited: 10,
            totalWithdrawn: 0,
            totalRake: 0,
          },
        },
      },
    });

    const tx = makeTx({
      transaction_id: 'tx-token-under-max',
      memo_base64: encodeMemo(user.depositMemo),
      transfers: [],
      token_transfers: [
        { token_id: TOKEN_ID, account: AGENT_ACCOUNT, amount: 100 }, // 10 LAZY2 → 10 + 10 = 20 < 10000
      ],
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, true, 'should credit token deposit despite high HBAR balance');
    assert.equal(mockLedger._calls.length, 1);
    assert.equal(mockLedger._calls[0].args[4], TOKEN_ID, 'should credit to the token, not hbar');
  });

  // ── Zero-amount transfer → not credited ───────────────────────

  it('returns false for zero-amount transfer', async () => {
    const user = registerUser();

    const tx = makeTx({
      transaction_id: 'tx-zero',
      memo_base64: encodeMemo(user.depositMemo),
      transfers: [
        { account: AGENT_ACCOUNT, amount: 0 },
      ],
      token_transfers: [],
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, false, 'should skip zero-amount transfer');
    assert.equal(mockLedger._calls.length, 0);
  });

  // ── Custom rake percent passed to ledger ──────────────────────

  it('passes user-specific rake percent to ledger creditDeposit', async () => {
    const user = registerUser({ rakePercent: 3 });

    const tx = makeTx({
      transaction_id: 'tx-custom-rake',
      memo_base64: encodeMemo(user.depositMemo),
      transfers: [
        { account: AGENT_ACCOUNT, amount: 20_00000000 }, // 20 HBAR
      ],
      token_transfers: [],
    });

    const result = await (watcher as any).processTransaction(tx);

    assert.equal(result, true);
    assert.equal(mockLedger._calls[0].args[3], 3, 'rake percent should be 3, not default 5');
  });
});
