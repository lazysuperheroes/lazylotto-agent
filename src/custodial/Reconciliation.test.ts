import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentStore } from './PersistentStore.js';
import type { UserAccount, OperatorState } from './types.js';
import { emptyBalances, emptyOperatorState } from './types.js';
import type { ReconciliationResult } from './Reconciliation.js';

// ── Constants (mirrored from strategy module to avoid import side effects) ──

const HBAR_TOKEN_KEY = 'hbar';

// ── Helpers ─────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'recon-test-'));
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
    rakePercent: 5,
    balances: emptyBalances(),
    connectionTopicId: null,
    registeredAt: '2026-01-01T00:00:00.000Z',
    lastPlayedAt: null,
    active: true,
    ...overrides,
  };
}

// ── Reconciliation logic extracted for pure testing ─────────────
//
// The actual `reconcile()` function calls Hedera SDK + mirror node.
// We replicate the pure computation steps here so we can test the
// arithmetic in isolation without mocking module-level imports.

interface ReconInput {
  /** On-chain balances as the function would see them. */
  onChain: Record<string, number>;
  /** All user accounts from the store. */
  users: UserAccount[];
  /** Operator state from the store. */
  operator: OperatorState;
  /** Actual network fees in HBAR fetched from mirror node. */
  actualNetworkFeesHbar: number;
}

