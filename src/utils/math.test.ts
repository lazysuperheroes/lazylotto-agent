import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  roundToDecimals,
  roundForToken,
  roundUsd,
  registerToken,
  getDecimalsSync,
  getSymbol,
  getTokenMetaSync,
  initTokenRegistry,
} from './math.js';

describe('roundToDecimals', () => {
  it('rounds HBAR to 8 decimal places', () => {
    assert.equal(roundToDecimals(0.123456789, 8), 0.12345679);
  });

  it('rounds LAZY to 1 decimal place', () => {
    assert.equal(roundToDecimals(0.15, 1), 0.2);
    assert.equal(roundToDecimals(0.14, 1), 0.1);
  });

  it('rounds to 0 decimal places (integer tokens)', () => {
    assert.equal(roundToDecimals(1.7, 0), 2);
    assert.equal(roundToDecimals(1.3, 0), 1);
  });

  it('handles exact values', () => {
    assert.equal(roundToDecimals(1.5, 1), 1.5);
    assert.equal(roundToDecimals(100, 8), 100);
  });
});

describe('roundUsd', () => {
  it('rounds to 2 decimal places', () => {
    assert.equal(roundUsd(1.234), 1.23);
    assert.equal(roundUsd(1.235), 1.24);
    assert.equal(roundUsd(0.1 + 0.2), 0.3); // classic float fix
  });
});

describe('Token Registry', () => {
  it('HBAR is pre-registered with 8 decimals', () => {
    const meta = getTokenMetaSync('hbar');
    assert.ok(meta);
    assert.equal(meta.decimals, 8);
    assert.equal(meta.symbol, 'HBAR');
  });

  it('registerToken adds new token', () => {
    registerToken('0.0.12345', 6, 'USDC');
    const meta = getTokenMetaSync('0.0.12345');
    assert.ok(meta);
    assert.equal(meta.decimals, 6);
    assert.equal(meta.symbol, 'USDC');
  });

  it('getDecimalsSync returns 0 for unknown token', () => {
    assert.equal(getDecimalsSync('0.0.unknown'), 0);
  });

  it('getSymbol returns token ID for unknown token', () => {
    assert.equal(getSymbol('0.0.99999'), '0.0.99999');
  });

  it('roundForToken uses registered decimals', () => {
    registerToken('0.0.test', 3, 'TEST');
    assert.equal(roundForToken(1.23456, '0.0.test'), 1.235);
  });

  it('roundForToken returns raw for unknown token', () => {
    assert.equal(roundForToken(1.23456, '0.0.nope'), 1.23456);
  });
});
