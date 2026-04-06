import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapPoolSummary,
  mapPoolDetail,
  mapEvCalculation,
  mapUserState,
  mapSystemInfo,
} from './client.js';

// ── mapPoolSummary ──────────────────────────────────────────────

describe('mapPoolSummary', () => {
  it('maps raw.poolId to poolId', () => {
    const result = mapPoolSummary({ poolId: 7, name: 'Test' });
    assert.equal(result.poolId, 7);
  });

  it('falls back to raw.id when poolId is missing', () => {
    const result = mapPoolSummary({ id: 42, name: 'Test' });
    assert.equal(result.poolId, 42);
  });

  it('defaults poolId to 0 when both are missing', () => {
    const result = mapPoolSummary({});
    assert.equal(result.poolId, 0);
  });

  it('prefers displayInfo.name over raw.name', () => {
    const result = mapPoolSummary({
      poolId: 1,
      name: 'raw-name',
      displayInfo: { name: 'display-name' },
    });
    assert.equal(result.name, 'display-name');
  });

  it('falls back to raw.name when displayInfo is absent', () => {
    const result = mapPoolSummary({ poolId: 1, name: 'raw-name' });
    assert.equal(result.name, 'raw-name');
  });

  it('generates fallback name from poolId when no name fields exist', () => {
    const result = mapPoolSummary({ poolId: 5 });
    assert.equal(result.name, 'Pool #5');
  });

  it('maps all numeric and boolean fields with defaults', () => {
    const result = mapPoolSummary({});
    assert.equal(result.winRatePercent, 0);
    assert.equal(result.entryFee, 0);
    assert.equal(result.feeTokenSymbol, 'HBAR');
    assert.equal(result.prizeCount, 0);
    assert.equal(result.outstandingEntries, 0);
    assert.equal(result.paused, false);
    assert.equal(result.closed, false);
    assert.equal(result.trustLevel, null);
  });

  it('preserves explicit field values', () => {
    const result = mapPoolSummary({
      poolId: 10,
      name: 'Full Pool',
      winRatePercent: 25,
      entryFee: 100,
      feeTokenSymbol: 'LAZY',
      prizeCount: 5,
      outstandingEntries: 50,
      paused: true,
      closed: true,
      displayInfo: { trustLevel: 'verified' },
    });
    assert.equal(result.winRatePercent, 25);
    assert.equal(result.entryFee, 100);
    assert.equal(result.feeTokenSymbol, 'LAZY');
    assert.equal(result.prizeCount, 5);
    assert.equal(result.outstandingEntries, 50);
    assert.equal(result.paused, true);
    assert.equal(result.closed, true);
    assert.equal(result.trustLevel, 'verified');
  });

  it('reads trustLevel from displayInfo', () => {
    const result = mapPoolSummary({
      poolId: 1,
      displayInfo: { trustLevel: 'community' },
    });
    assert.equal(result.trustLevel, 'community');
  });
});

// ── mapPoolDetail ───────────────────────────────────────────────

describe('mapPoolDetail', () => {
  it('inherits all PoolSummary fields via mapPoolSummary', () => {
    const result = mapPoolDetail({
      poolId: 3,
      name: 'Detail Pool',
      winRatePercent: 10,
    });
    assert.equal(result.poolId, 3);
    assert.equal(result.name, 'Detail Pool');
    assert.equal(result.winRatePercent, 10);
  });

  it('maps feeTokenId from raw.feeTokenId', () => {
    const result = mapPoolDetail({
      poolId: 1,
      feeTokenId: '0.0.12345',
    });
    assert.equal(result.feeTokenId, '0.0.12345');
  });

  it('feeTokenHederaId takes precedence when feeTokenId is missing', () => {
    const result = mapPoolDetail({
      poolId: 1,
      feeTokenHederaId: '0.0.67890',
    });
    assert.equal(result.feeTokenId, '0.0.67890');
  });

  it('feeTokenId takes precedence over feeTokenHederaId when both present', () => {
    const result = mapPoolDetail({
      poolId: 1,
      feeTokenId: '0.0.11111',
      feeTokenHederaId: '0.0.22222',
    });
    // feeTokenId is checked first via ?? chain: raw.feeTokenId ?? raw.feeTokenHederaId
    assert.equal(result.feeTokenId, '0.0.11111');
  });

  it('maps HBAR fee token to empty string', () => {
    const result = mapPoolDetail({
      poolId: 1,
      feeTokenId: 'HBAR',
    });
    assert.equal(result.feeTokenId, '');
  });

  it('defaults to empty string (HBAR) when no fee token fields present', () => {
    const result = mapPoolDetail({ poolId: 1 });
    // Defaults: raw.feeTokenId ?? raw.feeTokenHederaId ?? 'HBAR' -> 'HBAR' -> ''
    assert.equal(result.feeTokenId, '');
  });

  it('maps detail-specific fields with defaults', () => {
    const result = mapPoolDetail({});
    assert.equal(result.owner, '');
    assert.equal(result.platformFeePercent, 0);
    assert.equal(result.ticketCID, '');
    assert.equal(result.winCID, '');
  });

  it('preserves explicit detail-specific values', () => {
    const result = mapPoolDetail({
      poolId: 1,
      owner: '0.0.99999',
      platformFeePercent: 5,
      ticketCID: 'QmTicket',
      winCID: 'QmWin',
      feeTokenId: '0.0.54321',
    });
    assert.equal(result.owner, '0.0.99999');
    assert.equal(result.platformFeePercent, 5);
    assert.equal(result.ticketCID, 'QmTicket');
    assert.equal(result.winCID, 'QmWin');
    assert.equal(result.feeTokenId, '0.0.54321');
  });
});

