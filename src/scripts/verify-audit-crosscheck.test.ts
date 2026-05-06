/**
 * Regression tests for R2-FG-3 (phantom-mint cross-check tightening)
 * and R2-FG-4 (phantom-burn cross-check). Each test drives one
 * validator directly with a stubbed `MirrorTxResult` so we don't need
 * a live mirror node.
 *
 * The validators MUST flag every shape of forged credit/debit that
 * the round-2 audit identified:
 *   - tx 404 (no on-chain backing)
 *   - tx FAIL (revert)
 *   - amount mismatch (off-by-magnitude phantom)
 *   - wrong recipient (`--agent` set, transfer landed elsewhere)
 *   - outflow when topic claims credit (or inflow when it claims debit)
 *   - temporal drift > 5min (old tx replayed into a fresh mint)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MirrorTxCache,
  TokenDecimalsCache,
  approxEqual,
  consensusToSeconds,
  toBaseUnits,
  validateBurnCrossCheck,
  validateMintCrossCheck,
  type AuditAlert,
  type MirrorTxResult,
} from './verify-audit-crosscheck.js';

const HBAR_DECIMALS = 8;
const AGENT = '0.0.5000';
const USER = '0.0.7349994';
const TOKEN_LAZY = '0.0.4567';
const FAR_FUTURE_TS_BASE = 1_900_000_000;

function makeDecimalsCache(map: Record<string, number | null>): TokenDecimalsCache {
  return new TokenDecimalsCache(async (id: string) =>
    Object.prototype.hasOwnProperty.call(map, id) ? map[id]! : null,
  );
}

function ts(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

function hasCategory(alerts: AuditAlert[], cat: string): boolean {
  return alerts.some((a) => a.category === cat);
}

describe('verify-audit cross-check helpers', () => {
  it('toBaseUnits returns null when decimals are unknown', () => {
    assert.equal(toBaseUnits(5, null), null);
  });

  it('toBaseUnits handles HBAR (10^8) and 1-decimal LAZY', () => {
    assert.equal(toBaseUnits(1, HBAR_DECIMALS), 100_000_000);
    assert.equal(toBaseUnits(0.5, HBAR_DECIMALS), 50_000_000);
    assert.equal(toBaseUnits(5, 1), 50);
    assert.equal(toBaseUnits(0.1, 1), 1);
  });

  it('approxEqual tolerates 1 base unit drift', () => {
    assert.equal(approxEqual(100, 100), true);
    assert.equal(approxEqual(100, 101), true);
    assert.equal(approxEqual(100, 99), true);
    assert.equal(approxEqual(100, 102), false);
  });

  it('consensusToSeconds parses seconds.nanos and integer formats', () => {
    assert.equal(consensusToSeconds('1700000000.123456789'), 1700000000);
    assert.equal(consensusToSeconds('1700000000'), 1700000000);
    assert.equal(consensusToSeconds(undefined), null);
    assert.equal(consensusToSeconds('not-a-number'), null);
  });
});

describe('R2-FG-3: validateMintCrossCheck (HBAR)', () => {
  const decimalsCache = makeDecimalsCache({ HBAR: HBAR_DECIMALS });

  function baseMint() {
    return {
      sequence: 100,
      timestamp: ts(FAR_FUTURE_TS_BASE),
      depositTxId: '0.0.1@1700000000.000000001',
      user: USER,
      amount: 1,
      token: 'HBAR',
    };
  }

  function baseTx(overrides: Partial<MirrorTxResult> = {}): MirrorTxResult {
    return {
      found: true,
      result: 'SUCCESS',
      consensusTimestamp: `${FAR_FUTURE_TS_BASE - 5}.000000000`,
      transfers: [
        { account: '0.0.6000', amount: -100_000_001 },
        { account: AGENT, amount: 100_000_000 },
      ],
      tokenTransfers: [],
      ...overrides,
    };
  }

  it('emits no alerts on a clean mint to the agent', async () => {
    const alerts: AuditAlert[] = [];
    await validateMintCrossCheck(baseMint(), baseTx(), decimalsCache, AGENT, alerts);
    assert.deepEqual(alerts, []);
  });

  it('flags phantom_mint when mirror returns 404', async () => {
    const alerts: AuditAlert[] = [];
    await validateMintCrossCheck(baseMint(), { found: false }, decimalsCache, AGENT, alerts);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.severity, 'critical');
    assert.equal(alerts[0]!.category, 'phantom_mint');
    assert.match(alerts[0]!.message, /NO record/);
  });

  it('flags unverified (warning) on transient mirror error', async () => {
    const alerts: AuditAlert[] = [];
    await validateMintCrossCheck(
      baseMint(),
      { found: false, error: 'mirror 502' },
      decimalsCache,
      AGENT,
      alerts,
    );
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.severity, 'warning');
    assert.equal(alerts[0]!.category, 'unverified');
  });

  it('flags phantom_mint when result !== SUCCESS', async () => {
    const alerts: AuditAlert[] = [];
    await validateMintCrossCheck(
      baseMint(),
      baseTx({ result: 'CONTRACT_REVERT_EXECUTED' }),
      decimalsCache,
      AGENT,
      alerts,
    );
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.category, 'phantom_mint');
    assert.match(alerts[0]!.message, /CONTRACT_REVERT_EXECUTED/);
  });

  it('flags phantom_mint_amount_mismatch when on-chain amount differs', async () => {
    const alerts: AuditAlert[] = [];
    await validateMintCrossCheck(
      baseMint(),
      baseTx({
        transfers: [
          { account: '0.0.6000', amount: -1_001 },
          { account: AGENT, amount: 1_000 },
        ],
      }),
      decimalsCache,
      AGENT,
      alerts,
    );
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.category, 'phantom_mint_amount_mismatch');
  });

  it('flags phantom_mint_wrong_recipient when --agent is set and tx went elsewhere', async () => {
    const alerts: AuditAlert[] = [];
    await validateMintCrossCheck(
      baseMint(),
      baseTx({
        transfers: [
          { account: '0.0.6000', amount: -100_000_001 },
          { account: '0.0.9999', amount: 100_000_000 },
        ],
      }),
      decimalsCache,
      AGENT,
      alerts,
    );
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.category, 'phantom_mint_wrong_recipient');
  });

  it('does NOT flag wrong_recipient when --agent is null', async () => {
    const alerts: AuditAlert[] = [];
    await validateMintCrossCheck(
      baseMint(),
      baseTx({
        transfers: [
          { account: '0.0.6000', amount: -100_000_001 },
          { account: '0.0.9999', amount: 100_000_000 },
        ],
      }),
      decimalsCache,
      null,
      alerts,
    );
    assert.deepEqual(alerts, []);
  });

  it('flags phantom_mint_outflow when no incoming HBAR exists', async () => {
    const alerts: AuditAlert[] = [];
    await validateMintCrossCheck(
      baseMint(),
      baseTx({ transfers: [{ account: AGENT, amount: -100_000_000 }] }),
      decimalsCache,
      AGENT,
      alerts,
    );
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.category, 'phantom_mint_outflow');
  });

  it('flags phantom_mint_temporal when consensus is > 5min before message', async () => {
    const alerts: AuditAlert[] = [];
    await validateMintCrossCheck(
      baseMint(),
      baseTx({ consensusTimestamp: `${FAR_FUTURE_TS_BASE - 600}.0` }),
      decimalsCache,
      AGENT,
      alerts,
    );
    assert.equal(hasCategory(alerts, 'phantom_mint_temporal'), true);
  });

  it('flags phantom_mint_temporal when consensus is > 60s after message', async () => {
    const alerts: AuditAlert[] = [];
    await validateMintCrossCheck(
      baseMint(),
      baseTx({ consensusTimestamp: `${FAR_FUTURE_TS_BASE + 120}.0` }),
      decimalsCache,
      AGENT,
      alerts,
    );
    assert.equal(hasCategory(alerts, 'phantom_mint_temporal'), true);
  });
});

describe('R2-FG-3: validateMintCrossCheck (HTS)', () => {
  const decimalsCache = makeDecimalsCache({ [TOKEN_LAZY]: 1 });

  function baseMint() {
    return {
      sequence: 200,
      timestamp: ts(FAR_FUTURE_TS_BASE),
      depositTxId: '0.0.1@1700000000.000000002',
      user: USER,
      amount: 5,
      token: TOKEN_LAZY,
    };
  }

  it('emits no alerts on a clean LAZY mint with matching base units', async () => {
    const alerts: AuditAlert[] = [];
    await validateMintCrossCheck(
      baseMint(),
      {
        found: true,
        result: 'SUCCESS',
        consensusTimestamp: `${FAR_FUTURE_TS_BASE - 1}.0`,
        transfers: [],
        tokenTransfers: [
          { token_id: TOKEN_LAZY, account: USER, amount: -50 },
          { token_id: TOKEN_LAZY, account: AGENT, amount: 50 },
        ],
      },
      decimalsCache,
      AGENT,
      alerts,
    );
    assert.deepEqual(alerts, []);
  });

  it('flags phantom_mint_amount_mismatch when LAZY amount differs by magnitude', async () => {
    const alerts: AuditAlert[] = [];
    await validateMintCrossCheck(
      baseMint(),
      {
        found: true,
        result: 'SUCCESS',
        consensusTimestamp: `${FAR_FUTURE_TS_BASE - 1}.0`,
        transfers: [],
        tokenTransfers: [
          { token_id: TOKEN_LAZY, account: USER, amount: -500 },
          { token_id: TOKEN_LAZY, account: AGENT, amount: 500 },
        ],
      },
      decimalsCache,
      AGENT,
      alerts,
    );
    assert.equal(hasCategory(alerts, 'phantom_mint_amount_mismatch'), true);
  });

  it('flags phantom_mint when no token_transfer for the claimed token id', async () => {
    const alerts: AuditAlert[] = [];
    await validateMintCrossCheck(
      baseMint(),
      {
        found: true,
        result: 'SUCCESS',
        consensusTimestamp: `${FAR_FUTURE_TS_BASE - 1}.0`,
        transfers: [],
        tokenTransfers: [{ token_id: '0.0.9999', account: AGENT, amount: 50 }],
      },
      decimalsCache,
      AGENT,
      alerts,
    );
    assert.equal(hasCategory(alerts, 'phantom_mint'), true);
  });

  it('falls back to recipient-only check when decimals lookup returns null', async () => {
    const decimalsMissing = makeDecimalsCache({});
    const alerts: AuditAlert[] = [];
    await validateMintCrossCheck(
      baseMint(),
      {
        found: true,
        result: 'SUCCESS',
        consensusTimestamp: `${FAR_FUTURE_TS_BASE - 1}.0`,
        transfers: [],
        tokenTransfers: [{ token_id: TOKEN_LAZY, account: '0.0.9999', amount: 50 }],
      },
      decimalsMissing,
      AGENT,
      alerts,
    );
    assert.equal(hasCategory(alerts, 'phantom_mint_wrong_recipient'), true);
  });
});

describe('R2-FG-4: validateBurnCrossCheck (HBAR)', () => {
  const decimalsCache = makeDecimalsCache({ HBAR: HBAR_DECIMALS });

  function baseBurn() {
    return {
      sequence: 300,
      timestamp: ts(FAR_FUTURE_TS_BASE),
      withdrawTxId: '0.0.5000@1700000000.111111111',
      recipient: USER,
      amount: 2,
      token: 'HBAR',
      kind: 'user_withdrawal' as const,
    };
  }

  function cleanTx(overrides: Partial<MirrorTxResult> = {}): MirrorTxResult {
    return {
      found: true,
      result: 'SUCCESS',
      consensusTimestamp: `${FAR_FUTURE_TS_BASE - 1}.0`,
      transfers: [
        { account: AGENT, amount: -200_000_000 },
        { account: USER, amount: 200_000_000 },
      ],
      tokenTransfers: [],
      ...overrides,
    };
  }

  it('emits no alerts on a clean user withdrawal', async () => {
    const alerts: AuditAlert[] = [];
    await validateBurnCrossCheck(baseBurn(), cleanTx(), decimalsCache, AGENT, alerts);
    assert.deepEqual(alerts, []);
  });

  it('flags phantom_burn when mirror has no record', async () => {
    const alerts: AuditAlert[] = [];
    await validateBurnCrossCheck(baseBurn(), { found: false }, decimalsCache, AGENT, alerts);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.category, 'phantom_burn');
  });

  it('flags phantom_burn when result is FAIL_INVALID', async () => {
    const alerts: AuditAlert[] = [];
    await validateBurnCrossCheck(
      baseBurn(),
      cleanTx({ result: 'FAIL_INVALID' }),
      decimalsCache,
      AGENT,
      alerts,
    );
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.category, 'phantom_burn');
  });

  it('flags phantom_burn_amount_mismatch when claim does not match outflow', async () => {
    const alerts: AuditAlert[] = [];
    await validateBurnCrossCheck(
      baseBurn(),
      cleanTx({
        transfers: [
          { account: AGENT, amount: -100_000_000 },
          { account: USER, amount: 100_000_000 },
        ],
      }),
      decimalsCache,
      AGENT,
      alerts,
    );
    assert.equal(hasCategory(alerts, 'phantom_burn_amount_mismatch'), true);
  });

  it('flags phantom_burn_wrong_sender when --agent set but outflow came from another account', async () => {
    const alerts: AuditAlert[] = [];
    await validateBurnCrossCheck(
      baseBurn(),
      cleanTx({
        transfers: [
          { account: '0.0.9999', amount: -200_000_000 },
          { account: USER, amount: 200_000_000 },
        ],
      }),
      decimalsCache,
      AGENT,
      alerts,
    );
    assert.equal(hasCategory(alerts, 'phantom_burn_wrong_sender'), true);
  });

  it('flags phantom_burn when user_withdrawal recipient did not actually receive the funds', async () => {
    const alerts: AuditAlert[] = [];
    await validateBurnCrossCheck(
      baseBurn(),
      cleanTx({
        transfers: [
          { account: AGENT, amount: -200_000_000 },
          { account: '0.0.8888', amount: 200_000_000 },
        ],
      }),
      decimalsCache,
      AGENT,
      alerts,
    );
    assert.equal(hasCategory(alerts, 'phantom_burn'), true);
  });

  it('flags phantom_burn_inflow when topic claims a debit but tx is an inflow', async () => {
    const alerts: AuditAlert[] = [];
    await validateBurnCrossCheck(
      baseBurn(),
      cleanTx({ transfers: [{ account: AGENT, amount: 200_000_000 }] }),
      decimalsCache,
      AGENT,
      alerts,
    );
    assert.equal(hasCategory(alerts, 'phantom_burn_inflow'), true);
  });

  it('flags phantom_burn_temporal when on-chain consensus is far before the message', async () => {
    const alerts: AuditAlert[] = [];
    await validateBurnCrossCheck(
      baseBurn(),
      cleanTx({ consensusTimestamp: `${FAR_FUTURE_TS_BASE - 1000}.0` }),
      decimalsCache,
      AGENT,
      alerts,
    );
    assert.equal(hasCategory(alerts, 'phantom_burn_temporal'), true);
  });

  it('operator_withdrawal: only checks outflow exists when --agent is null', async () => {
    const alerts: AuditAlert[] = [];
    await validateBurnCrossCheck(
      {
        sequence: 301,
        timestamp: ts(FAR_FUTURE_TS_BASE),
        withdrawTxId: '0.0.5000@1700000000.111111112',
        recipient: null,
        amount: 1,
        token: 'HBAR',
        kind: 'operator_withdrawal',
      },
      {
        found: true,
        result: 'SUCCESS',
        consensusTimestamp: `${FAR_FUTURE_TS_BASE - 1}.0`,
        transfers: [
          { account: '0.0.7777', amount: -100_000_000 },
          { account: '0.0.8888', amount: 100_000_000 },
        ],
        tokenTransfers: [],
      },
      decimalsCache,
      null,
      alerts,
    );
    assert.deepEqual(alerts, []);
  });
});

describe('R2-FG-3 + R2-FG-4: MirrorTxCache parallelism + dedup', () => {
  it('dedups repeat fetches', async () => {
    let calls = 0;
    const cache = new MirrorTxCache(async (_id: string) => {
      calls++;
      return {
        found: true,
        result: 'SUCCESS',
        consensusTimestamp: '0.0',
        transfers: [],
        tokenTransfers: [],
      };
    });
    await Promise.all([cache.fetch('tx-1'), cache.fetch('tx-1'), cache.fetch('tx-1')]);
    assert.equal(calls, 1);
    assert.equal(cache.cacheHits, 2);
  });

  it('warmMany fetches each unique tx exactly once and respects concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const cache = new MirrorTxCache(async (_id: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return {
        found: true,
        result: 'SUCCESS',
        consensusTimestamp: '0.0',
        transfers: [],
        tokenTransfers: [],
      };
    });
    const ids = Array.from({ length: 25 }, (_, i) => `tx-${i}`);
    await cache.warmMany([...ids, ...ids], 5);
    assert.ok(maxInFlight <= 5, `expected <=5 concurrent, saw ${maxInFlight}`);
    assert.ok(maxInFlight >= 2, `expected some parallelism, saw ${maxInFlight}`);
  });
});
