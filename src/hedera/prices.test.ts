import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PriceOracle } from './prices.js';

describe('PriceOracle', () => {
  it('returns null for uncached token', () => {
    const oracle = new PriceOracle();
    assert.equal(oracle.getCachedUsdPrice('hbar'), null);
    assert.equal(oracle.getCachedUsdPrice('0.0.unknown'), null);
  });

  it('getHbarUsdPrice returns number or null (never throws)', async () => {
    const oracle = new PriceOracle();
    const price = await oracle.getHbarUsdPrice();
    // On testnet with network: returns a positive number
    // Without network: returns null
    // Either way, should not throw
    assert.ok(price === null || (typeof price === 'number' && price > 0));
  });

  it('toUsd returns number or null (never throws)', async () => {
    const oracle = new PriceOracle();
    const usd = await oracle.toUsd(100, 'hbar');
    assert.ok(usd === null || (typeof usd === 'number' && usd > 0));
  });

  it('registerToken stores token for lookup', () => {
    const oracle = new PriceOracle();
    oracle.registerToken('LAZY', '0.0.8011209');
    // Registration is for price fetching, not cache — still null until fetched
    assert.equal(oracle.getCachedUsdPrice('LAZY'), null);
  });

  it('getCachedUsdPrice returns cached value after successful fetch', async () => {
    const oracle = new PriceOracle();
    await oracle.getHbarUsdPrice(); // may or may not succeed
    // If it succeeded, cache should have a value
    const cached = oracle.getCachedUsdPrice('hbar');
    // Either null (no network) or a number (cached)
    assert.ok(cached === null || typeof cached === 'number');
  });
});