// ── mapEvCalculation ────────────────────────────────────────────

describe('mapEvCalculation', () => {
  it('maps effectiveWinRate directly when provided as decimal', () => {
    const result = mapEvCalculation({
      poolId: 1,
      effectiveWinRate: 0.25,
    });
    assert.equal(result.effectiveWinRate, 0.25);
  });

  it('converts effectiveWinRatePercent to decimal when effectiveWinRate is missing', () => {
    const result = mapEvCalculation({
      poolId: 1,
      effectiveWinRatePercent: 25,
    });
    assert.equal(result.effectiveWinRate, 0.25);
  });

  it('prefers effectiveWinRate over effectiveWinRatePercent when both present', () => {
    const result = mapEvCalculation({
      poolId: 1,
      effectiveWinRate: 0.10,
      effectiveWinRatePercent: 50,
    });
    assert.equal(result.effectiveWinRate, 0.10);
  });

  it('defaults effectiveWinRate to 0 when neither field present', () => {
    const result = mapEvCalculation({ poolId: 1 });
    assert.equal(result.effectiveWinRate, 0);
  });

  it('maps expectedValue from raw.expectedValue', () => {
    const result = mapEvCalculation({
      poolId: 1,
      expectedValue: 1.5,
    });
    assert.equal(result.expectedValue, 1.5);
  });

  it('falls back to fungibleEvPerEntry for expectedValue', () => {
    const result = mapEvCalculation({
      poolId: 1,
      fungibleEvPerEntry: 2.3,
    });
    assert.equal(result.expectedValue, 2.3);
  });

  it('prefers expectedValue over fungibleEvPerEntry', () => {
    const result = mapEvCalculation({
      poolId: 1,
      expectedValue: 1.0,
      fungibleEvPerEntry: 9.9,
    });
    assert.equal(result.expectedValue, 1.0);
  });

  it('maps avgPrizeValue from prizeBreakdown.avgFungiblePrizeValue fallback', () => {
    const result = mapEvCalculation({
      poolId: 1,
      prizeBreakdown: { avgFungiblePrizeValue: 500 },
    });
    assert.equal(result.avgPrizeValue, 500);
  });

  it('prefers direct avgPrizeValue over prizeBreakdown', () => {
    const result = mapEvCalculation({
      poolId: 1,
      avgPrizeValue: 100,
      prizeBreakdown: { avgFungiblePrizeValue: 500 },
    });
    assert.equal(result.avgPrizeValue, 100);
  });

  it('defaults all fields to 0 or empty string', () => {
    const result = mapEvCalculation({});
    assert.equal(result.poolId, 0);
    assert.equal(result.entryCost, 0);
    assert.equal(result.effectiveWinRate, 0);
    assert.equal(result.avgPrizeValue, 0);
    assert.equal(result.expectedValue, 0);
    assert.equal(result.recommendation, '');
  });

  it('preserves all explicit values', () => {
    const result = mapEvCalculation({
      poolId: 5,
      entryCost: 10,
      effectiveWinRate: 0.5,
      avgPrizeValue: 200,
      expectedValue: 100,
      recommendation: '+EV: play',
    });
    assert.equal(result.poolId, 5);
    assert.equal(result.entryCost, 10);
    assert.equal(result.effectiveWinRate, 0.5);
    assert.equal(result.avgPrizeValue, 200);
    assert.equal(result.expectedValue, 100);
    assert.equal(result.recommendation, '+EV: play');
  });
});

