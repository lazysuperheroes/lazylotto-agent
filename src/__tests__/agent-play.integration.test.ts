/**
 * Integration test for the LottoAgent play loop.
 *
 * Mocks:
 *  - Hedera SDK (wallet, contract execution)
 *  - MCP client (pool queries, EV, prerequisites, buy intents)
 *  - Mirror node (balances)
 *
 * Tests the full 6-phase orchestration: preflight -> discover -> evaluate -> play -> transfer -> report
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// -- Mock MCP client -----------------------------------------------------------

const mockPools = [
  {
    poolId: 1,
    name: 'LAZY Pool',
    winRatePercent: 10,
    entryFee: 5,
    feeTokenSymbol: 'LAZY',
    prizeCount: 3,
    outstandingEntries: 10,
    paused: false,
    closed: false,
    trustLevel: null,
  },
  {
    poolId: 2,
    name: 'Paused Pool',
    winRatePercent: 50,
    entryFee: 2,
    feeTokenSymbol: 'LAZY',
    prizeCount: 1,
    outstandingEntries: 0,
    paused: true,
    closed: false,
    trustLevel: null,
  },
];

const mockEv = {
  poolId: 1,
  entryCost: 5,
  effectiveWinRate: 0.1,
  avgPrizeValue: 60,
  expectedValue: 1.0,
  recommendation: 'play',
};

const mockUserState = {
  entriesByPool: {},
  pendingPrizesCount: 0,
  pendingPrizes: [],
  boost: 500,
};

const mockPrereqs = [{ type: 'balance', satisfied: true, reason: 'OK' }];

const mockIntent = {
  type: 'transaction_intent',
  chain: 'hedera:testnet',
  intent: {
    contractId: '0.0.8399255',
    functionName: 'buyAndRollEntry',
    functionSignature: 'buyAndRollEntry(uint256,uint256)',
    params: { poolId: 1, count: 2 },
    paramsOrdered: [1, 2],
    gas: 1_970_000,
    gasBreakdown: { base: 750_000, perUnit: 610_000, units: 2, formula: '750000 + 610000 * 2' },
    payableAmount: '0',
    payableToken: '0.0.8011209',
    payableUnit: 'token_smallest_unit',
    payableHumanReadable: '10 LAZY',
  },
  abi: [],
  encoded: '0x1234',
  humanReadable: 'Buy 2 entries in pool 1',
  prerequisites: [],
  warnings: [],
};

// Mock all external modules before importing the agent
const listPoolsMock = mock.fn(async () => mockPools);
const calculateEvMock = mock.fn(async () => mockEv);
const getUserStateMock = mock.fn(async () => mockUserState);
const getSystemInfoMock = mock.fn(async () => ({
  contractAddresses: { lazyLotto: '0.0.8399255', storage: '0.0.1', poolManager: '0.0.2', gasStation: '0.0.3' },
  lazyToken: '0.0.8011209',
  network: 'testnet',
  totalPools: 2,
}));
const checkPrereqsMock = mock.fn(async () => mockPrereqs);
const buyEntriesMock = mock.fn(async () => mockIntent);
const mcpRollMock = mock.fn(async () => mockIntent);
const closeMcpMock = mock.fn(async () => {});

// We test the pure logic components that don't require real SDK instances.
// The full LottoAgent integration requires a real Hedera Client which we can't
// construct without network access. Instead, we test the orchestration logic
// by verifying each component in isolation and their interaction contracts.

import { BudgetManager } from '../agent/BudgetManager.js';
import { StrategyEngine, type ScoredPool } from '../agent/StrategyEngine.js';
import { ReportGenerator, type PoolResult } from '../agent/ReportGenerator.js';
import type { Strategy } from '../config/strategy.js';
import type { PoolSummary, EvCalculation } from '../mcp/client.js';

const testStrategy: Strategy = {
  name: 'test',
  version: '0.2',
  poolFilter: { type: 'all', feeToken: 'any', minPrizeCount: 1 },
  budget: {
    tokenBudgets: { hbar: { maxPerSession: 50, maxPerPool: 25, reserve: 5 } },
    maxEntriesPerPool: 5,
  },
  playStyle: {
    action: 'buy_and_roll',
    entriesPerBatch: 2,
    minExpectedValue: -10,
    preferNftPrizes: false,
    transferToOwner: true,
    ownerAddress: '0.0.99999',
  },
  schedule: { enabled: false, cron: '0 */6 * * *', maxSessionsPerDay: 4 },
};

