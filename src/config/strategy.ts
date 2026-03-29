import { z } from 'zod';

export const PoolFilterSchema = z.object({
  type: z.enum(['all', 'global', 'community']).default('all'),
  minWinRate: z.number().min(0).max(100).optional(),
  maxEntryFee: z.number().positive().optional(),
  feeToken: z.enum(['HBAR', 'LAZY', 'any']).default('any'),
  minPrizeCount: z.number().int().nonnegative().default(1),
});

export const BudgetSchema = z.object({
  maxSpendPerSession: z.number().positive(),
  maxSpendPerPool: z.number().positive(),
  maxEntriesPerPool: z.number().int().positive().default(10),
  reserveBalance: z.number().nonnegative().default(5),
  currency: z.enum(['HBAR', 'LAZY']).default('LAZY'),
});

export const PlayStyleSchema = z.object({
  action: z.enum(['buy', 'buy_and_roll', 'buy_and_redeem']).default('buy_and_roll'),
  entriesPerBatch: z.number().int().positive().default(1),
  minExpectedValue: z.number().default(-Infinity),
  claimImmediately: z.boolean().default(true),
  transferToOwner: z.boolean().default(true),
  ownerAddress: z.string().optional(),
});

export const ScheduleSchema = z.object({
  enabled: z.boolean().default(false),
  cron: z.string().default('0 */6 * * *'),
  maxSessionsPerDay: z.number().int().positive().default(4),
});

export const StrategySchema = z.object({
  name: z.string(),
  version: z.string().default('1.0.0'),
  description: z.string().optional(),
  poolFilter: PoolFilterSchema,
  budget: BudgetSchema,
  playStyle: PlayStyleSchema,
  schedule: ScheduleSchema.default({
    enabled: false,
    cron: '0 */6 * * *',
    maxSessionsPerDay: 4,
  }),
});

export type Strategy = z.infer<typeof StrategySchema>;
export type PoolFilter = z.infer<typeof PoolFilterSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
export type PlayStyle = z.infer<typeof PlayStyleSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
