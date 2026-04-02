import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  errorMsg,
  toEvmAddress,
  hbarToNumber,
  tokenBalanceToNumber,
} from './format.js';

// ── errorMsg ─────────────────────────────────────────────────

describe('errorMsg', () => {
  it('extracts message from an Error object', () => {
    const err = new Error('something broke');
    assert.equal(errorMsg(err), 'something broke');
  });

  it('extracts message from an Error subclass', () => {
    class CustomError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = 'CustomError';
      }
    }
    assert.equal(errorMsg(new CustomError('custom fail')), 'custom fail');
  });

  it('handles a plain string', () => {
    assert.equal(errorMsg('raw string error'), 'raw string error');
  });

  it('handles a number', () => {
    assert.equal(errorMsg(42), '42');
  });

  it('handles null', () => {
    assert.equal(errorMsg(null), 'null');
  });

  it('handles undefined', () => {
    assert.equal(errorMsg(undefined), 'undefined');
  });

  it('handles an object without message property', () => {
    assert.equal(errorMsg({ code: 'ERR' }), '[object Object]');
  });
});

// ── toEvmAddress ─────────────────────────────────────────────

describe('toEvmAddress', () => {
  it('converts "0.0.1234" to 0x-prefixed EVM address', () => {
    const result = toEvmAddress('0.0.1234');
    // AccountId(shard=0, realm=0, num=1234)
    // num 1234 = 0x4D2, padded to 8 hex chars in the last 4 bytes
    // Full 20-byte address: 00000000 0000000000000000 00000000000004D2
    assert.equal(result, '0x00000000000000000000000000000000000004d2');
    assert.equal(result.length, 42); // 0x + 40 hex chars
  });

  it('converts "0.0.98" to correct EVM address', () => {
    // num 98 = 0x62
    const result = toEvmAddress('0.0.98');
    assert.equal(result, '0x0000000000000000000000000000000000000062');
  });

  it('passes through an already-0x-prefixed address unchanged', () => {
    const addr = '0xaBcDeF0123456789aBcDeF0123456789aBcDeF01';
    assert.equal(toEvmAddress(addr), addr);
  });

  it('passes through a lowercase 0x address unchanged', () => {
    const addr = '0x0000000000000000000000000000000000000001';
    assert.equal(toEvmAddress(addr), addr);
  });

  it('converts "0.0.0" to all-zero EVM address', () => {
    const result = toEvmAddress('0.0.0');
    assert.equal(result, '0x0000000000000000000000000000000000000000');
  });

  it('throws for an invalid account ID format', () => {
    assert.throws(() => toEvmAddress('not-an-id'), {
      // AccountId.fromString should throw on garbage input
      name: 'Error',
    });
  });
});

// ── hbarToNumber ─────────────────────────────────────────────

describe('hbarToNumber', () => {
  /**
   * hbarToNumber expects an object with toTinybars() -> { toString() -> string }.
   * We build lightweight stubs matching that duck-typed interface.
   */
  function fakeHbar(tinybars: bigint | number) {
    return {
      toTinybars() {
        return { toString: () => String(tinybars) };
      },
    };
  }

  it('converts 1 HBAR (100_000_000 tinybars) to 1', () => {
    assert.equal(hbarToNumber(fakeHbar(100_000_000)), 1);
  });

  it('converts 0 tinybars to 0', () => {
    assert.equal(hbarToNumber(fakeHbar(0)), 0);
  });

  it('converts fractional HBAR correctly', () => {
    // 50_000_000 tinybars = 0.5 HBAR
    assert.equal(hbarToNumber(fakeHbar(50_000_000)), 0.5);
  });

  it('handles large amounts', () => {
    // 10 HBAR = 1_000_000_000 tinybars
    assert.equal(hbarToNumber(fakeHbar(1_000_000_000)), 10);
  });

  it('handles small amounts', () => {
    // 1 tinybar = 0.00000001 HBAR
    assert.equal(hbarToNumber(fakeHbar(1)), 1e-8);
  });
});

// ── tokenBalanceToNumber ─────────────────────────────────────

describe('tokenBalanceToNumber', () => {
  const sampleTokens = [
    { token_id: '0.0.100', balance: 15, decimals: 1 },    // 1.5 LAZY
    { token_id: '0.0.200', balance: 1_000_000, decimals: 6 }, // 1.0 USDC
    { token_id: '0.0.300', balance: 0, decimals: 8 },     // 0
    { token_id: '0.0.400', balance: 123456789, decimals: 8 }, // 1.23456789 (some token)
  ];

  it('returns 0 for a token not present in the list', () => {
    assert.equal(tokenBalanceToNumber(sampleTokens, '0.0.999'), 0);
  });

  it('returns 0 for an empty token list', () => {
    assert.equal(tokenBalanceToNumber([], '0.0.100'), 0);
  });

  it('applies correct decimals for LAZY (1 decimal)', () => {
    // balance 15 / 10^1 = 1.5
    assert.equal(tokenBalanceToNumber(sampleTokens, '0.0.100'), 1.5);
  });

  it('applies correct decimals for USDC (6 decimals)', () => {
    // balance 1_000_000 / 10^6 = 1.0
    assert.equal(tokenBalanceToNumber(sampleTokens, '0.0.200'), 1);
  });

  it('returns 0 when balance is 0', () => {
    assert.equal(tokenBalanceToNumber(sampleTokens, '0.0.300'), 0);
  });

  it('applies correct decimals for 8-decimal token', () => {
    // balance 123456789 / 10^8 = 1.23456789 (rounds to 8 decimals)
    assert.equal(tokenBalanceToNumber(sampleTokens, '0.0.400'), 1.23456789);
  });

  it('matches by token_id, not by position', () => {
    const tokens = [
      { token_id: '0.0.A', balance: 100, decimals: 2 },
      { token_id: '0.0.B', balance: 200, decimals: 2 },
    ];
    assert.equal(tokenBalanceToNumber(tokens, '0.0.B'), 2); // 200/100=2
  });
});
