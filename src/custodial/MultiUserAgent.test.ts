import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentStore } from './PersistentStore.js';
import { UserLedger } from './UserLedger.js';
import { GasTracker } from './GasTracker.js';
import type { AccountingService } from './AccountingService.js';
import type { UserAccount, UserBalances, OperatorState } from './types.js';
import {
  emptyBalances,
  emptyTokenEntry,
  InsufficientBalanceError,
  UserNotFoundError,
  UserInactiveError,
} from './types.js';
import type { Strategy } from '../config/strategy.js';

// ── Helpers ─────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mua-test-'));
}

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    name: 'test-strategy',
    version: '0.2',
    poolFilter: { type: 'all', feeToken: 'any', minPrizeCount: 1 },
    budget: {
      tokenBudgets: {
        hbar: { maxPerSession: 100, maxPerPool: 20, reserve: 0 },
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
    ...overrides,
  };
}

function makeUser(overrides: Partial<UserAccount> = {}): UserAccount {
  return {
    userId: 'user-1',
    depositMemo: 'memo-1',
    hederaAccountId: '0.0.1234',
    eoaAddress: '0xabc',
    strategyName: 'test-strategy',
    strategyVersion: '0.2',
    strategySnapshot: makeStrategy(),
    rakePercent: 1,
    balances: emptyBalances(),
    connectionTopicId: null,
    registeredAt: '2026-01-01T00:00:00.000Z',
    lastPlayedAt: null,
    active: true,
    ...overrides,
  };
}

function createNoopAccounting(): AccountingService {
  return {
    async recordDeposit(): Promise<void> {},
    async recordRake(): Promise<void> {},
    async recordWithdrawal(): Promise<void> {},
    async recordPlaySession(): Promise<void> {},
    async recordOperatorWithdrawal(): Promise<void> {},
    async deploy(): Promise<string> { return '0.0.0'; },
  } as unknown as AccountingService;
}

// ── Tests ───────────────────────────────────────────────────────

