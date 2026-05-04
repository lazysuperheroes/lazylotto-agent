import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { UserLedger } from './UserLedger.js';
import type { PersistentStore } from './PersistentStore.js';
import type { AccountingService } from './AccountingService.js';
import type { UserAccount, UserBalances, OperatorState, DepositRecord } from './types.js';
import {
  emptyBalances,
  emptyOperatorState,
  InsufficientBalanceError,
  UserInactiveError,
  UserNotFoundError,
} from './types.js';
import { registerToken, roundForToken } from '../utils/math.js';

// Register a test LAZY token with 1 decimal place for rounding tests
registerToken('test-lazy', 1, 'LAZY');

// -- Mock helpers -----------------------------------------------------------

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

interface MockStoreData {
  users: Map<string, UserAccount>;
  operator: OperatorState;
  processedTxIds: Set<string>;
  deposits: DepositRecord[];
}

function createMockStore(initial?: Partial<MockStoreData>): PersistentStore {
  const users: Map<string, UserAccount> = initial?.users ?? new Map();
  let operator: OperatorState = initial?.operator ?? emptyOperatorState();
  const processedTxIds: Set<string> = initial?.processedTxIds ?? new Set();
  const deposits: DepositRecord[] = initial?.deposits ?? [];

  return {
    getUser(userId: string): UserAccount | undefined {
      return users.get(userId);
    },
    saveUser(user: UserAccount): void {
      users.set(user.userId, user);
    },
    updateBalance(userId: string, updater: (b: UserBalances) => UserBalances): UserBalances {
      const user = users.get(userId);
      if (!user) throw new UserNotFoundError(userId);
      user.balances = updater(user.balances);
      return user.balances;
    },
    updateOperator(updater: (s: OperatorState) => OperatorState): OperatorState {
      operator = updater(operator);
      return operator;
    },
    isTransactionProcessed(txId: string): boolean {
      return processedTxIds.has(txId);
    },
    async tryClaimTransaction(txId: string): Promise<boolean> {
      if (processedTxIds.has(txId)) return false;
      processedTxIds.add(txId);
      return true;
    },
    async releaseTransactionClaim(txId: string): Promise<void> {
      processedTxIds.delete(txId);
    },
    recordDeposit(record: DepositRecord): void {
      processedTxIds.add(record.transactionId);
      deposits.push(record);
    },
    getOperator(): OperatorState {
      return operator;
    },
    async flush(): Promise<void> {
      // no-op in mock
    },
  } as unknown as PersistentStore;
}

interface AccountingCall {
  method: string;
  args: unknown[];
}

function createMockAccounting(): AccountingService & { calls: AccountingCall[] } {
  const calls: AccountingCall[] = [];
  return {
    calls,
    async recordDeposit(...args: unknown[]): Promise<void> {
      calls.push({ method: 'recordDeposit', args });
    },
    async recordRake(...args: unknown[]): Promise<void> {
      calls.push({ method: 'recordRake', args });
    },
    async recordWithdrawal(...args: unknown[]): Promise<void> {
      calls.push({ method: 'recordWithdrawal', args });
    },
  } as unknown as AccountingService & { calls: AccountingCall[] };
}

// -- Tests ------------------------------------------------------------------

