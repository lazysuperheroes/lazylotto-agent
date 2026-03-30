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

  // -- processWithdrawal ------------------------------------------------------

  it('processWithdrawal deducts from available', async () => {
    const balances = await ledger.processWithdrawal('user-1', 60, 'hbar');
    assert.equal(balances.tokens.hbar.available, 40);
    assert.equal(balances.tokens.hbar.totalWithdrawn, 60);
  });

  it('processWithdrawal throws InsufficientBalanceError', async () => {
    await assert.rejects(
      () => ledger.processWithdrawal('user-1', 999, 'hbar'),
      (err: unknown) => err instanceof InsufficientBalanceError,
    );
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