// ── mapUserState ────────────────────────────────────────────────

describe('mapUserState', () => {
  it('converts entriesByPool array to Record using entries field', () => {
    const result = mapUserState({
      entriesByPool: [
        { poolId: 1, entries: 5 },
        { poolId: 2, entries: 10 },
      ],
    });
    assert.deepEqual(result.entriesByPool, { 1: 5, 2: 10 });
  });

  it('converts entriesByPool array using count field as fallback', () => {
    const result = mapUserState({
      entriesByPool: [
        { poolId: 3, count: 7 },
      ],
    });
    assert.deepEqual(result.entriesByPool, { 3: 7 });
  });

  it('prefers entries over count in array items', () => {
    const result = mapUserState({
      entriesByPool: [
        { poolId: 1, entries: 5, count: 99 },
      ],
    });
    assert.deepEqual(result.entriesByPool, { 1: 5 });
  });

  it('defaults to 0 when neither entries nor count present in array item', () => {
    const result = mapUserState({
      entriesByPool: [{ poolId: 4 }],
    });
    assert.deepEqual(result.entriesByPool, { 4: 0 });
  });

  it('passes through entriesByPool when already a Record (object)', () => {
    const record = { 1: 3, 2: 8 };
    const result = mapUserState({ entriesByPool: record });
    assert.deepEqual(result.entriesByPool, { 1: 3, 2: 8 });
  });

  it('defaults entriesByPool to empty object when missing', () => {
    const result = mapUserState({});
    assert.deepEqual(result.entriesByPool, {});
  });

  it('defaults entriesByPool to empty object when null', () => {
    const result = mapUserState({ entriesByPool: null });
    assert.deepEqual(result.entriesByPool, {});
  });

  it('maps pendingPrizesCount and pendingPrizes with defaults', () => {
    const result = mapUserState({});
    assert.equal(result.pendingPrizesCount, 0);
    assert.deepEqual(result.pendingPrizes, []);
  });

  it('normalizes pending prizes to the PendingPrize shape', () => {
    // Raw dApp MCP response shape
    const result = mapUserState({
      pendingPrizesCount: 2,
      pendingPrizes: [
        {
          poolId: 0,
          asNFT: false,
          fungiblePrize: { token: 'HBAR', amount: 50 },
          nfts: [{ token: 'WF', hederaId: '0.0.8221452', serials: [15] }],
        },
        {
          poolId: 1,
          asNFT: false,
          fungiblePrize: { token: 'LAZY', amount: 100 },
          nfts: [],
        },
      ],
    });
    assert.equal(result.pendingPrizesCount, 2);
    assert.equal(result.pendingPrizes.length, 2);
    assert.equal(result.pendingPrizes[0]!.poolId, 0);
    assert.equal(result.pendingPrizes[0]!.fungiblePrize.amount, 50);
    assert.equal(result.pendingPrizes[0]!.nfts.length, 1);
    assert.equal(result.pendingPrizes[0]!.nfts[0]!.token, 'WF');
    assert.equal(result.pendingPrizes[0]!.nfts[0]!.hederaId, '0.0.8221452');
    assert.deepEqual(result.pendingPrizes[0]!.nfts[0]!.serials, [15]);
    assert.equal(result.pendingPrizes[1]!.nfts.length, 0);
  });

  it('tolerates missing fields on raw pending prizes', () => {
    const result = mapUserState({
      pendingPrizesCount: 1,
      pendingPrizes: [{ poolId: 2 }], // missing fungiblePrize, nfts
    });
    assert.equal(result.pendingPrizes.length, 1);
    assert.equal(result.pendingPrizes[0]!.poolId, 2);
    assert.equal(result.pendingPrizes[0]!.fungiblePrize.token, 'HBAR');
    assert.equal(result.pendingPrizes[0]!.fungiblePrize.amount, 0);
    assert.deepEqual(result.pendingPrizes[0]!.nfts, []);
  });

  it('defaults boost to 0', () => {
    const result = mapUserState({});
    assert.equal(result.boost, 0);
  });

  it('preserves numeric boost', () => {
    const result = mapUserState({ boost: 500 });
    assert.equal(result.boost, 500);
  });

  it('preserves object boost with rawBps and percent', () => {
    const boost = { rawBps: 250, percent: 2.5 };
    const result = mapUserState({ boost });
    assert.deepEqual(result.boost, { rawBps: 250, percent: 2.5 });
  });

  it('handles empty array for entriesByPool', () => {
    const result = mapUserState({ entriesByPool: [] });
    assert.deepEqual(result.entriesByPool, {});
  });
});