describe('UserLedger', () => {
  const AGENT_ACCOUNT = '0.0.9999';
  let store: PersistentStore;
  let accounting: ReturnType<typeof createMockAccounting>;
  let ledger: UserLedger;

  beforeEach(() => {
    const user = makeUser({
      balances: { tokens: { hbar: { available: 100, reserved: 0, totalDeposited: 0, totalWithdrawn: 0, totalRake: 0 } } },
    });
    const users = new Map<string, UserAccount>();
    users.set(user.userId, user);

    store = createMockStore({ users });
    accounting = createMockAccounting();
    ledger = new UserLedger(store, accounting, AGENT_ACCOUNT);
  });

  // -- creditDeposit ----------------------------------------------------------

  it('creditDeposit deducts rake and credits net amount', async () => {
    const balances = await ledger.creditDeposit('user-1', 100, 'tx-001', 1, 'hbar');
    // 1% rake on 100 = 1, net = 99
    assert.equal(balances.tokens.hbar.available, 100 + 99); // prior 100 + net 99
    assert.equal(balances.tokens.hbar.totalDeposited, 100);
    assert.equal(balances.tokens.hbar.totalRake, 1);
  });

  it('creditDeposit credits operator platform balance', async () => {
    await ledger.creditDeposit('user-1', 200, 'tx-002', 2, 'hbar');
    // 2% rake on 200 = 4
    const op = store.getOperator();
    assert.equal(op.balances.hbar, 4);
    assert.equal(op.totalRakeCollected.hbar, 4);
  });

  it('creditDeposit is idempotent (duplicate txId ignored)', async () => {
    const first = await ledger.creditDeposit('user-1', 100, 'tx-dup', 1, 'hbar');
    const second = await ledger.creditDeposit('user-1', 100, 'tx-dup', 1, 'hbar');

    // Balances should be identical -- second call is a no-op.
    assert.deepStrictEqual(first, second);
    assert.equal(first.tokens.hbar.available, 100 + 99);
  });

  // ── Race regression: duplicate-deposit incident ────────────────
  // The pre-fix idempotency check was an in-process Set lookup on the
  // RedisStore, so two warm Lambdas could each see "not processed" for
  // the same on-chain tx and both credit + write HCS-20 ops. The fix
  // routes through `tryClaimTransaction` (atomic SADD on Redis,
  // claim-on-first-call on the in-process store). These tests lock the
  // single-call-wins property so we cannot regress.

  it('creditDeposit: concurrent calls for the same txId credit exactly once', async () => {
    // Fire 5 concurrent credits for the same txId. With the atomic
    // claim, exactly one should win and update balances; the rest
    // should short-circuit and return the already-credited balance.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ledger.creditDeposit('user-1', 100, 'tx-race', 1, 'hbar'),
      ),
    );

    // All five calls must agree on the final balance.
    for (const r of results) {
      assert.deepStrictEqual(r, results[0]);
    }

    // Balance reflects ONE credit (initial 100 + net 99), not five.
    assert.equal(results[0].tokens.hbar.available, 199);
    assert.equal(results[0].tokens.hbar.totalDeposited, 100);
    assert.equal(results[0].tokens.hbar.totalRake, 1);

    // Operator collected ONE rake (1, not 5).
    const op = store.getOperator();
    assert.equal(op.balances.hbar, 1);
    assert.equal(op.totalRakeCollected.hbar, 1);

    // Accounting fired exactly once for deposit and once for rake.
    const depositCalls = accounting.calls.filter((c) => c.method === 'recordDeposit');
    const rakeCalls = accounting.calls.filter((c) => c.method === 'recordRake');
    assert.equal(depositCalls.length, 1, 'HCS-20 recordDeposit fires once for the winning claim');
    assert.equal(rakeCalls.length, 1, 'HCS-20 recordRake fires once for the winning claim');
  });

  it('creditDeposit: failure before recordDeposit releases the claim so retry can succeed', async () => {
    // Construct a store whose updateBalance throws on first call only —
    // this simulates a transient failure between the atomic claim and
    // the deposit-record write. The catch path should release the claim
    // so the next attempt can proceed.
    const users = new Map<string, UserAccount>();
    const user = makeUser({
      balances: { tokens: { hbar: { available: 100, reserved: 0, totalDeposited: 0, totalWithdrawn: 0, totalRake: 0 } } },
    });
    users.set(user.userId, user);

    let updateBalanceCalls = 0;
    const failingStore = createMockStore({ users });
    const realUpdate = failingStore.updateBalance.bind(failingStore);
    failingStore.updateBalance = (userId, updater) => {
      updateBalanceCalls++;
      if (updateBalanceCalls === 1) throw new Error('transient updateBalance failure');
      return realUpdate(userId, updater);
    };

    const failingAccounting = createMockAccounting();
    const failingLedger = new UserLedger(failingStore, failingAccounting, AGENT_ACCOUNT);

    // First attempt throws — claim should be released.
    await assert.rejects(
      () => failingLedger.creditDeposit('user-1', 100, 'tx-retry', 1, 'hbar'),
      /transient updateBalance failure/,
    );
    assert.equal(failingStore.isTransactionProcessed('tx-retry'), false, 'claim released after pre-record failure');

    // Retry now succeeds.
    const balances = await failingLedger.creditDeposit('user-1', 100, 'tx-retry', 1, 'hbar');
    assert.equal(balances.tokens.hbar.available, 199);
    assert.equal(failingStore.isTransactionProcessed('tx-retry'), true);
  });

  it('creditDeposit: claim is NOT released when failure happens after recordDeposit', async () => {
    // If the deposit row is already written, releasing the claim would
    // expose us to a double-credit on retry. Confirm the claim stays.
    const users = new Map<string, UserAccount>();
    const user = makeUser({
      balances: { tokens: { hbar: { available: 100, reserved: 0, totalDeposited: 0, totalWithdrawn: 0, totalRake: 0 } } },
    });
    users.set(user.userId, user);

    const failingStore = createMockStore({ users });
    failingStore.flush = async () => {
      throw new Error('flush failed after recordDeposit');
    };

    const failingAccounting = createMockAccounting();
    const failingLedger = new UserLedger(failingStore, failingAccounting, AGENT_ACCOUNT);

    await assert.rejects(
      () => failingLedger.creditDeposit('user-1', 100, 'tx-no-rollback', 1, 'hbar'),
      /flush failed/,
    );

    // Claim STAYS — partial state is the lesser evil.
    assert.equal(failingStore.isTransactionProcessed('tx-no-rollback'), true);
  });

  // -- reserve ----------------------------------------------------------------

  it('reserve moves available to reserved', () => {
    const balances = ledger.reserve('user-1', 30, 'hbar');
    assert.equal(balances.tokens.hbar.available, 70);
    assert.equal(balances.tokens.hbar.reserved, 30);
  });

  it('reserve throws InsufficientBalanceError when underfunded', () => {
    assert.throws(
      () => ledger.reserve('user-1', 200, 'hbar'),
      (err: unknown) => err instanceof InsufficientBalanceError,
    );
  });

  it('reserve throws UserInactiveError for deregistered user', () => {
    // Deactivate via the ledger itself
    ledger.deregisterUser('user-1');

    assert.throws(
      () => ledger.reserve('user-1', 10, 'hbar'),
      (err: unknown) => err instanceof UserInactiveError,
    );
  });

  // -- settleSpend ------------------------------------------------------------

  it('settleSpend deducts from reserved', () => {
    ledger.reserve('user-1', 50, 'hbar');
    const balances = ledger.settleSpend('user-1', 30, 'hbar');
    assert.equal(balances.tokens.hbar.reserved, 20);
    assert.equal(balances.tokens.hbar.available, 50); // unchanged from after reserve
  });

  // -- releaseReserve ---------------------------------------------------------

  it('releaseReserve moves reserved back to available', () => {
    ledger.reserve('user-1', 40, 'hbar');
    const balances = ledger.releaseReserve('user-1', 40, 'hbar');
    assert.equal(balances.tokens.hbar.available, 100); // fully restored
    assert.equal(balances.tokens.hbar.reserved, 0);
  });

  // -- Full cycle -------------------------------------------------------------

  it('full cycle: deposit -> reserve -> settle -> release unused', async () => {
    // Deposit 100 LAZY at 1% rake => net 99
    await ledger.creditDeposit('user-1', 100, 'tx-cycle', 1, 'hbar');
    // available is now 199 (100 initial + 99 net deposit)

    // Reserve 80
    ledger.reserve('user-1', 80, 'hbar');
    let bal = ledger.getBalance('user-1');
    assert.equal(bal.tokens.hbar.available, 119);
    assert.equal(bal.tokens.hbar.reserved, 80);

    // Settle 50 (actually spent)
    ledger.settleSpend('user-1', 50, 'hbar');
    bal = ledger.getBalance('user-1');
    assert.equal(bal.tokens.hbar.reserved, 30);

    // Release remaining 30 reservation
    ledger.releaseReserve('user-1', 30, 'hbar');
    bal = ledger.getBalance('user-1');
    assert.equal(bal.tokens.hbar.available, 149);
    assert.equal(bal.tokens.hbar.reserved, 0);
  });

  // -- canAfford --------------------------------------------------------------

  it('canAfford returns correct boolean', () => {
    assert.equal(ledger.canAfford('user-1', 100, 'hbar'), true);
    assert.equal(ledger.canAfford('user-1', 101, 'hbar'), false);
    assert.equal(ledger.canAfford('user-1', 0, 'hbar'), true);
    // Non-existent user
    assert.equal(ledger.canAfford('no-such-user', 1, 'hbar'), false);
  });
});

