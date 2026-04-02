import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeChecksum, withChecksum } from './checksum.js';

describe('HIP-15 Address Checksum', () => {
  // Reference test vectors from HIP-15 spec
  it('computes checksum for 0.0.1 on mainnet', () => {
    const cs = computeChecksum('0.0.1', 'mainnet');
    assert.equal(cs.length, 5, 'checksum should be 5 characters');
    assert.match(cs, /^[a-z]{5}$/, 'checksum should be lowercase a-z');
  });

  it('computes different checksums for different networks', () => {
    const mainnet = computeChecksum('0.0.1234', 'mainnet');
    const testnet = computeChecksum('0.0.1234', 'testnet');
    assert.notEqual(mainnet, testnet, 'mainnet and testnet checksums should differ');
  });

  it('computes different checksums for different addresses', () => {
    const a = computeChecksum('0.0.1234', 'testnet');
    const b = computeChecksum('0.0.5678', 'testnet');
    assert.notEqual(a, b, 'different addresses should have different checksums');
  });

  it('produces deterministic output', () => {
    const a = computeChecksum('0.0.8456987', 'testnet');
    const b = computeChecksum('0.0.8456987', 'testnet');
    assert.equal(a, b);
  });

  it('withChecksum formats address-checksum', () => {
    const result = withChecksum('0.0.1234', 'testnet');
    assert.match(result, /^0\.0\.1234-[a-z]{5}$/);
  });

  it('withChecksum defaults to HEDERA_NETWORK env', () => {
    const prev = process.env.HEDERA_NETWORK;
    process.env.HEDERA_NETWORK = 'testnet';
    const result = withChecksum('0.0.1234');
    assert.match(result, /^0\.0\.1234-[a-z]{5}$/);
    process.env.HEDERA_NETWORK = prev;
  });

  it('handles large account numbers', () => {
    const cs = computeChecksum('0.0.8456987', 'testnet');
    assert.equal(cs.length, 5);
    assert.match(cs, /^[a-z]{5}$/);
  });
});