function computeReconciliation(input: ReconInput): ReconciliationResult {
  const { onChain, users, operator, actualNetworkFeesHbar } = input;
  const warnings: string[] = [];

  // Sum all user balances (available + reserved) per token
  const ledgerTotal: Record<string, number> = {};
  for (const user of users) {
    for (const [token, entry] of Object.entries(user.balances.tokens)) {
      const userTotal = entry.available + entry.reserved;
      ledgerTotal[token] = (ledgerTotal[token] ?? 0) + userTotal;
    }
  }

  // Add operator balances
  for (const [token, balance] of Object.entries(operator.balances)) {
    ledgerTotal[token] = (ledgerTotal[token] ?? 0) + balance;
  }

  // Fee adjustment
  const trackedGasHbar = operator.totalGasSpent;
  const untrackedFeesHbar = Math.max(0, actualNetworkFeesHbar - trackedGasHbar);

  // Compute deltas
  const allTokens = new Set([...Object.keys(onChain), ...Object.keys(ledgerTotal)]);
  const delta: Record<string, number> = {};
  const adjustedDelta: Record<string, number> = {};
  let solvent = true;

  for (const token of allTokens) {
    const chain = onChain[token] ?? 0;
    const ledger = ledgerTotal[token] ?? 0;
    delta[token] = chain - ledger;

    adjustedDelta[token] = token === HBAR_TOKEN_KEY
      ? delta[token] + untrackedFeesHbar
      : delta[token];

    if (adjustedDelta[token] < -0.01) {
      solvent = false;
      warnings.push(
        `INSOLVENCY: ${token} on-chain=${chain.toFixed(4)}, ledger=${ledger.toFixed(4)}, ` +
          `adjusted_shortfall=${Math.abs(adjustedDelta[token]).toFixed(4)}`,
      );
    } else if (adjustedDelta[token] > 1) {
      warnings.push(
        `UNACCOUNTED: ${token} on-chain has ${adjustedDelta[token].toFixed(4)} more than ledger tracks`,
      );
    }
  }

  // Mirror the PR6 fields (schema divergence + pending ledger queue).
  // The pure test helper doesn't actually drain a queue — it just shapes
  // the result so the type matches. Tests that care about these fields
  // assert on them explicitly; other tests ignore them.
  const schemaUserCounts: Record<number, number> = {};
  for (const user of users) {
    const v = user.schemaVersion ?? 0;
    schemaUserCounts[v] = (schemaUserCounts[v] ?? 0) + 1;
  }
  const schemaOperator = operator.schemaVersion ?? 0;

  // Test helper builds a trivial symbols map (just maps each token to
  // itself or "HBAR" for native). The real reconcile() warms the
  // registry from mirror node; tests don't need that round trip.
  const symbols: Record<string, string> = {};
  for (const token of allTokens) {
    symbols[token] = token === 'hbar' ? 'HBAR' : token;
  }

  return {
    timestamp: new Date().toISOString(),
    onChain,
    ledgerTotal,
    actualNetworkFeesHbar,
    trackedGasHbar,
    untrackedFeesHbar,
    delta,
    adjustedDelta,
    symbols,
    solvent,
    warnings,
    schema: {
      current: 1,
      users: schemaUserCounts,
      operator: schemaOperator,
      allAtCurrent: false, // test helper doesn't evaluate this
    },
    pendingLedgerDrained: { attempted: 0, applied: 0, deferred: 0, failed: 0 },
    pendingLedgerRemaining: 0,
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe('Reconciliation logic', () => {
  describe('balanced books (on-chain matches ledger)', () => {
    it('returns delta 0 and solvent when balances match exactly', () => {
      const userA = makeUser({
        userId: 'user-a',
        balances: {
          tokens: {
            hbar: { available: 80, reserved: 0, totalDeposited: 100, totalWithdrawn: 15, totalRake: 5 },
          },
        },
      });

      const operator: OperatorState = {
        balances: { hbar: 20 },
        totalRakeCollected: { hbar: 20 },
        totalGasSpent: 0,
        totalWithdrawnByOperator: {},
      };

      const result = computeReconciliation({
        onChain: { hbar: 100 },
        users: [userA],
        operator,
        actualNetworkFeesHbar: 0,
      });

      assert.equal(result.solvent, true);
      assert.equal(result.delta.hbar, 0); // 100 - (80 + 20)
      assert.equal(result.adjustedDelta.hbar, 0);
      assert.equal(result.warnings.length, 0);
    });

    it('handles multiple tokens all balanced', () => {
      const lazyTokenId = '0.0.8011209';
      const userA = makeUser({
        userId: 'user-a',
        balances: {
          tokens: {
            hbar: { available: 50, reserved: 0, totalDeposited: 50, totalWithdrawn: 0, totalRake: 0 },
            [lazyTokenId]: { available: 200, reserved: 0, totalDeposited: 200, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });

      const operator: OperatorState = {
        balances: { hbar: 10, [lazyTokenId]: 30 },
        totalRakeCollected: { hbar: 10, [lazyTokenId]: 30 },
        totalGasSpent: 0,
        totalWithdrawnByOperator: {},
      };

      const result = computeReconciliation({
        onChain: { hbar: 60, [lazyTokenId]: 230 },
        users: [userA],
        operator,
        actualNetworkFeesHbar: 0,
      });

      assert.equal(result.solvent, true);
      assert.equal(result.delta.hbar, 0);
      assert.equal(result.delta[lazyTokenId], 0);
      assert.equal(result.warnings.length, 0);
    });
  });

  describe('HBAR fee adjustments', () => {
    it('untracked fees explain HBAR shortfall, still solvent', () => {
      const userA = makeUser({
        userId: 'user-a',
        balances: {
          tokens: {
            hbar: { available: 90, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 10 },
          },
        },
      });

      const operator: OperatorState = {
        balances: { hbar: 8 }, // 10 rake - 2 tracked gas
        totalRakeCollected: { hbar: 10 },
        totalGasSpent: 2,
        totalWithdrawnByOperator: {},
      };

      // On-chain is 95 (100 deposited - 5 in actual fees)
      // Ledger total is 90 + 8 = 98
      // Raw delta = 95 - 98 = -3
      // Actual fees = 5, tracked gas = 2, untracked = 3
      // Adjusted delta = -3 + 3 = 0
      const result = computeReconciliation({
        onChain: { hbar: 95 },
        users: [userA],
        operator,
        actualNetworkFeesHbar: 5,
      });

      assert.equal(result.delta.hbar, -3);
      assert.equal(result.untrackedFeesHbar, 3); // 5 - 2
      assert.equal(result.adjustedDelta.hbar, 0); // -3 + 3
      assert.equal(result.solvent, true);
      assert.equal(result.warnings.length, 0);
    });

    it('partial fee explanation still leaves insolvency', () => {
      const userA = makeUser({
        userId: 'user-a',
        balances: {
          tokens: {
            hbar: { available: 90, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 10 },
          },
        },
      });

      const operator: OperatorState = {
        balances: { hbar: 10 },
        totalRakeCollected: { hbar: 10 },
        totalGasSpent: 0,
        totalWithdrawnByOperator: {},
      };

      // On-chain is 89 but ledger says 100. Actual fees only 1 HBAR.
      // Raw delta = 89 - 100 = -11
      // Untracked fees = max(0, 1 - 0) = 1
      // Adjusted delta = -11 + 1 = -10 (still insolvent, > 0.01 threshold)
      const result = computeReconciliation({
        onChain: { hbar: 89 },
        users: [userA],
        operator,
        actualNetworkFeesHbar: 1,
      });

      assert.equal(result.solvent, false);
      assert.equal(result.delta.hbar, -11);
      assert.equal(result.untrackedFeesHbar, 1);
      assert.equal(result.adjustedDelta.hbar, -10);
      assert.ok(result.warnings.some((w) => w.startsWith('INSOLVENCY')));
    });

    it('tracked gas exceeding actual fees means zero untracked', () => {
      // Edge case: GasTracker overestimates compared to actual fees
      const operator: OperatorState = {
        balances: { hbar: 5 },
        totalRakeCollected: { hbar: 10 },
        totalGasSpent: 8, // Tracked more gas than actual fees
        totalWithdrawnByOperator: {},
      };

      const result = computeReconciliation({
        onChain: { hbar: 5 },
        users: [],
        operator,
        actualNetworkFeesHbar: 3, // Less than tracked
      });

      // untracked = max(0, 3 - 8) = 0
      assert.equal(result.untrackedFeesHbar, 0);
      assert.equal(result.trackedGasHbar, 8);
    });
  });

  describe('token insolvency', () => {
    it('detects insolvency when on-chain token balance < ledger total', () => {
      const lazyTokenId = '0.0.8011209';
      const userA = makeUser({
        userId: 'user-a',
        balances: {
          tokens: {
            [lazyTokenId]: { available: 500, reserved: 0, totalDeposited: 500, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });

      const operator: OperatorState = {
        balances: { [lazyTokenId]: 50 },
        totalRakeCollected: { [lazyTokenId]: 50 },
        totalGasSpent: 0,
        totalWithdrawnByOperator: {},
      };

      // On-chain has 400 LAZY, but ledger says 550
      const result = computeReconciliation({
        onChain: { [lazyTokenId]: 400 },
        users: [userA],
        operator,
        actualNetworkFeesHbar: 0,
      });

      assert.equal(result.solvent, false);
      assert.equal(result.delta[lazyTokenId], -150); // 400 - 550
      // Token is not HBAR, so no fee adjustment
      assert.equal(result.adjustedDelta[lazyTokenId], -150);
      assert.ok(result.warnings.some((w) => w.includes('INSOLVENCY') && w.includes(lazyTokenId)));
    });

    it('fee adjustment does not apply to non-HBAR tokens', () => {
      const lazyTokenId = '0.0.8011209';

      const operator: OperatorState = {
        balances: { [lazyTokenId]: 100 },
        totalRakeCollected: { [lazyTokenId]: 100 },
        totalGasSpent: 5, // Gas is always HBAR
        totalWithdrawnByOperator: {},
      };

      // Even with big actual fees, LAZY delta is not adjusted
      const result = computeReconciliation({
        onChain: { [lazyTokenId]: 90 },
        users: [],
        operator,
        actualNetworkFeesHbar: 10,
      });

      // Raw delta = 90 - 100 = -10
      // Adjusted delta for non-HBAR = same as raw
      assert.equal(result.delta[lazyTokenId], -10);
      assert.equal(result.adjustedDelta[lazyTokenId], -10);
      assert.equal(result.solvent, false);
    });
  });

  describe('unaccounted surplus', () => {
    it('warns when on-chain far exceeds ledger', () => {
      const userA = makeUser({
        userId: 'user-a',
        balances: {
          tokens: {
            hbar: { available: 10, reserved: 0, totalDeposited: 10, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });

      const operator: OperatorState = emptyOperatorState();

      // On-chain has 50 HBAR but ledger only tracks 10
      // delta = 50 - 10 = 40, adjusted = 40 + 0 = 40, which is > 1
      const result = computeReconciliation({
        onChain: { hbar: 50 },
        users: [userA],
        operator,
        actualNetworkFeesHbar: 0,
      });

      assert.equal(result.solvent, true);
      assert.equal(result.delta.hbar, 40);
      assert.ok(result.warnings.some((w) => w.includes('UNACCOUNTED')));
    });

    it('does not warn for small surplus within threshold', () => {
      const operator: OperatorState = {
        balances: { hbar: 10 },
        totalRakeCollected: { hbar: 10 },
        totalGasSpent: 0,
        totalWithdrawnByOperator: {},
      };

      // On-chain is 10.5, ledger is 10. Delta = 0.5, which is <= 1.
      const result = computeReconciliation({
        onChain: { hbar: 10.5 },
        users: [],
        operator,
        actualNetworkFeesHbar: 0,
      });

      assert.equal(result.solvent, true);
      assert.equal(result.warnings.length, 0);
    });
  });

  describe('multiple users with multiple tokens', () => {
    it('correctly aggregates per-token across users and operator', () => {
      const lazyTokenId = '0.0.8011209';
      const otherTokenId = '0.0.9999999';

      const userA = makeUser({
        userId: 'user-a',
        depositMemo: 'memo-a',
        balances: {
          tokens: {
            hbar: { available: 30, reserved: 10, totalDeposited: 50, totalWithdrawn: 5, totalRake: 5 },
            [lazyTokenId]: { available: 100, reserved: 0, totalDeposited: 120, totalWithdrawn: 10, totalRake: 10 },
          },
        },
      });

      const userB = makeUser({
        userId: 'user-b',
        depositMemo: 'memo-b',
        hederaAccountId: '0.0.5678',
        balances: {
          tokens: {
            hbar: { available: 20, reserved: 5, totalDeposited: 30, totalWithdrawn: 0, totalRake: 5 },
            [lazyTokenId]: { available: 50, reserved: 50, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
            [otherTokenId]: { available: 75, reserved: 0, totalDeposited: 75, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });

      const operator: OperatorState = {
        balances: { hbar: 8, [lazyTokenId]: 10, [otherTokenId]: 5 },
        totalRakeCollected: { hbar: 10, [lazyTokenId]: 10, [otherTokenId]: 5 },
        totalGasSpent: 2,
        totalWithdrawnByOperator: {},
      };

      // Expected ledger totals:
      //   HBAR: (30+10) + (20+5) + 8 = 73
      //   LAZY: (100+0) + (50+50) + 10 = 210
      //   OTHER: (75+0) + 5 = 80

      const result = computeReconciliation({
        onChain: { hbar: 73, [lazyTokenId]: 210, [otherTokenId]: 80 },
        users: [userA, userB],
        operator,
        actualNetworkFeesHbar: 2,
      });

      assert.equal(result.ledgerTotal.hbar, 73);
      assert.equal(result.ledgerTotal[lazyTokenId], 210);
      assert.equal(result.ledgerTotal[otherTokenId], 80);

      assert.equal(result.delta.hbar, 0);
      assert.equal(result.delta[lazyTokenId], 0);
      assert.equal(result.delta[otherTokenId], 0);

      assert.equal(result.solvent, true);
      assert.equal(result.warnings.length, 0);
    });

    it('includes reserved balances in ledger total', () => {
      const userA = makeUser({
        userId: 'user-a',
        balances: {
          tokens: {
            hbar: { available: 0, reserved: 100, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });

      const operator: OperatorState = emptyOperatorState();

      const result = computeReconciliation({
        onChain: { hbar: 100 },
        users: [userA],
        operator,
        actualNetworkFeesHbar: 0,
      });

      // Reserved funds must be included
      assert.equal(result.ledgerTotal.hbar, 100);
      assert.equal(result.delta.hbar, 0);
      assert.equal(result.solvent, true);
    });
  });

  describe('operator balance', () => {
    it('operator-only balances included in ledger total', () => {
      const operator: OperatorState = {
        balances: { hbar: 42, '0.0.1111': 10 },
        totalRakeCollected: { hbar: 42, '0.0.1111': 10 },
        totalGasSpent: 0,
        totalWithdrawnByOperator: {},
      };

      const result = computeReconciliation({
        onChain: { hbar: 42, '0.0.1111': 10 },
        users: [],
        operator,
        actualNetworkFeesHbar: 0,
      });

      assert.equal(result.ledgerTotal.hbar, 42);
      assert.equal(result.ledgerTotal['0.0.1111'], 10);
      assert.equal(result.solvent, true);
      assert.equal(result.warnings.length, 0);
    });
  });

  describe('empty state', () => {
    it('returns all zeros with no users and no operator balance', () => {
      const result = computeReconciliation({
        onChain: {},
        users: [],
        operator: emptyOperatorState(),
        actualNetworkFeesHbar: 0,
      });

      assert.deepStrictEqual(result.onChain, {});
      assert.deepStrictEqual(result.ledgerTotal, {});
      assert.deepStrictEqual(result.delta, {});
      assert.deepStrictEqual(result.adjustedDelta, {});
      assert.equal(result.actualNetworkFeesHbar, 0);
      assert.equal(result.trackedGasHbar, 0);
      assert.equal(result.untrackedFeesHbar, 0);
      assert.equal(result.solvent, true);
      assert.equal(result.warnings.length, 0);
    });

    it('on-chain balance with empty ledger produces surplus warning', () => {
      const result = computeReconciliation({
        onChain: { hbar: 5 },
        users: [],
        operator: emptyOperatorState(),
        actualNetworkFeesHbar: 0,
      });

      assert.equal(result.solvent, true);
      assert.equal(result.delta.hbar, 5);
      assert.ok(result.warnings.some((w) => w.includes('UNACCOUNTED')));
    });
  });

  describe('solvency threshold', () => {
    it('adjusted delta of -0.005 is within threshold, still solvent', () => {
      const operator: OperatorState = {
        balances: { hbar: 10 },
        totalRakeCollected: { hbar: 10 },
        totalGasSpent: 0,
        totalWithdrawnByOperator: {},
      };

      // On-chain is 9.995, ledger is 10, delta = -0.005
      // Adjusted delta = -0.005 + 0 = -0.005, which is > -0.01
      const result = computeReconciliation({
        onChain: { hbar: 9.995 },
        users: [],
        operator,
        actualNetworkFeesHbar: 0,
      });

      assert.equal(result.solvent, true);
      assert.ok(result.delta.hbar < 0);
      assert.equal(result.warnings.length, 0);
    });

    it('adjusted delta of -0.009 is within threshold, still solvent', () => {
      const operator: OperatorState = {
        balances: { hbar: 10 },
        totalRakeCollected: { hbar: 10 },
        totalGasSpent: 0,
        totalWithdrawnByOperator: {},
      };

      // On-chain is 9.991, ledger is 10, delta = -0.009
      // -0.009 is NOT < -0.01, so still solvent
      const result = computeReconciliation({
        onChain: { hbar: 9.991 },
        users: [],
        operator,
        actualNetworkFeesHbar: 0,
      });

      assert.equal(result.solvent, true);
      assert.equal(result.warnings.length, 0);
    });

    it('adjusted delta of -0.02 crosses threshold, insolvent', () => {
      const operator: OperatorState = {
        balances: { hbar: 10 },
        totalRakeCollected: { hbar: 10 },
        totalGasSpent: 0,
        totalWithdrawnByOperator: {},
      };

      const result = computeReconciliation({
        onChain: { hbar: 9.98 },
        users: [],
        operator,
        actualNetworkFeesHbar: 0,
      });

      assert.equal(result.solvent, false);
      assert.ok(result.warnings.some((w) => w.includes('INSOLVENCY')));
    });
  });

  describe('surplus threshold', () => {
    it('adjusted delta of 0.99 does not trigger surplus warning', () => {
      const operator: OperatorState = {
        balances: { hbar: 9 },
        totalRakeCollected: { hbar: 9 },
        totalGasSpent: 0,
        totalWithdrawnByOperator: {},
      };

      const result = computeReconciliation({
        onChain: { hbar: 9.99 },
        users: [],
        operator,
        actualNetworkFeesHbar: 0,
      });

      assert.equal(result.solvent, true);
      assert.equal(result.warnings.length, 0);
    });

    it('adjusted delta of exactly 1 does not trigger surplus warning', () => {
      const operator: OperatorState = {
        balances: { hbar: 9 },
        totalRakeCollected: { hbar: 9 },
        totalGasSpent: 0,
        totalWithdrawnByOperator: {},
      };

      // Delta = 10 - 9 = 1, which is NOT > 1 (equal), so no warning
      const result = computeReconciliation({
        onChain: { hbar: 10 },
        users: [],
        operator,
        actualNetworkFeesHbar: 0,
      });

      assert.equal(result.warnings.length, 0);
    });

    it('adjusted delta of 1.01 triggers surplus warning', () => {
      const operator: OperatorState = {
        balances: { hbar: 9 },
        totalRakeCollected: { hbar: 9 },
        totalGasSpent: 0,
        totalWithdrawnByOperator: {},
      };

      const result = computeReconciliation({
        onChain: { hbar: 10.01 },
        users: [],
        operator,
        actualNetworkFeesHbar: 0,
      });

      assert.ok(result.warnings.some((w) => w.includes('UNACCOUNTED')));
    });
  });

  describe('tokens only on one side', () => {
    it('ledger has token that on-chain lacks (on-chain 0)', () => {
      const lazyTokenId = '0.0.8011209';
      const userA = makeUser({
        userId: 'user-a',
        balances: {
          tokens: {
            [lazyTokenId]: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
          },
        },
      });

      const result = computeReconciliation({
        onChain: {}, // Token not present on-chain at all
        users: [userA],
        operator: emptyOperatorState(),
        actualNetworkFeesHbar: 0,
      });

      // delta = 0 - 100 = -100
      assert.equal(result.delta[lazyTokenId], -100);
      assert.equal(result.solvent, false);
      assert.ok(result.warnings.some((w) => w.includes('INSOLVENCY') && w.includes(lazyTokenId)));
    });

    it('on-chain has token that ledger lacks (surplus)', () => {
      const unknownToken = '0.0.7777777';

      const result = computeReconciliation({
        onChain: { [unknownToken]: 50 },
        users: [],
        operator: emptyOperatorState(),
        actualNetworkFeesHbar: 0,
      });

      // delta = 50 - 0 = 50
      assert.equal(result.delta[unknownToken], 50);
      assert.equal(result.solvent, true);
      assert.ok(result.warnings.some((w) => w.includes('UNACCOUNTED') && w.includes(unknownToken)));
    });
  });
});

// ── Store integration tests ─────────────────────────────────────
//
// These tests verify that PersistentStore correctly provides the
// user and operator data that reconcile() consumes. They use a real
// PersistentStore with a temp directory.

describe('Reconciliation store integration', () => {
  let dir: string;
  let store: PersistentStore;

  beforeEach(async () => {
    dir = makeTempDir();
    store = new PersistentStore(dir);
    await store.load();
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('getAllUsers returns data suitable for reconciliation sum', async () => {
    store.saveUser(makeUser({
      userId: 'user-a',
      depositMemo: 'memo-a',
      balances: {
        tokens: {
          hbar: { available: 50, reserved: 10, totalDeposited: 60, totalWithdrawn: 0, totalRake: 0 },
        },
      },
    }));

    store.saveUser(makeUser({
      userId: 'user-b',
      depositMemo: 'memo-b',
      hederaAccountId: '0.0.5678',
      balances: {
        tokens: {
          hbar: { available: 30, reserved: 0, totalDeposited: 30, totalWithdrawn: 0, totalRake: 0 },
        },
      },
    }));

    await store.flush();

    const users = store.getAllUsers();
    assert.equal(users.length, 2);

    // Compute ledger total the same way reconcile does
    const ledgerTotal: Record<string, number> = {};
    for (const user of users) {
      for (const [token, entry] of Object.entries(user.balances.tokens)) {
        const userTotal = entry.available + entry.reserved;
        ledgerTotal[token] = (ledgerTotal[token] ?? 0) + userTotal;
      }
    }

    // 50 + 10 + 30 + 0 = 90
    assert.equal(ledgerTotal.hbar, 90);
  });

  it('getOperator returns balances for reconciliation', async () => {
    store.updateOperator((op) => ({
      ...op,
      balances: { hbar: 15, '0.0.8011209': 25 },
      totalGasSpent: 3.5,
    }));

    await store.flush();

    const op = store.getOperator();
    assert.equal(op.balances.hbar, 15);
    assert.equal(op.balances['0.0.8011209'], 25);
    assert.equal(op.totalGasSpent, 3.5);
  });

  it('combined user + operator balance matches expected reconciliation total', async () => {
    const lazyTokenId = '0.0.8011209';

    store.saveUser(makeUser({
      userId: 'user-a',
      depositMemo: 'memo-a',
      balances: {
        tokens: {
          hbar: { available: 40, reserved: 5, totalDeposited: 50, totalWithdrawn: 0, totalRake: 5 },
          [lazyTokenId]: { available: 100, reserved: 0, totalDeposited: 100, totalWithdrawn: 0, totalRake: 0 },
        },
      },
    }));

    store.updateOperator((op) => ({
      ...op,
      balances: { hbar: 5, [lazyTokenId]: 10 },
      totalRakeCollected: { hbar: 5, [lazyTokenId]: 10 },
      totalGasSpent: 1,
    }));

    await store.flush();

    const users = store.getAllUsers();
    const operator = store.getOperator();

    // Feed into the pure computation
    const result = computeReconciliation({
      onChain: { hbar: 49, [lazyTokenId]: 110 },
      users,
      operator,
      actualNetworkFeesHbar: 1,
    });

    // Ledger: HBAR = (40+5) + 5 = 50, LAZY = 100 + 10 = 110
    assert.equal(result.ledgerTotal.hbar, 50);
    assert.equal(result.ledgerTotal[lazyTokenId], 110);

    // HBAR: on-chain 49, ledger 50, raw delta = -1
    // Actual fees = 1, tracked gas = 1, untracked = 0
    // Adjusted delta = -1 + 0 = -1 (still insolvent by 1 HBAR)
    assert.equal(result.delta.hbar, -1);
    assert.equal(result.untrackedFeesHbar, 0);
    assert.equal(result.adjustedDelta.hbar, -1);

    // LAZY: perfectly balanced
    assert.equal(result.delta[lazyTokenId], 0);
    assert.equal(result.solvent, false); // HBAR shortfall
  });
});