// -- Rake rounding with LAZY (1 decimal) ------------------------------------

describe('Rake rounding with LAZY (1 decimal)', () => {
  const AGENT_ACCOUNT = '0.0.9999';
  const TOKEN = 'test-lazy'; // registered above with 1 decimal
  let store: PersistentStore;
  let accounting: ReturnType<typeof createMockAccounting>;
  let ledger: UserLedger;

  function freshStore(initialAvailable = 0): PersistentStore {
    const user = makeUser({
      rakePercent: 5,
      balances: {
        tokens: {
          [TOKEN]: { available: initialAvailable, reserved: 0, totalDeposited: 0, totalWithdrawn: 0, totalRake: 0 },
        },
      },
    });
    const users = new Map<string, UserAccount>();
    users.set(user.userId, user);
    return createMockStore({ users });
  }

  beforeEach(() => {
    store = freshStore(0);
    accounting = createMockAccounting();
    ledger = new UserLedger(store, accounting, AGENT_ACCOUNT);
  });

  // 1. Clean division: 5% of 100 LAZY
  it('5% rake on 100 LAZY: 5.0 rake, 95.0 net (clean division)', async () => {
    const balances = await ledger.creditDeposit('user-1', 100, 'tx-lazy-1', 5, TOKEN);
    const entry = balances.tokens[TOKEN];
    assert.equal(entry.available, 95.0);
    assert.equal(entry.totalDeposited, 100);
    assert.equal(entry.totalRake, 5.0);

    const op = store.getOperator();
    assert.equal(op.balances[TOKEN], 5.0);
  });

  // 2. Rounding up: 5% of 3 LAZY = 0.15 -> rounds to 0.2
  it('5% rake on 3 LAZY: 0.2 rake (rounds from 0.15), 2.8 net', async () => {
    const balances = await ledger.creditDeposit('user-1', 3, 'tx-lazy-2', 5, TOKEN);
    const entry = balances.tokens[TOKEN];

    const expectedRake = roundForToken(3 * 0.05, TOKEN); // 0.15 -> 0.2
    const expectedNet = roundForToken(3 - expectedRake, TOKEN); // 2.8

    assert.equal(expectedRake, 0.2, 'rake should round 0.15 to 0.2');
    assert.equal(expectedNet, 2.8, 'net should be 2.8');

    assert.equal(entry.totalRake, 0.2);
    assert.equal(entry.available, 2.8);
  });

  // 3. Tiny amount: 1% of 1 LAZY = 0.01 -> rounds to 0.0
  it('1% rake on 1 LAZY: 0.0 rake (rounds from 0.01), 1.0 net -- operator gets nothing', async () => {
    const balances = await ledger.creditDeposit('user-1', 1, 'tx-lazy-3', 1, TOKEN);
    const entry = balances.tokens[TOKEN];

    assert.equal(entry.totalRake, 0.0, 'rake rounds down to zero on small amounts');
    assert.equal(entry.available, 1.0, 'user gets the full amount when rake rounds to zero');

    const op = store.getOperator();
    assert.equal(op.balances[TOKEN] ?? 0, 0, 'operator gets nothing');
  });

  // 4. Invariant: rakeAmount + netAmount <= grossAmount (rounding cannot create tokens)
  it('rakeAmount + netAmount <= grossAmount for various amounts', async () => {
    const testCases = [
      { gross: 100, rake: 5 },
      { gross: 3, rake: 5 },
      { gross: 1, rake: 1 },
      { gross: 0.1, rake: 5 },
      { gross: 7, rake: 3 },
      { gross: 0.3, rake: 10 },
      { gross: 999.9, rake: 5 },
    ];

    for (const { gross, rake } of testCases) {
      const rakeAmount = roundForToken(gross * (rake / 100), TOKEN);
      const netAmount = roundForToken(gross - rakeAmount, TOKEN);

      assert.ok(
        rakeAmount + netAmount <= gross,
        `Invariant violated: rake=${rakeAmount} + net=${netAmount} = ${rakeAmount + netAmount} > gross=${gross} (rake%=${rake})`,
      );

      // Also verify neither component is negative
      assert.ok(rakeAmount >= 0, `Negative rake for gross=${gross}, rake%=${rake}`);
      assert.ok(netAmount >= 0, `Negative net for gross=${gross}, rake%=${rake}`);
    }
  });

  // 5. Zero rake (0%): full amount credited, operator gets nothing
  it('0% rake: full amount credited, operator gets nothing', async () => {
    const balances = await ledger.creditDeposit('user-1', 50, 'tx-lazy-zero', 0, TOKEN);
    const entry = balances.tokens[TOKEN];

    assert.equal(entry.available, 50.0, 'user gets the full amount');
    assert.equal(entry.totalDeposited, 50);
    assert.equal(entry.totalRake, 0);

    const op = store.getOperator();
    assert.equal(op.balances[TOKEN] ?? 0, 0, 'operator collects nothing');
  });

  // 6. Edge case: grossAmount = 0.1 LAZY with 5% rake
  it('0.1 LAZY with 5% rake: 0.0 rake (rounds from 0.005), 0.1 net', async () => {
    const balances = await ledger.creditDeposit('user-1', 0.1, 'tx-lazy-tiny', 5, TOKEN);
    const entry = balances.tokens[TOKEN];

    // 5% of 0.1 = 0.005, roundToDecimals(0.005, 1) = Math.round(0.05)/10 = 0/10 = 0.0
    assert.equal(entry.totalRake, 0.0, 'rake rounds to zero for sub-minimum amounts');
    assert.equal(entry.available, 0.1, 'user gets full 0.1 when rake rounds to zero');

    const op = store.getOperator();
    assert.equal(op.balances[TOKEN] ?? 0, 0, 'operator gets nothing on sub-minimum rake');
  });
});

