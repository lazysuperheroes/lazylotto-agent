import { z } from 'zod';

// ── Token Budget ──────────────────────────────────────────────
// Per-token spending limits. Keys in the parent record are token IDs
// (e.g., "0.0.8011209") or "hbar" for the native token.

export const TokenBudgetSchema = z.object({
  maxPerSession: z.number().nonnegative(),
  maxPerPool: z.number().nonnegative(),
  reserve: z.number().nonnegative().default(0),
});

export const BudgetSchema = z
  .object({
    /** Token ID → budget limits. "hbar" for native HBAR, token IDs for FTs. */
    tokenBudgets: z.record(z.string(), TokenBudgetSchema),
    /** Optional USD session cap. Requires price oracle. */
    usd: z.object({
      maxPerSession: z.number().positive(),
      /** If true, block play when price is unavailable. Default false (fail-open). */
      failClosed: z.boolean().default(false),
    }).optional(),
    maxEntriesPerPool: z.number().int().positive().default(10),
  })
  .refine((d) => Object.keys(d.tokenBudgets).length > 0, {
    message: 'At least one token budget must be defined',
  });

// ── Pool Filter ───────────────────────────────────────────────

export const PoolFilterSchema = z.object({
  type: z.enum(['all', 'global', 'community']).default('all'),
  minWinRate: z.number().min(0).max(100).optional(),
  maxEntryFee: z.number().positive().optional(),
  /** Filter by fee token symbol for pool discovery. Symbols are fine here
   *  since this is a pre-filter on MCP data (which returns symbols). */
  feeToken: z.enum(['HBAR', 'LAZY', 'any']).default('any'),
  minPrizeCount: z.number().int().nonnegative().default(1),
});

// ── Play Style ────────────────────────────────────────────────

export const PlayStyleSchema = z.object({
  action: z
    .enum(['buy', 'buy_and_roll', 'buy_and_redeem'])
    .default('buy_and_roll'),
  entriesPerBatch: z.number().int().positive().default(1),
  minExpectedValue: z.number().default(-Infinity),
  transferToOwner: z.boolean().default(true),
  ownerAddress: z.string().optional(),
  /** Boost score for pools with NFT prizes */
  preferNftPrizes: z.boolean().default(false),
  /** Boost score for pools offering these specific tokens */
  targetTokenIds: z.array(z.string()).optional(),
  /** Stop the session after winning this many prizes */
  stopOnWins: z.number().int().positive().optional(),
});

// ── Schedule ──────────────────────────────────────────────────

export const ScheduleSchema = z.object({
  enabled: z.boolean().default(false),
  cron: z.string().default('0 */6 * * *'),
  maxSessionsPerDay: z.number().int().positive().default(4),
});

// ── Strategy ──────────────────────────────────────────────────

export const StrategySchema = z.object({
  name: z.string(),
  version: z.string().default('0.2'),
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
export type TokenBudget = z.infer<typeof TokenBudgetSchema>;
export type PlayStyle = z.infer<typeof PlayStyleSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;

// ── Helpers ───────────────────────────────────────────────────

/** Sentinel key for native HBAR in tokenBudgets */
export const HBAR_TOKEN_KEY = 'hbar';

/** Resolve a pool's fee token to a budget key.
 *  HBAR pools have null/empty feeTokenId → "hbar".
 *  FT pools use the token ID directly. */
export function resolveBudgetKey(feeTokenId: string | null | undefined): string {
  return feeTokenId || HBAR_TOKEN_KEY;
}
