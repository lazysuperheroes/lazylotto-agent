import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ReportGenerator, type PoolResult } from './ReportGenerator.js';

describe('ReportGenerator', () => {
  function makeResult(overrides: Partial<PoolResult> = {}): PoolResult {
    return {
      poolId: 1,
      poolName: 'Pool A',
      entriesBought: 3,
      amountSpent: 15,
      feeTokenSymbol: 'HBAR',
      feeTokenId: 'hbar',
      rolled: true,
      wins: 1,
      prizesClaimed: 0,
      prizesTransferred: 1,
      prizeDetails: [],
      ...overrides,
    };
  }

  it('generates empty report when no pools played', () => {
    const gen = new ReportGenerator();
    gen.begin('balanced', 'LAZY');
    gen.setPoolsEvaluated(5);
    const report = gen.generate();

    assert.equal(report.strategy, 'balanced');
    assert.equal(report.currency, 'LAZY');
    assert.equal(report.poolsEvaluated, 5);
    assert.equal(report.poolsPlayed, 0);
    assert.equal(report.totalEntries, 0);
    assert.equal(report.totalSpent, 0);
    assert.equal(report.totalWins, 0);
  });

  it('aggregates pool results', () => {
    const gen = new ReportGenerator();
    gen.begin('aggressive', 'LAZY');
    gen.setPoolsEvaluated(10);
    gen.addPoolResult(makeResult({ poolId: 1, entriesBought: 5, amountSpent: 25, wins: 2 }));
    gen.addPoolResult(makeResult({ poolId: 2, entriesBought: 3, amountSpent: 15, wins: 0 }));
    const report = gen.generate();

    assert.equal(report.poolsPlayed, 2);
    assert.equal(report.totalEntries, 8);
    assert.equal(report.totalSpent, 40);
    assert.equal(report.totalWins, 2);
  });

  it('includes ISO timestamps', () => {
    const gen = new ReportGenerator();
    gen.begin('test', 'HBAR');
    const report = gen.generate();

    assert.ok(report.startedAt.includes('T'));
    assert.ok(report.endedAt.includes('T'));
    assert.ok(new Date(report.startedAt).getTime() <= new Date(report.endedAt).getTime());
  });

  it('resets state on begin', () => {
    const gen = new ReportGenerator();
    gen.begin('first', 'LAZY');
    gen.addPoolResult(makeResult());
    gen.generate();

    gen.begin('second', 'HBAR');
    const report = gen.generate();
    assert.equal(report.strategy, 'second');
    assert.equal(report.poolsPlayed, 0);
    assert.equal(report.totalEntries, 0);
  });
});