describe('Negative amount guards', () => {
  let store: ReturnType<typeof createMockStore>;
  let ledger: UserLedger;

  beforeEach(() => {
    store = createMockStore();
    const user = makeUser();
    user.balances.tokens['hbar'] = { available: 100, reserved: 20, totalDeposited: 120, totalWithdrawn: 0, totalRake: 0 };
    store.saveUser(user);
    ledger = new UserLedger(store as unknown as PersistentStore, createMockAccounting() as unknown as AccountingService, '0.0.agent');
  });

  it('reserve throws on negative amount', () => {
    assert.throws(
      () => ledger.reserve('user-1', -5, 'hbar'),
      { message: /non-negative/ },
    );
  });

  it('settleSpend throws on negative amount', () => {
    assert.throws(
      () => ledger.settleSpend('user-1', -10, 'hbar'),
      { message: /non-negative/ },
    );
  });

  it('releaseReserve throws on negative amount', () => {
    assert.throws(
      () => ledger.releaseReserve('user-1', -1, 'hbar'),
      { message: /non-negative/ },
    );
  });

  it('reserve allows zero amount (no-op)', () => {
    const before = store.getUser('user-1')!.balances.tokens['hbar'];
    ledger.reserve('user-1', 0, 'hbar');
    const after = store.getUser('user-1')!.balances.tokens['hbar'];
    assert.equal(after.available, before.available);
    assert.equal(after.reserved, before.reserved);
  });
});