// ── mapSystemInfo ───────────────────────────────────────────────

describe('mapSystemInfo', () => {
  it('maps v2 wire format (contractAddresses + string lazyToken)', () => {
    const result = mapSystemInfo({
      contractAddresses: {
        lazyLotto: '0.0.100',
        storage: '0.0.101',
        poolManager: '0.0.102',
        gasStation: '0.0.103',
      },
      lazyToken: '0.0.200',
      network: 'mainnet',
      totalPools: 15,
    });
    assert.equal(result.contractAddresses.lazyLotto, '0.0.100');
    assert.equal(result.contractAddresses.storage, '0.0.101');
    assert.equal(result.contractAddresses.poolManager, '0.0.102');
    assert.equal(result.contractAddresses.gasStation, '0.0.103');
    assert.equal(result.lazyToken, '0.0.200');
    assert.equal(result.lazyDecimals, 1);
    assert.equal(result.network, 'mainnet');
    assert.equal(result.totalPools, 15);
  });

  it('maps v1 wire format (contracts + tokens)', () => {
    const result = mapSystemInfo({
      contracts: {
        lazyLotto: '0.0.500',
        storage: '0.0.501',
        poolManager: '0.0.502',
        gasStation: '0.0.503',
      },
      tokens: {
        lazy: '0.0.600',
        lazyDecimals: 1,
      },
      network: 'testnet',
      totalPools: 3,
    });
    assert.equal(result.contractAddresses.lazyLotto, '0.0.500');
    assert.equal(result.contractAddresses.storage, '0.0.501');
    assert.equal(result.contractAddresses.poolManager, '0.0.502');
    assert.equal(result.contractAddresses.gasStation, '0.0.503');
    assert.equal(result.lazyToken, '0.0.600');
    assert.equal(result.lazyDecimals, 1);
    assert.equal(result.network, 'testnet');
    assert.equal(result.totalPools, 3);
  });

  it('handles lazyToken as object with id and decimals', () => {
    const result = mapSystemInfo({
      lazyToken: { id: '0.0.300', decimals: 1 },
    });
    assert.equal(result.lazyToken, '0.0.300');
    assert.equal(result.lazyDecimals, 1);
  });

  it('handles lazyToken object with missing decimals (defaults to 1)', () => {
    const result = mapSystemInfo({
      lazyToken: { id: '0.0.300' },
    });
    assert.equal(result.lazyToken, '0.0.300');
    assert.equal(result.lazyDecimals, 1);
  });

  it('prefers contractAddresses over contracts when both present', () => {
    const result = mapSystemInfo({
      contractAddresses: { lazyLotto: '0.0.AAA' },
      contracts: { lazyLotto: '0.0.BBB' },
    });
    assert.equal(result.contractAddresses.lazyLotto, '0.0.AAA');
  });

  it('defaults all fields when input is empty', () => {
    const result = mapSystemInfo({});
    assert.equal(result.contractAddresses.lazyLotto, '');
    assert.equal(result.contractAddresses.storage, '');
    assert.equal(result.contractAddresses.poolManager, '');
    assert.equal(result.contractAddresses.gasStation, '');
    assert.equal(result.lazyToken, '');
    assert.equal(result.lazyDecimals, 1);
    assert.equal(result.network, '');
    assert.equal(result.totalPools, 0);
  });

  it('v1 tokens.lazyDecimals is used when lazyToken is not an object', () => {
    const result = mapSystemInfo({
      tokens: { lazy: '0.0.700', lazyDecimals: 8 },
    });
    assert.equal(result.lazyToken, '0.0.700');
    assert.equal(result.lazyDecimals, 8);
  });

  it('lazyToken object decimals takes precedence over tokens.lazyDecimals', () => {
    const result = mapSystemInfo({
      lazyToken: { id: '0.0.800', decimals: 3 },
      tokens: { lazyDecimals: 8 },
    });
    assert.equal(result.lazyDecimals, 3);
  });
});
