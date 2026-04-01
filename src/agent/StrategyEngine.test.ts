import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyEngine } from './StrategyEngine.js';
import type { Strategy } from '../config/strategy.js';
import type { PoolSummary, EvCalculation } from '../mcp/client.js';

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    name: 'test',
    version: '0.2',
    poolFilter: {
      type: 'all',
      feeToken: 'any',
      minPrizeCount: 1,
      ...overrides.poolFilter,
    },
    budget: {
      tokenBudgets: { hbar: { maxPerSession: 100, maxPerPool: 50, reserve: 5 } },
      maxEntriesPerPool: 10,
      ...overrides.budget,
    },
    playStyle: {
      action: 'buy_and_roll',
      entriesPerBatch: 2,
      minExpectedValue: -10,
      preferNftPrizes: false,
      transferToOwner: true,
      ownerAddress: '0.0.99999',
      ...overrides.playStyle,
    },
    schedule: {
      enabled: false,
      cron: '0 */6 * * *',
      maxSessionsPerDay: 4,
      ...overrides.schedule,
    },
  };
}

function makePool(overrides: Partial<PoolSummary> = {}): PoolSummary {
  return {
    poolId: 1,
    name: 'Test Pool',
    winRatePercent: 10,
    entryFee: 5,
    feeTokenSymbol: 'LAZY',
    prizeCount: 3,
    outstandingEntries: 10,
    paused: false,
    closed: false,
    trustLevel: null,
    ...overrides,
  };
}

function makeEv(poolId: number, ev: number): EvCalculation {
  return {
    poolId,
    entryCost: 5,
    effectiveWinRate: 0.1,
    avgPrizeValue: 50,
    expectedValue: ev,
    recommendation: ev >= 0 ? 'play' : 'skip',
  };
}

describe('StrategyEngine', () => {
  describe('filterPools', () => {
    it('excludes paused and closed pools', () => {
      const engine = new StrategyEngine(makeStrategy());
      const pools = [
        makePool({ poolId: 1 }),
        makePool({ poolId: 2, paused: true }),
        makePool({ poolId: 3, closed: true }),
      ];
      const result = engine.filterPools(pools);
      assert.equal(result.length, 1);
      assert.equal(result[0].poolId, 1);
    });

    it('filters by minWinRate', () => {
      const engine = new StrategyEngine(
        makeStrategy({ poolFilter: { type: 'all', feeToken: 'any', minPrizeCount: 1, minWinRate: 15 } })
      );
      const pools = [
        makePool({ poolId: 1, winRatePercent: 10 }),
        makePool({ poolId: 2, winRatePercent: 20 }),
      ];
      const result = engine.filterPools(pools);
      assert.equal(result.length, 1);
      assert.equal(result[0].poolId, 2);
    });

    it('filters by maxEntryFee', () => {
      const engine = new StrategyEngine(
        makeStrategy({ poolFilter: { type: 'all', feeToken: 'any', minPrizeCount: 1, maxEntryFee: 10 } })
      );
      const pools = [
        makePool({ poolId: 1, entryFee: 5 }),
        makePool({ poolId: 2, entryFee: 15 }),
      ];
      const result = engine.filterPools(pools);
      assert.equal(result.length, 1);
      assert.equal(result[0].poolId, 1);
    });

    it('filters by feeToken', () => {
      const engine = new StrategyEngine(
        makeStrategy({ poolFilter: { type: 'all', feeToken: 'HBAR', minPrizeCount: 1 } })
      );
      const pools = [
        makePool({ poolId: 1, feeTokenSymbol: 'LAZY' }),
        makePool({ poolId: 2, feeTokenSymbol: 'HBAR' }),
      ];
      const result = engine.filterPools(pools);
      assert.equal(result.length, 1);
      assert.equal(result[0].poolId, 2);
    });

    it('filters by minPrizeCount', () => {
      const engine = new StrategyEngine(
        makeStrategy({ poolFilter: { type: 'all', feeToken: 'any', minPrizeCount: 3 } })
      );
      const pools = [
        makePool({ poolId: 1, prizeCount: 2 }),
        makePool({ poolId: 2, prizeCount: 5 }),
      ];
      const result = engine.filterPools(pools);
      assert.equal(result.length, 1);
      assert.equal(result[0].poolId, 2);
    });
  });

  describe('scorePools', () => {
    it('scores and sorts by EV descending', () => {
      const engine = new StrategyEngine(makeStrategy());
      const pools = [makePool({ poolId: 1 }), makePool({ poolId: 2 })];
      const evs = [makeEv(1, -5), makeEv(2, 10)];
      const scored = engine.scorePools(pools, evs);

      assert.equal(scored.length, 2);
      assert.equal(scored[0].pool.poolId, 2); // higher EV first
      assert.equal(scored[0].score, 10);
      assert.equal(scored[1].pool.poolId, 1);
      assert.equal(scored[1].score, -5);
    });

    it('filters out pools below minExpectedValue', () => {
      const engine = new StrategyEngine(
        makeStrategy({ playStyle: { action: 'buy_and_roll', entriesPerBatch: 1, minExpectedValue: 0, preferNftPrizes: false, transferToOwner: true } })
      );
      const pools = [makePool({ poolId: 1 }), makePool({ poolId: 2 })];
      const evs = [makeEv(1, -5), makeEv(2, 10)];
      const scored = engine.scorePools(pools, evs);

      assert.equal(scored.length, 1);
      assert.equal(scored[0].pool.poolId, 2);
    });

    it('skips pools with no EV data', () => {
      const engine = new StrategyEngine(makeStrategy());
      const pools = [makePool({ poolId: 1 }), makePool({ poolId: 2 })];
      const evs = [makeEv(1, 5)]; // no EV for pool 2
      const scored = engine.scorePools(pools, evs);

      assert.equal(scored.length, 1);
      assert.equal(scored[0].pool.poolId, 1);
    });
  });

  describe('accessors', () => {
    it('returns strategy values', () => {
      const engine = new StrategyEngine(
        makeStrategy({
          playStyle: {
            action: 'buy',
            entriesPerBatch: 3,
            minExpectedValue: 0,
            preferNftPrizes: true,
            transferToOwner: true,
            ownerAddress: '0.0.12345',
          },
        })
      );
      assert.equal(engine.getAction(), 'buy');
      assert.equal(engine.getEntriesPerBatch(), 3);
      assert.equal(engine.shouldPreferNftPrizes(), true);
      assert.equal(engine.shouldTransferToOwner(), true);
      assert.equal(engine.getOwnerAddress(), '0.0.12345');
    });

    it('preferNftPrizes defaults to false', () => {
      const engine = new StrategyEngine(makeStrategy());
      assert.equal(engine.shouldPreferNftPrizes(), false);
    });
  });
});
