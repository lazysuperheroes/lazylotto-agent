import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetManager } from './BudgetManager.js';
import type { Budget } from '../config/strategy.js';

const budget: Budget = {
  maxSpendPerSession: 100,
  maxSpendPerPool: 50,
  maxEntriesPerPool: 10,
  reserveBalance: 10,
  currency: 'LAZY',
};

describe('BudgetManager', () => {
  it('starts with full budget remaining', () => {
    const bm = new BudgetManager(budget);
    assert.equal(bm.totalSpent, 0);
    assert.equal(bm.remaining, 100);
    assert.equal(bm.isExhausted(), false);
  });

  it('tracks spending and reduces remaining', () => {
    const bm = new BudgetManager(budget);
    bm.recordSpend(1, 30);
    assert.equal(bm.totalSpent, 30);
    assert.equal(bm.remaining, 70);
  });

  it('tracks per-pool spending', () => {
    const bm = new BudgetManager(budget);
    bm.recordSpend(1, 20);
    bm.recordSpend(2, 15);
    bm.recordSpend(1, 10);
    assert.equal(bm.spentOnPool(1), 30);
    assert.equal(bm.spentOnPool(2), 15);
    assert.equal(bm.remainingForPool(1), 20);
    assert.equal(bm.remainingForPool(2), 35);
  });

  it('canAfford checks both session and pool limits', () => {
    const bm = new BudgetManager(budget);
    assert.equal(bm.canAfford(1, 50), true);
    assert.equal(bm.canAfford(1, 51), false); // exceeds pool limit
    bm.recordSpend(1, 40);
    assert.equal(bm.canAfford(1, 11), false); // exceeds pool remaining
    assert.equal(bm.canAfford(2, 50), true);  // different pool, session has 60 left
    assert.equal(bm.canAfford(2, 61), false); // exceeds session remaining
  });

  it('maxEntriesForPool respects all three limits', () => {
    const bm = new BudgetManager(budget);
    // entryFee=5, session allows 100/5=20, pool allows 50/5=10, maxEntries=10
    assert.equal(bm.maxEntriesForPool(1, 5), 10);

    bm.recordSpend(1, 35); // pool has 15 left, session has 65 left
    // pool: 15/5=3, session: 65/5=13, maxEntries: 10-7=3 (7 entries recorded)
    assert.equal(bm.maxEntriesForPool(1, 5), 3);
  });

  it('maxEntriesForPool handles zero entry fee', () => {
    const bm = new BudgetManager(budget);
    assert.equal(bm.maxEntriesForPool(1, 0), 10); // falls back to maxEntriesPerPool
  });

  it('isExhausted when budget fully spent', () => {
    const bm = new BudgetManager(budget);
    bm.recordSpend(1, 50);
    bm.recordSpend(2, 50);
    assert.equal(bm.isExhausted(), true);
    assert.equal(bm.remaining, 0);
  });

  it('checkReserve verifies balance minus spent vs reserve', () => {
    const bm = new BudgetManager(budget);
    assert.equal(bm.checkReserve(50), true);  // 50 - 0 >= 10
    assert.equal(bm.checkReserve(9), false);  // 9 - 0 < 10
    bm.recordSpend(1, 45);
    assert.equal(bm.checkReserve(50), false); // 50 - 45 = 5 < 10
    assert.equal(bm.checkReserve(60), true);  // 60 - 45 = 15 >= 10
  });

  it('getSummary returns structured data', () => {
    const bm = new BudgetManager(budget);
    bm.recordSpend(1, 25);
    const summary = bm.getSummary();
    assert.equal(summary.totalSpent, 25);
    assert.equal(summary.remaining, 75);
    assert.equal(summary.records.length, 1);
    assert.equal(summary.records[0].poolId, 1);
    assert.equal(summary.records[0].amount, 25);
    assert.equal(summary.records[0].currency, 'LAZY');
  });
});
