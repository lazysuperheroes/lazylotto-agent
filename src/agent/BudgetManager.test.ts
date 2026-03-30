import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetManager } from './BudgetManager.js';
import type { Budget } from '../config/strategy.js';

const budget: Budget = {
  tokenBudgets: {
    hbar: { maxPerSession: 100, maxPerPool: 50, reserve: 10 },
    '0.0.8011209': { maxPerSession: 500, maxPerPool: 200, reserve: 50 },
  },
  maxEntriesPerPool: 10,
};

describe('BudgetManager', () => {
  it('starts with full budget for all tokens', () => {
    const bm = new BudgetManager(budget);
    assert.equal(bm.totalSpentFor('hbar'), 0);
    assert.equal(bm.remainingFor('hbar'), 100);
    assert.equal(bm.totalSpentFor('0.0.8011209'), 0);
    assert.equal(bm.remainingFor('0.0.8011209'), 500);
    assert.equal(bm.isFullyExhausted(), false);
    assert.equal(bm.hasAnyBudgetRemaining(), true);
  });

  it('tracks per-token spending independently', () => {
    const bm = new BudgetManager(budget);
    bm.recordSpend(1, 30, 'hbar', 3);
    bm.recordSpend(1, 100, '0.0.8011209', 5);

    assert.equal(bm.totalSpentFor('hbar'), 30);
    assert.equal(bm.remainingFor('hbar'), 70);
    assert.equal(bm.totalSpentFor('0.0.8011209'), 100);
    assert.equal(bm.remainingFor('0.0.8011209'), 400);
  });

  it('canAfford checks token-specific limits', () => {
    const bm = new BudgetManager(budget);
    assert.equal(bm.canAfford('hbar', 1, 50), true);
    assert.equal(bm.canAfford('hbar', 1, 51), false); // exceeds pool limit
    assert.equal(bm.canAfford('0.0.8011209', 1, 200), true);
    assert.equal(bm.canAfford('0.0.8011209', 1, 201), false); // exceeds pool limit

    bm.recordSpend(1, 40, 'hbar', 4);
    assert.equal(bm.canAfford('hbar', 1, 11), false); // exceeds pool remaining (50-40=10)
    assert.equal(bm.canAfford('hbar', 2, 50), true);  // different pool, session has 60 left
    assert.equal(bm.canAfford('hbar', 2, 61), false); // exceeds session remaining

    // LAZY token unaffected by HBAR spending
    assert.equal(bm.canAfford('0.0.8011209', 1, 200), true);
  });

  it('maxEntriesForPool respects per-token session + pool + entry limits', () => {
    const bm = new BudgetManager(budget);
    // hbar: entryFee=5, session allows 100/5=20, pool allows 50/5=10, maxEntries=10
    assert.equal(bm.maxEntriesForPool('hbar', 1, 5), 10);

    bm.recordSpend(1, 35, 'hbar', 7); // pool has 15 left, session has 65 left
    // pool: 15/5=3, session: 65/5=13, maxEntries: 10-7=3 (7 entries recorded)
    assert.equal(bm.maxEntriesForPool('hbar', 1, 5), 3);

    // Entry limit is per-pool total (across all tokens), so LAZY on pool 1 also sees 7 used
    assert.equal(bm.maxEntriesForPool('0.0.8011209', 1, 10), 3); // 10-7=3 entries left
    // But a different pool is unaffected
    assert.equal(bm.maxEntriesForPool('0.0.8011209', 2, 10), 10);
  });

  it('maxEntriesForPool handles zero entry fee', () => {
    const bm = new BudgetManager(budget);
    assert.equal(bm.maxEntriesForPool('hbar', 1, 0), 10); // falls back to maxEntriesPerPool
  });

  it('isExhaustedFor returns true only for exhausted token', () => {
    const bm = new BudgetManager(budget);
    bm.recordSpend(1, 50, 'hbar', 5);
    bm.recordSpend(2, 50, 'hbar', 5);
    assert.equal(bm.isExhaustedFor('hbar'), true);
    assert.equal(bm.isExhaustedFor('0.0.8011209'), false);
  });

  it('isFullyExhausted only when ALL tokens exhausted', () => {
    const bm = new BudgetManager(budget);
    bm.recordSpend(1, 50, 'hbar', 5);
    bm.recordSpend(2, 50, 'hbar', 5);
    assert.equal(bm.isFullyExhausted(), false); // LAZY still has budget

    bm.recordSpend(1, 200, '0.0.8011209', 10);
    bm.recordSpend(2, 200, '0.0.8011209', 10);
    bm.recordSpend(3, 100, '0.0.8011209', 5);
    assert.equal(bm.isFullyExhausted(), true);
  });

  it('hasAnyBudgetRemaining when at least one has room', () => {
    const bm = new BudgetManager(budget);
    bm.recordSpend(1, 50, 'hbar', 5);
    bm.recordSpend(2, 50, 'hbar', 5);
    assert.equal(bm.hasAnyBudgetRemaining(), true); // LAZY still has room

    bm.recordSpend(1, 200, '0.0.8011209', 10);
    bm.recordSpend(2, 200, '0.0.8011209', 10);
    bm.recordSpend(3, 100, '0.0.8011209', 5);
    assert.equal(bm.hasAnyBudgetRemaining(), false);
  });

  it('checkReserve per-token', () => {
    const bm = new BudgetManager(budget);
    // hbar reserve = 10
    assert.equal(bm.checkReserve('hbar', 50), true);   // 50 - 0 >= 10
    assert.equal(bm.checkReserve('hbar', 9), false);    // 9 - 0 < 10

    bm.recordSpend(1, 45, 'hbar', 5);
    assert.equal(bm.checkReserve('hbar', 50), false);   // 50 - 45 = 5 < 10
    assert.equal(bm.checkReserve('hbar', 60), true);    // 60 - 45 = 15 >= 10

    // LAZY reserve = 50
    assert.equal(bm.checkReserve('0.0.8011209', 100), true);  // 100 - 0 >= 50
    assert.equal(bm.checkReserve('0.0.8011209', 30), false);  // 30 - 0 < 50
  });

  it('unknown token returns 0 remaining and cannot afford', () => {
    const bm = new BudgetManager(budget);
    assert.equal(bm.remainingFor('unknown'), 0);
    assert.equal(bm.canAfford('unknown', 1, 1), false);
    assert.equal(bm.maxEntriesForPool('unknown', 1, 5), 0);
    assert.equal(bm.checkReserve('unknown', 1000), false);
  });

  it('getSummary returns per-token breakdown', () => {
    const bm = new BudgetManager(budget);
    bm.recordSpend(1, 25, 'hbar', 3);
    bm.recordSpend(1, 80, '0.0.8011209', 4);

    const summary = bm.getSummary();
    assert.equal(summary.tokens.length, 2);

    const hbarSummary = summary.tokens.find((t) => t.token === 'hbar');
    assert.ok(hbarSummary);
    assert.equal(hbarSummary.spent, 25);
    assert.equal(hbarSummary.remaining, 75);
    assert.equal(hbarSummary.maxPerSession, 100);
    assert.equal(hbarSummary.maxPerPool, 50);
    assert.equal(hbarSummary.reserve, 10);

    const lazySummary = summary.tokens.find((t) => t.token === '0.0.8011209');
    assert.ok(lazySummary);
    assert.equal(lazySummary.spent, 80);
    assert.equal(lazySummary.remaining, 420);

    assert.equal(summary.records.length, 2);
    assert.equal(summary.maxEntriesPerPool, 10);
  });

  it('recordSpend tracks entries correctly per pool across tokens', () => {
    const bm = new BudgetManager(budget);
    bm.recordSpend(1, 15, 'hbar', 3);
    bm.recordSpend(1, 50, '0.0.8011209', 5);
    bm.recordSpend(2, 10, 'hbar', 2);
    bm.recordSpend(1, 20, 'hbar', 4);

    // Pool-level token spending
    assert.equal(bm.spentOnPool('hbar', 1), 35);       // 15 + 20
    assert.equal(bm.spentOnPool('hbar', 2), 10);
    assert.equal(bm.spentOnPool('0.0.8011209', 1), 50);
    assert.equal(bm.spentOnPool('0.0.8011209', 2), 0);

    // Pool-level token remaining
    assert.equal(bm.remainingForPool('hbar', 1), 15);   // 50 - 35
    assert.equal(bm.remainingForPool('hbar', 2), 40);   // 50 - 10
    assert.equal(bm.remainingForPool('0.0.8011209', 1), 150); // 200 - 50

    // Session totals per token
    assert.equal(bm.totalSpentFor('hbar'), 45);          // 15 + 20 + 10
    assert.equal(bm.totalSpentFor('0.0.8011209'), 50);
  });

  it('budgetedTokens returns all configured token keys', () => {
    const bm = new BudgetManager(budget);
    const tokens = bm.budgetedTokens;
    assert.deepEqual(tokens.sort(), ['0.0.8011209', 'hbar']);
  });
});
