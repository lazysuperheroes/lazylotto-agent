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

  // spentByToken is the per-token spend breakdown that the dashboard
  // session card uses to display "30 HBAR + 5 LAZY spent" instead of
  // a bare cross-token sum. Keyed by feeTokenSymbol (HBAR / LAZY /
  // etc). Required for honest multi-token display.
  it('aggregates spentByToken for a single HBAR-only session', () => {
    const gen = new ReportGenerator();
    gen.begin('balanced', 'HBAR');
    gen.addPoolResult(makeResult({ poolId: 1, amountSpent: 25, feeTokenSymbol: 'HBAR' }));
    gen.addPoolResult(makeResult({ poolId: 2, amountSpent: 15, feeTokenSymbol: 'HBAR' }));
    const report = gen.generate();

    assert.deepEqual(report.spentByToken, { HBAR: 40 });
    assert.equal(report.totalSpent, 40);
  });

  it('aggregates spentByToken per token for a mixed HBAR + LAZY session', () => {
    const gen = new ReportGenerator();
    gen.begin('balanced', 'HBAR');
    gen.addPoolResult(makeResult({ poolId: 1, amountSpent: 25, feeTokenSymbol: 'HBAR' }));
    gen.addPoolResult(makeResult({ poolId: 2, amountSpent: 100, feeTokenSymbol: 'LAZY' }));
    gen.addPoolResult(makeResult({ poolId: 3, amountSpent: 15, feeTokenSymbol: 'HBAR' }));
    const report = gen.generate();

    assert.deepEqual(report.spentByToken, { HBAR: 40, LAZY: 100 });
    // totalSpent is the cross-token sum — meaningless for multi-token
    // display but preserved for legacy single-number consumers.
    assert.equal(report.totalSpent, 140);
  });

  it('defaults missing feeTokenSymbol to HBAR in spentByToken', () => {
    const gen = new ReportGenerator();
    gen.begin('balanced', 'HBAR');
    // Simulate a legacy-ish pool result with empty feeTokenSymbol.
    // The generator falls back to 'HBAR' so the bucket key is stable.
    gen.addPoolResult(makeResult({ poolId: 1, amountSpent: 10, feeTokenSymbol: '' }));
    const report = gen.generate();

    assert.deepEqual(report.spentByToken, { HBAR: 10 });
  });
});
