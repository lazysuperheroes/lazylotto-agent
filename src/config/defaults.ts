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
  transferPendingPrizes: { base: 500_000, perUnit: 0 },
  maxGas: 14_500_000,
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
