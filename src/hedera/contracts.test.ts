import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateGas } from './contracts.js';

describe('estimateGas', () => {
  it('calculates buyEntry gas without multiplier', () => {
    // base 350k + 150k * 3 = 800k
    assert.equal(estimateGas('buyEntry', 3), 800_000);
  });

  it('calculates buyAndRollEntry gas with 1.5x multiplier', () => {
    // base 750k + 610k * 2 = 1_970k, * 1.5 = 2_955k
    assert.equal(estimateGas('buyAndRollEntry', 2), 2_955_000);
  });

  it('calculates rollAll gas with 1.5x multiplier', () => {
    // base 400k + 400k * 5 = 2_400k, * 1.5 = 3_600k
    assert.equal(estimateGas('rollAll', 5), 3_600_000);
  });

  it('calculates rollBatch gas with 1.5x multiplier', () => {
    // base 400k + 400k * 3 = 1_600k, * 1.5 = 2_400k
    assert.equal(estimateGas('rollBatch', 3), 2_400_000);
  });

  it('calculates claimAllPrizes gas without multiplier', () => {
    // base 500k + 0 * anything = 500k
    assert.equal(estimateGas('claimAllPrizes', 10), 500_000);
  });

  it('caps at maxGas (14.5M)', () => {
    // rollAll with 100 units: (400k + 400k*100) * 1.5 = 60.6M → capped to 14.5M
    assert.equal(estimateGas('rollAll', 100), 14_500_000);
  });

  it('handles zero units', () => {
    assert.equal(estimateGas('buyEntry', 0), 350_000);
  });
});