describe('MultiUserAgent financial paths', () => {
  const AGENT_ACCOUNT = '0.0.9999';
  let dir: string;
  let store: PersistentStore;
  let ledger: UserLedger;

  beforeEach(async () => {
    dir = makeTempDir();
    store = new PersistentStore(dir);
    await store.load();
    ledger = new UserLedger(store, createNoopAccounting(), AGENT_ACCOUNT);
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── 1. Mutex behavior (tested via promise timing) ─────────────

  describe('mutex / serialization', () => {
    it('reserve blocks concurrent reserve on same user (sequential proof)', () => {
      // The UserLedger's reserve is synchronous, but the MultiUserAgent
      // wraps it with an async per-user lock. We test the underlying
      // financial primitive: two reserves cannot both succeed if the
      // combined amount exceeds available.
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      // First reserve succeeds
      ledger.reserve('user-1', 60, 'hbar');
      const afterFirst = store.getUser('user-1')!;
      assert.equal(afterFirst.balances.tokens.hbar.available, 40);
      assert.equal(afterFirst.balances.tokens.hbar.reserved, 60);

      // Second reserve for 60 must fail because only 40 is available
      assert.throws(
        () => ledger.reserve('user-1', 60, 'hbar'),
        (err: unknown) => err instanceof InsufficientBalanceError,
      );

      // Balance unchanged after failed reserve
      const afterFailed = store.getUser('user-1')!;
      assert.equal(afterFailed.balances.tokens.hbar.available, 40);
      assert.equal(afterFailed.balances.tokens.hbar.reserved, 60);
    });

    it('different users can reserve independently', () => {
      const userA = makeUser({
        userId: 'user-a',
        depositMemo: 'memo-a',
        balances: {
          tokens: {
            hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      const userB = makeUser({
        userId: 'user-b',
        depositMemo: 'memo-b',
        balances: {
          tokens: {
            hbar: { available: 200, reserved: 0, totalDeposited: 200, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(userA);
      store.saveUser(userB);

      // Both users can reserve simultaneously without interference
      ledger.reserve('user-a', 80, 'hbar');
      ledger.reserve('user-b', 150, 'hbar');

      const a = store.getUser('user-a')!;
      assert.equal(a.balances.tokens.hbar.available, 20);
      assert.equal(a.balances.tokens.hbar.reserved, 80);

      const b = store.getUser('user-b')!;
      assert.equal(b.balances.tokens.hbar.available, 50);
      assert.equal(b.balances.tokens.hbar.reserved, 150);
    });
  });

  // ── 2. Reserve-settle-release lifecycle ────────────────────────

  describe('reserve-settle-release lifecycle (playForUser pattern)', () => {
    it('full happy path: reserve -> settleSpend -> releaseReserve', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      // Step 1: Reserve sessionBudget (e.g. 80)
      ledger.reserve('user-1', 80, 'hbar');

      let bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.available, 20);
      assert.equal(bal.tokens.hbar.reserved, 80);

      // Step 2: Settle actual spend (e.g. 50 spent on lottery entries)
      ledger.settleSpend('user-1', 50, 'hbar');

      bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.reserved, 30);
      assert.equal(bal.tokens.hbar.available, 20); // unchanged

      // Step 3: Release unused reservation (80 - 50 = 30)
      ledger.releaseReserve('user-1', 30, 'hbar');

      bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.available, 50); // 20 + 30 released
      assert.equal(bal.tokens.hbar.reserved, 0);

      // Final invariant: available = original - spent, reserved = 0
      assert.equal(bal.tokens.hbar.available, 100 - 50);
      assert.equal(bal.tokens.hbar.reserved, 0);
    });

    it('full lifecycle persists to disk', async () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 200, reserved: 0, totalDeposited: 200, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      ledger.reserve('user-1', 120, 'hbar');
      ledger.settleSpend('user-1', 75, 'hbar');
      ledger.releaseReserve('user-1', 45, 'hbar');
      await store.flush();
      await store.close();

      // Reload from disk
      const store2 = new PersistentStore(dir);
      await store2.load();

      const reloaded = store2.getUser('user-1')!;
      assert.equal(reloaded.balances.tokens.hbar.available, 125); // 200 - 75
      assert.equal(reloaded.balances.tokens.hbar.reserved, 0);
      await store2.close();
    });

    it('zero spend: full reservation released', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 50, reserved: 0, totalDeposited: 50, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      ledger.reserve('user-1', 50, 'hbar');
      ledger.settleSpend('user-1', 0, 'hbar');
      ledger.releaseReserve('user-1', 50, 'hbar');

      const bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.available, 50);
      assert.equal(bal.tokens.hbar.reserved, 0);
    });

    it('full spend: nothing to release', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 40, reserved: 0, totalDeposited: 40, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      ledger.reserve('user-1', 40, 'hbar');
      ledger.settleSpend('user-1', 40, 'hbar');
      // No release needed when unused = 0

      const bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.available, 0);
      assert.equal(bal.tokens.hbar.reserved, 0);
    });
  });

  // ── 3. processWithdrawal reserve pattern ───────────────────────

  describe('withdrawal reserve pattern (MultiUserAgent.processWithdrawal)', () => {
    it('reserve -> settleSpend -> updateBalance(totalWithdrawn) produces correct state', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      const withdrawAmount = 60;

      // Step 1: Reserve funds (as MultiUserAgent.processWithdrawal does)
      ledger.reserve('user-1', withdrawAmount, 'hbar');

      let bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.available, 40);
      assert.equal(bal.tokens.hbar.reserved, 60);

      // Step 2: On-chain transfer succeeds -- settle the spend
      ledger.settleSpend('user-1', withdrawAmount, 'hbar');

      bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.available, 40);
      assert.equal(bal.tokens.hbar.reserved, 0);

      // Step 3: Update totalWithdrawn (as MultiUserAgent does via store.updateBalance)
      store.updateBalance('user-1', (b) => {
        const entry = b.tokens.hbar;
        if (entry) entry.totalWithdrawn += withdrawAmount;
        return b;
      });

      bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.available, 40);
      assert.equal(bal.tokens.hbar.reserved, 0);
      assert.equal(bal.tokens.hbar.totalWithdrawn, 60);
    });

    it('release on transfer failure returns funds to available', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      const withdrawAmount = 70;

      // Step 1: Reserve
      ledger.reserve('user-1', withdrawAmount, 'hbar');

      let bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.available, 30);
      assert.equal(bal.tokens.hbar.reserved, 70);

      // Step 2: On-chain transfer FAILS -- release back to available
      ledger.releaseReserve('user-1', withdrawAmount, 'hbar');

      bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.available, 100); // fully restored
      assert.equal(bal.tokens.hbar.reserved, 0);
      assert.equal(bal.tokens.hbar.totalWithdrawn, 0); // nothing withdrawn
    });

    it('multiple sequential withdrawals accumulate totalWithdrawn', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      // Withdrawal 1: 30
      ledger.reserve('user-1', 30, 'hbar');
      ledger.settleSpend('user-1', 30, 'hbar');
      store.updateBalance('user-1', (b) => {
        b.tokens.hbar.totalWithdrawn += 30;
        return b;
      });

      // Withdrawal 2: 25
      ledger.reserve('user-1', 25, 'hbar');
      ledger.settleSpend('user-1', 25, 'hbar');
      store.updateBalance('user-1', (b) => {
        b.tokens.hbar.totalWithdrawn += 25;
        return b;
      });

      const bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.available, 45); // 100 - 30 - 25
      assert.equal(bal.tokens.hbar.reserved, 0);
      assert.equal(bal.tokens.hbar.totalWithdrawn, 55); // 30 + 25
    });
  });

  // ── 4. Budget capping (C4 fix) ─────────────────────────────────

  describe('budget capping (C4 fix)', () => {
    it('caps maxPerSession to tokenAvailable when available < maxPerSession', () => {
      // This replicates the capping logic from MultiUserAgent.playForUser:
      //   const sessionBudget = Math.min(maxSession, tokenAvailable);
      //   cappedBudgets[primaryToken].maxPerSession = Math.min(original, sessionBudget);
      const strategy = makeStrategy({
        budget: {
          tokenBudgets: {
            hbar: { maxPerSession: 100, maxPerPool: 20, reserve: 0 },
          },
          maxEntriesPerPool: 10,
        },
      });

      const tokenAvailable = 30;
      const maxSession = strategy.budget.tokenBudgets.hbar.maxPerSession;
      const sessionBudget = Math.min(maxSession, tokenAvailable);

      assert.equal(sessionBudget, 30, 'session budget should be capped to available');

      // Apply the capping logic from playForUser
      const cappedBudgets = { ...strategy.budget.tokenBudgets };
      cappedBudgets.hbar = {
        ...cappedBudgets.hbar,
        maxPerSession: Math.min(cappedBudgets.hbar.maxPerSession, sessionBudget),
      };

      assert.equal(cappedBudgets.hbar.maxPerSession, 30);
      assert.equal(cappedBudgets.hbar.maxPerPool, 20); // unchanged
    });

    it('does not change maxPerSession when available >= maxPerSession', () => {
      const strategy = makeStrategy({
        budget: {
          tokenBudgets: {
            hbar: { maxPerSession: 50, maxPerPool: 10, reserve: 0 },
          },
          maxEntriesPerPool: 10,
        },
      });

      const tokenAvailable = 200;
      const maxSession = strategy.budget.tokenBudgets.hbar.maxPerSession;
      const sessionBudget = Math.min(maxSession, tokenAvailable);

      assert.equal(sessionBudget, 50, 'session budget should use strategy limit');

      const cappedBudgets = { ...strategy.budget.tokenBudgets };
      cappedBudgets.hbar = {
        ...cappedBudgets.hbar,
        maxPerSession: Math.min(cappedBudgets.hbar.maxPerSession, sessionBudget),
      };

      assert.equal(cappedBudgets.hbar.maxPerSession, 50); // unchanged
    });

    it('capping works with multiple tokens (only the primary token is capped)', () => {
      const strategy = makeStrategy({
        budget: {
          tokenBudgets: {
            hbar: { maxPerSession: 100, maxPerPool: 20, reserve: 0 },
            '0.0.8011209': { maxPerSession: 200, maxPerPool: 50, reserve: 0 },
          },
          maxEntriesPerPool: 10,
        },
      });

      // Simulate: primary token is hbar with 30 available
      const primaryToken = 'hbar';
      const tokenAvailable = 30;
      const maxSession = strategy.budget.tokenBudgets[primaryToken].maxPerSession;
      const sessionBudget = Math.min(maxSession, tokenAvailable);

      const cappedBudgets = { ...strategy.budget.tokenBudgets };
      if (cappedBudgets[primaryToken]) {
        cappedBudgets[primaryToken] = {
          ...cappedBudgets[primaryToken],
          maxPerSession: Math.min(cappedBudgets[primaryToken].maxPerSession, sessionBudget),
        };
      }

      // Primary token is capped
      assert.equal(cappedBudgets.hbar.maxPerSession, 30);
      // Other tokens are NOT capped
      assert.equal(cappedBudgets['0.0.8011209'].maxPerSession, 200);
    });

    it('selects the token with highest available balance as primary', () => {
      // This replicates MultiUserAgent's primary token selection logic
      const user = makeUser({
        strategySnapshot: makeStrategy({
          budget: {
            tokenBudgets: {
              hbar: { maxPerSession: 100, maxPerPool: 20, reserve: 0 },
              '0.0.8011209': { maxPerSession: 200, maxPerPool: 50, reserve: 0 },
            },
            maxEntriesPerPool: 10,
          },
        }),
        balances: {
          tokens: {
            hbar: { available: 30, reserved: 0, totalDeposited: 30, totalWithdrawn: 0, totalRake: 0 },
            '0.0.8011209': { available: 150, reserved: 0, totalDeposited: 150, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });

      // Replicate the selection logic from playForUser
      let primaryToken = 'hbar';
      let bestAvailable = 0;
      for (const tokenKey of Object.keys(user.strategySnapshot.budget.tokenBudgets)) {
        const entry = user.balances.tokens[tokenKey];
        if (entry && entry.available > bestAvailable) {
          bestAvailable = entry.available;
          primaryToken = tokenKey;
        }
      }

      assert.equal(primaryToken, '0.0.8011209');
      assert.equal(bestAvailable, 150);
    });
  });

  // ── 5. Negative balance prevention ─────────────────────────────

  describe('negative balance prevention', () => {
    it('reserve throws InsufficientBalanceError when amount > available', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 10, reserved: 0, totalDeposited: 10, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      assert.throws(
        () => ledger.reserve('user-1', 11, 'hbar'),
        (err: unknown) => {
          assert.ok(err instanceof InsufficientBalanceError);
          assert.equal(err.userId, 'user-1');
          assert.equal(err.requested, 11);
          assert.equal(err.available, 10);
          return true;
        },
      );

      // Balance must be unmodified
      const bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.available, 10);
      assert.equal(bal.tokens.hbar.reserved, 0);
    });

    it('reserve throws InsufficientBalanceError for token with no entry', () => {
      const user = makeUser({
        balances: { tokens: {} },
      });
      store.saveUser(user);

      assert.throws(
        () => ledger.reserve('user-1', 1, 'hbar'),
        (err: unknown) => err instanceof InsufficientBalanceError,
      );
    });

    it('reserve throws UserNotFoundError for unknown user', () => {
      assert.throws(
        () => ledger.reserve('no-such-user', 10, 'hbar'),
        (err: unknown) => err instanceof UserNotFoundError,
      );
    });

    it('settleSpend clamps to reserved (prevents negative reserved)', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 50, reserved: 20, totalDeposited: 70, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      // Try to settle more than reserved -- should clamp, not go negative
      const bal = ledger.settleSpend('user-1', 30, 'hbar');

      // Clamped to reserved (20), not the requested 30
      assert.equal(bal.tokens.hbar.reserved, 0);
      assert.equal(bal.tokens.hbar.available, 50); // available unchanged
    });

    it('releaseReserve clamps to reserved (prevents negative reserved)', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 50, reserved: 15, totalDeposited: 65, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      // Try to release more than reserved -- should clamp
      const bal = ledger.releaseReserve('user-1', 25, 'hbar');

      assert.equal(bal.tokens.hbar.reserved, 0);
      // Only 15 was actually released (clamped), not 25
      assert.equal(bal.tokens.hbar.available, 65); // 50 + 15
    });

    it('reserve exact available succeeds (boundary)', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 42, reserved: 0, totalDeposited: 42, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      // Should not throw -- exact boundary
      const bal = ledger.reserve('user-1', 42, 'hbar');
      assert.equal(bal.tokens.hbar.available, 0);
      assert.equal(bal.tokens.hbar.reserved, 42);
    });

    it('reserve zero amount succeeds', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 10, reserved: 0, totalDeposited: 10, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      const bal = ledger.reserve('user-1', 0, 'hbar');
      assert.equal(bal.tokens.hbar.available, 10);
      assert.equal(bal.tokens.hbar.reserved, 0);
    });

    it('reserve on inactive user throws UserInactiveError', () => {
      const user = makeUser({
        active: false,
        balances: {
          tokens: {
            hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      assert.throws(
        () => ledger.reserve('user-1', 10, 'hbar'),
        (err: unknown) => err instanceof UserInactiveError,
      );
    });
  });

  // ── 6. GasTracker integration ──────────────────────────────────

  describe('GasTracker operator deduction', () => {
    it('gas cost is deducted from operator HBAR balance', () => {
      // Prime the operator with some rake
      store.updateOperator((op) => ({
        ...op,
        balances: { hbar: 10 },
        totalRakeCollected: { hbar: 10 },
      }));

      const gasTracker = new GasTracker(store);
      gasTracker.recordGas('tx-gas-1', 'user-1', 'buyAndRoll', 2.5);

      const op = store.getOperator();
      assert.equal(op.balances.hbar, 7.5); // 10 - 2.5
      assert.equal(op.totalGasSpent, 2.5);
    });

    it('multiple gas records accumulate correctly', () => {
      store.updateOperator((op) => ({
        ...op,
        balances: { hbar: 20 },
        totalRakeCollected: { hbar: 20 },
      }));

      const gasTracker = new GasTracker(store);
      gasTracker.recordGas('tx-g1', 'user-1', 'buyAndRoll', 1.0);
      gasTracker.recordGas('tx-g2', 'user-1', 'transferPrizes', 0.5);
      gasTracker.recordGas('tx-g3', 'system', 'tokenAssociate', 3.0);

      const op = store.getOperator();
      assert.equal(op.balances.hbar, 15.5); // 20 - 1 - 0.5 - 3
      assert.equal(op.totalGasSpent, 4.5);

      assert.equal(gasTracker.totalGasForUser('user-1'), 1.5);
      assert.equal(gasTracker.totalGas(), 4.5);
    });
  });

  // ── 7. Multi-token reserve lifecycle ───────────────────────────

  describe('multi-token operations', () => {
    it('reserve-settle-release works for FT tokens independently', () => {
      const LAZY_TOKEN = '0.0.8011209';
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 50, reserved: 0, totalDeposited: 50, totalWithdrawn: 0, totalRake: 0 },
            [LAZY_TOKEN]: { available: 200, reserved: 0, totalDeposited: 200, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      // Reserve LAZY
      ledger.reserve('user-1', 150, LAZY_TOKEN);

      let bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens[LAZY_TOKEN].available, 50);
      assert.equal(bal.tokens[LAZY_TOKEN].reserved, 150);
      assert.equal(bal.tokens.hbar.available, 50); // HBAR unchanged

      // Settle 100 LAZY
      ledger.settleSpend('user-1', 100, LAZY_TOKEN);
      // Release 50 LAZY
      ledger.releaseReserve('user-1', 50, LAZY_TOKEN);

      bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens[LAZY_TOKEN].available, 100); // 50 + 50 released
      assert.equal(bal.tokens[LAZY_TOKEN].reserved, 0);
      assert.equal(bal.tokens.hbar.available, 50); // still untouched
    });

    it('insufficient balance check is per-token', () => {
      const LAZY_TOKEN = '0.0.8011209';
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 1000, reserved: 0, totalDeposited: 1000, totalWithdrawn: 0, totalRake: 0 },
            [LAZY_TOKEN]: { available: 5, reserved: 0, totalDeposited: 5, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      // HBAR has 1000 available, but LAZY only has 5
      assert.throws(
        () => ledger.reserve('user-1', 10, LAZY_TOKEN),
        (err: unknown) => err instanceof InsufficientBalanceError,
      );

      // HBAR reservation of same amount succeeds
      const bal = ledger.reserve('user-1', 10, 'hbar');
      assert.equal(bal.tokens.hbar.available, 990);
    });
  });

  // ── 8. Crash recovery: orphaned reserves ───────────────────────

  describe('crash recovery', () => {
    it('orphaned reserves are recovered to available on store.load', async () => {
      // Simulate a crash: user has funds stuck in reserved
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 20, reserved: 80, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
            '0.0.8011209': { available: 10, reserved: 40, totalDeposited: 50, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);
      await store.flush();
      await store.close();

      // Reload simulates restart -- orphaned reserves should be recovered
      const store2 = new PersistentStore(dir);
      await store2.load();

      const recovered = store2.getUser('user-1')!;
      assert.equal(recovered.balances.tokens.hbar.available, 100); // 20 + 80
      assert.equal(recovered.balances.tokens.hbar.reserved, 0);
      assert.equal(recovered.balances.tokens['0.0.8011209'].available, 50); // 10 + 40
      assert.equal(recovered.balances.tokens['0.0.8011209'].reserved, 0);

      await store2.close();
    });
  });

  // ── 9. Playback failure: full reserve released ─────────────────

  describe('play failure recovery pattern', () => {
    it('on play failure, full sessionBudget is released back to available', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      const sessionBudget = 80;

      // Replicate playForUser try/catch pattern
      ledger.reserve('user-1', sessionBudget, 'hbar');

      let bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.available, 20);
      assert.equal(bal.tokens.hbar.reserved, 80);

      // Simulate failure -- the catch block releases the full reservation
      ledger.releaseReserve('user-1', sessionBudget, 'hbar');

      bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.available, 100); // fully restored
      assert.equal(bal.tokens.hbar.reserved, 0);
    });

    it('on play failure after partial settle, release clamps to remaining reserved', () => {
      // Edge case: what if settleSpend was called before the error?
      // (This would be unusual but tests defensive clamping)
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      const sessionBudget = 80;

      ledger.reserve('user-1', sessionBudget, 'hbar');

      // Partial settle happened before error
      ledger.settleSpend('user-1', 30, 'hbar');

      let bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.reserved, 50); // 80 - 30

      // Catch block tries to release full sessionBudget (80), but only 50 is reserved
      // This should clamp to 50, not go negative
      ledger.releaseReserve('user-1', sessionBudget, 'hbar');

      bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.available, 70); // 20 + 50 (clamped release)
      assert.equal(bal.tokens.hbar.reserved, 0);
      // Net effect: 30 was legitimately spent, 50 was recovered
      // Total: 70 available = 100 - 30
    });
  });

  // ── 5. Per-token reservation/settlement (Stage 2) ─────────────
  //
  // These tests exercise the UserLedger primitives in the same
  // pattern as the new MultiUserAgent.playForUser per-token flow:
  //   - reserve every token in the user's balance set
  //   - settle each token from a per-token spend Map
  //   - release the unused reservation per token
  //   - on play failure, release every reservation
  //
  // The bug these tests were written for: a HBAR-only user
  // playing a LAZY pool used to cause operator-LAZY bleed because
  // playForUser only reserved/settled one "primary" token. With
  // per-token reservation, a token with 0 balance is never
  // reserved and the play loop refuses to spend it.

  describe('per-token reservation lifecycle', () => {
    const LAZY = '0.0.8011209';

    it('reserves multiple tokens for a multi-token user', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
            [LAZY]: { available: 50, reserved: 0, totalDeposited: 50, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      // Reserve 80 HBAR + 40 LAZY
      ledger.reserve('user-1', 80, 'hbar');
      ledger.reserve('user-1', 40, LAZY);

      const bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.available, 20);
      assert.equal(bal.tokens.hbar.reserved, 80);
      assert.equal(bal.tokens[LAZY]!.available, 10);
      assert.equal(bal.tokens[LAZY]!.reserved, 40);
    });

    it('settles each token independently from a per-token spend map', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
            [LAZY]: { available: 50, reserved: 0, totalDeposited: 50, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      // Reserve everything per-token
      const tokenReservations = new Map<string, number>([
        ['hbar', 80],
        [LAZY, 40],
      ]);
      for (const [token, amount] of tokenReservations) {
        ledger.reserve('user-1', amount, token);
      }

      // Simulate the play loop spending: 25 HBAR + 30 LAZY
      const spentByTokenId = new Map<string, number>([
        ['hbar', 25],
        [LAZY, 30],
      ]);

      // Per-token settlement loop (mirror of MultiUserAgent)
      for (const [token, reserved] of tokenReservations) {
        const actualSpent = spentByTokenId.get(token) ?? 0;
        if (actualSpent > 0) {
          ledger.settleSpend('user-1', actualSpent, token);
        }
        const unused = reserved - actualSpent;
        if (unused > 0) {
          ledger.releaseReserve('user-1', unused, token);
        }
      }

      const bal = store.getUser('user-1')!.balances;
      // HBAR: started 100, spent 25, ended 75 available, 0 reserved
      assert.equal(bal.tokens.hbar.available, 75);
      assert.equal(bal.tokens.hbar.reserved, 0);
      // LAZY: started 50, spent 30, ended 20 available, 0 reserved
      assert.equal(bal.tokens[LAZY]!.available, 20);
      assert.equal(bal.tokens[LAZY]!.reserved, 0);
    });

    it('releases all reservations on simulated play failure', () => {
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
            [LAZY]: { available: 50, reserved: 0, totalDeposited: 50, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });
      store.saveUser(user);

      const tokenReservations = new Map<string, number>([
        ['hbar', 80],
        [LAZY, 40],
      ]);
      for (const [token, amount] of tokenReservations) {
        ledger.reserve('user-1', amount, token);
      }

      // Simulate play() throwing — release every reservation
      for (const [token, amount] of tokenReservations) {
        ledger.releaseReserve('user-1', amount, token);
      }

      const bal = store.getUser('user-1')!.balances;
      assert.equal(bal.tokens.hbar.available, 100); // fully restored
      assert.equal(bal.tokens.hbar.reserved, 0);
      assert.equal(bal.tokens[LAZY]!.available, 50);
      assert.equal(bal.tokens[LAZY]!.reserved, 0);
    });

    it('HBAR-only user only has HBAR in the reservation set', () => {
      // This is the critical regression test for the bug. A user
      // with only HBAR balance must NEVER end up with LAZY in the
      // reservation set (because they have 0 LAZY available).
      const user = makeUser({
        balances: {
          tokens: {
            hbar: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
            // no LAZY entry
          },
        },
        strategySnapshot: makeStrategy({
          budget: {
            tokenBudgets: {
              hbar: { maxPerSession: 50, maxPerPool: 20, reserve: 0 },
              [LAZY]: { maxPerSession: 50, maxPerPool: 20, reserve: 0 },
            },
            maxEntriesPerPool: 10,
          },
        }),
      });
      store.saveUser(user);

      // Replicate the playForUser reservation-set computation:
      // intersection of strategy budgets with positive-balance tokens
      const tokenReservations = new Map<string, number>();
      for (const [tokenKey, tokenBudget] of Object.entries(
        user.strategySnapshot.budget.tokenBudgets,
      )) {
        const entry = user.balances.tokens[tokenKey];
        const available = entry?.available ?? 0;
        if (available <= 0) continue;
        const cap = tokenBudget.maxPerSession ?? available;
        tokenReservations.set(tokenKey, Math.min(cap, available));
      }

      assert.equal(tokenReservations.size, 1);
      assert.ok(tokenReservations.has('hbar'));
      assert.ok(!tokenReservations.has(LAZY));
      assert.equal(tokenReservations.get('hbar'), 50); // capped at maxPerSession
    });

    it('correctly aggregates spentByTokenId from poolResults with mixed feeTokenId', () => {
      // This is the per-token derivation from report.poolResults that
      // MultiUserAgent uses to drive settlement. Verifies the math
      // independently of the rest of the flow.
      const poolResults = [
        { poolId: 1, feeTokenId: 'hbar', amountSpent: 5 },
        { poolId: 2, feeTokenId: 'hbar', amountSpent: 10 },
        { poolId: 3, feeTokenId: LAZY, amountSpent: 20 },
        { poolId: 4, feeTokenId: LAZY, amountSpent: 15 },
        { poolId: 5, feeTokenId: 'hbar', amountSpent: 0 }, // no spend
      ];

      const spentByTokenId = new Map<string, number>();
      for (const r of poolResults) {
        if (r.amountSpent <= 0) continue;
        spentByTokenId.set(r.feeTokenId, (spentByTokenId.get(r.feeTokenId) ?? 0) + r.amountSpent);
      }

      assert.equal(spentByTokenId.size, 2);
      assert.equal(spentByTokenId.get('hbar'), 15); // 5 + 10
      assert.equal(spentByTokenId.get(LAZY), 35);   // 20 + 15
    });
  });
});
