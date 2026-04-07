import type { Strategy } from './strategy.js';

export const HEDERA_DEFAULTS = {
  mirrorNodeUrl: {
    testnet: 'https://testnet.mirrornode.hedera.com/api/v1',
    mainnet: 'https://mainnet.mirrornode.hedera.com/api/v1',
  },
  mirrorNodeDelay: 4_000,
  gasMultiplier: 1.5,
  lazyDecimals: 1,
} as const;

export const GAS_ESTIMATES = {
  buyEntry: { base: 350_000, perUnit: 150_000 },
  buyAndRollEntry: { base: 750_000, perUnit: 610_000 },
  buyAndRedeemEntry: { base: 400_000, perUnit: 200_000 },
  rollAll: { base: 400_000, perUnit: 400_000 },
  rollBatch: { base: 400_000, perUnit: 400_000 },
  claimAllPrizes: { base: 500_000, perUnit: 0 },
  /**
   * transferPendingPrizes(owner, count) loops over the caller's pending
   * prizes and rewrites the owner field in contract storage for each one,
   * plus emits an event per prize. Storage writes dominate the cost.
   *
   * The original 500K base with perUnit:0 was correct for "single prize"
   * sessions but failed with INSUFFICIENT_GAS the moment a session won
   * more than ~2 prizes. Discovered in production when a real user's
   * winnings got stranded in the agent wallet — see
   * src/agent/LottoAgent.ts safeTransferPrizes for the retry ladder.
   *
   * 225K per prize is the first-attempt budget; the retry escalator in
   * LottoAgent bumps it to 300K then 400K per prize on subsequent
   * attempts. Capped at 14M (slightly under maxGas 14.5M) so we don't
   * accidentally hit Hedera's per-transaction maximum.
   */
  transferPendingPrizes: { base: 500_000, perUnit: 225_000 },
  maxGas: 14_500_000,
} as const;

/**
 * Per-prize gas escalation ladder for transferPendingPrizes retries.
 * Used by LottoAgent.safeTransferPrizes and the operator recovery tool.
 * Each attempt uses base + perPrize[attemptIndex] * count, capped at
 * maxRetryGas to avoid Hedera per-transaction overflow.
 */
export const PRIZE_TRANSFER_RETRY = {
  attempts: [
    { perPrize: 225_000 },
    { perPrize: 300_000 },
    { perPrize: 400_000 },
  ],
  baseGas: 500_000,
  maxRetryGas: 14_000_000,
} as const;

export const DEFAULT_STRATEGY: Strategy = {
  name: 'balanced',
  version: '0.2',
  description: 'Mixed pools, moderate entries, reasonable budget',
  poolFilter: {
    type: 'all',
    feeToken: 'any',
    minPrizeCount: 1,
  },
  budget: {
    tokenBudgets: {
      hbar: { maxPerSession: 100, maxPerPool: 40, reserve: 10 },
    },
    maxEntriesPerPool: 5,
  },
  playStyle: {
    action: 'buy_and_roll',
    entriesPerBatch: 1,
    minExpectedValue: -Infinity,
    transferToOwner: true,
    preferNftPrizes: false,
  },
  schedule: {
    enabled: false,
    cron: '0 */6 * * *',
    maxSessionsPerDay: 4,
  },
};