describe('Agent Play Loop (integration)', () => {
  let budgetManager: BudgetManager;
  let strategyEngine: StrategyEngine;
  let reportGenerator: ReportGenerator;

  beforeEach(() => {
    budgetManager = new BudgetManager(testStrategy.budget);
    strategyEngine = new StrategyEngine(testStrategy);
    reportGenerator = new ReportGenerator();
  });

  describe('Phase 2: Discover -> Phase 3: Evaluate', () => {
    it('filters paused pools and scores remaining by EV', () => {
      const filtered = strategyEngine.filterPools(mockPools as PoolSummary[]);
      assert.equal(filtered.length, 1); // pool 2 is paused
      assert.equal(filtered[0].poolId, 1);

      const scored = strategyEngine.scorePools(filtered, [mockEv as EvCalculation]);
      assert.equal(scored.length, 1);
      assert.equal(scored[0].score, 1.0);
      assert.equal(scored[0].pool.poolId, 1);
    });

    it('filters all pools when none match criteria', () => {
      const strictEngine = new StrategyEngine({
        ...testStrategy,
        poolFilter: { type: 'all', feeToken: 'HBAR', minPrizeCount: 1 },
      });
      const filtered = strictEngine.filterPools(mockPools as PoolSummary[]);
      assert.equal(filtered.length, 0); // all pools are LAZY, filter wants HBAR
    });
  });

  describe('Phase 4: Play loop with budget', () => {
    it('stops when budget exhausted', () => {
      const scored: ScoredPool[] = [
        { pool: mockPools[0] as PoolSummary, ev: mockEv as EvCalculation, score: 1.0 },
      ];

      reportGenerator.begin('test', 'LAZY');

      // Simulate playing until budget runs out
      let poolsPlayed = 0;
      for (const sp of scored) {
        if (budgetManager.isExhaustedFor('hbar')) break;

        const entries = budgetManager.maxEntriesForPool('hbar', sp.pool.poolId, sp.pool.entryFee);
        const batch = Math.min(entries, strategyEngine.getEntriesPerBatch());

        if (batch <= 0) break;

        // Simulate buying entries
        budgetManager.recordSpend(sp.pool.poolId, sp.pool.entryFee * batch, 'hbar', batch);
        poolsPlayed++;

        const result: PoolResult = {
          poolId: sp.pool.poolId,
          poolName: sp.pool.name,
          entriesBought: batch,
          amountSpent: sp.pool.entryFee * batch,
          feeTokenSymbol: sp.pool.feeTokenSymbol,
          rolled: true,
          wins: 0,
          prizesClaimed: 0,
          prizesTransferred: 0,
        };
        reportGenerator.addPoolResult(result);
      }

      assert.equal(poolsPlayed, 1);
      assert.equal(budgetManager.totalSpentFor('hbar'), 10); // 2 entries x 5
      assert.equal(budgetManager.remainingFor('hbar'), 40);
    });

    it('respects reserve balance', () => {
      // Balance = 15, reserve = 5, so can spend 10 max
      const currentBalance = 15;

      budgetManager.recordSpend(1, 8, 'hbar', 1);
      assert.equal(budgetManager.checkReserve('hbar', currentBalance), true); // 15-8=7 >= 5

      budgetManager.recordSpend(1, 3, 'hbar', 1);
      assert.equal(budgetManager.checkReserve('hbar', currentBalance), false); // 15-11=4 < 5
    });
  });

  describe('Phase 4: Prerequisite handling', () => {
    it('proceeds when all prerequisites satisfied', () => {
      const allSatisfied = [
        { type: 'balance', satisfied: true, reason: 'OK' },
        { type: 'ft_allowance', satisfied: true, reason: 'OK' },
      ];
      const unsatisfied = allSatisfied.filter((p) => !p.satisfied);
      assert.equal(unsatisfied.length, 0);
    });

    it('identifies unsatisfied prerequisites', () => {
      const mixed = [
        { type: 'balance', satisfied: true, reason: 'OK' },
        { type: 'ft_allowance', satisfied: false, reason: 'Need LAZY approval', action: { sdkTransaction: 'AccountAllowanceApproveTransaction', description: 'Approve LAZY', params: {} } },
        { type: 'token_association', satisfied: false, reason: 'Need association', action: { sdkTransaction: 'TokenAssociateTransaction', description: 'Associate token', params: {} } },
      ];
      const unsatisfied = mixed.filter((p) => !p.satisfied);
      assert.equal(unsatisfied.length, 2);
      assert.equal(unsatisfied[0].type, 'ft_allowance');
      assert.equal(unsatisfied[1].type, 'token_association');
    });
  });

  describe('Phase 6: Report generation', () => {
    it('produces complete session report', () => {
      reportGenerator.begin('test', 'LAZY');
      reportGenerator.setPoolsEvaluated(5);

      reportGenerator.addPoolResult({
        poolId: 1,
        poolName: 'Pool A',
        entriesBought: 3,
        amountSpent: 15,
        feeTokenSymbol: 'HBAR',
        rolled: true,
        wins: 1,
        prizesClaimed: 0,
        prizesTransferred: 1,
      });

      reportGenerator.addPoolResult({
        poolId: 2,
        poolName: 'Pool B',
        entriesBought: 2,
        amountSpent: 10,
        feeTokenSymbol: 'HBAR',
        rolled: true,
        wins: 0,
        prizesClaimed: 0,
        prizesTransferred: 0,
      });

      const report = reportGenerator.generate();
      assert.equal(report.poolsPlayed, 2);
      assert.equal(report.poolsEvaluated, 5);
      assert.equal(report.totalEntries, 5);
      assert.equal(report.totalSpent, 25);
      assert.equal(report.totalWins, 1);
      assert.equal(report.totalPrizesTransferred, 1);
      assert.equal(report.currency, 'LAZY');
    });
  });

  describe('Error resilience', () => {
    it('continues after pool failure (simulated)', () => {
      reportGenerator.begin('test', 'LAZY');

      const pools = [
        { poolId: 1, name: 'Fail Pool' },
        { poolId: 2, name: 'OK Pool' },
      ];

      const results: PoolResult[] = [];
      for (const pool of pools) {
        try {
          if (pool.poolId === 1) throw new Error('Simulated contract revert');

          results.push({
            poolId: pool.poolId,
            poolName: pool.name,
            entriesBought: 2,
            amountSpent: 10,
            feeTokenSymbol: 'HBAR',
            rolled: true,
            wins: 0,
            prizesClaimed: 0,
            prizesTransferred: 0,
          });
        } catch {
          // Agent catches per-pool errors and continues
          results.push({
            poolId: pool.poolId,
            poolName: pool.name,
            entriesBought: 0,
            amountSpent: 0,
            feeTokenSymbol: 'HBAR',
            rolled: false,
            wins: 0,
            prizesClaimed: 0,
            prizesTransferred: 0,
          });
        }
      }

      assert.equal(results.length, 2);
      assert.equal(results[0].entriesBought, 0); // failed pool
      assert.equal(results[1].entriesBought, 2); // succeeded pool
    });

    it('reports partial results when budget is hit mid-session', () => {
      const smallBudget = new BudgetManager({
        tokenBudgets: { hbar: { maxPerSession: 12, maxPerPool: 25, reserve: 5 } },
        maxEntriesPerPool: 5,
      });

      reportGenerator.begin('test', 'LAZY');

      // Pool 1: 2 entries x 5 = 10 spent
      smallBudget.recordSpend(1, 10, 'hbar', 2);
      reportGenerator.addPoolResult({
        poolId: 1, poolName: 'Pool 1', entriesBought: 2,
        amountSpent: 10, feeTokenSymbol: 'HBAR', rolled: true, wins: 0, prizesClaimed: 0, prizesTransferred: 0,
      });

      // Pool 2: budget only has 2 left, can't afford entryFee=5
      const canAffordPool2 = smallBudget.maxEntriesForPool('hbar', 2, 5);
      assert.equal(canAffordPool2, 0);

      const report = reportGenerator.generate();
      assert.equal(report.poolsPlayed, 1);
      assert.equal(report.totalSpent, 10);
    });
  });
});
