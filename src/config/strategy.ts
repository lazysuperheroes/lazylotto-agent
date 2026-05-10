import { z } from 'zod';

// R4-FG-22 (round-4 high): Zod's `nonnegative()` and `positive()`
// accept `NaN` AND `Infinity`. With NaN budgets, BudgetManager.
// remainingFor returns NaN, canAfford returns false everywhere →
// silent strategy DoS for that user. With Infinity reservation, the
// play loop tries to buy Infinity entries; the Hedera SDK throws
// AFTER the reservation is held → leaked reservation. Wrap every
// numeric leaf in `.refine(Number.isFinite)` to refuse both at
// schema load — defensive, not a migration of existing files.
// Zod v4 dropped the `ZodEffects` export from the classic path; let TS
// infer the return type from `.refine(...)` so this stays portable
// across Zod major versions.
const finiteNumber = (base: z.ZodNumber = z.number()) =>
  base.refine(Number.isFinite, { message: 'must be a finite number (no NaN/Infinity)' });

// ── Token Budget ──────────────────────────────────────────────
// Per-token spending limits. Keys in the parent record are token IDs
// (e.g., "0.0.8011209") or "hbar" for the native token.

export const TokenBudgetSchema = z.object({
  maxPerSession: finiteNumber(z.number().nonnegative()),
  maxPerPool: finiteNumber(z.number().nonnegative()),
  reserve: finiteNumber(z.number().nonnegative()).default(0),
});

export const BudgetSchema = z
  .object({
    /** Token ID → budget limits. "hbar" for native HBAR, token IDs for FTs. */
    tokenBudgets: z.record(z.string(), TokenBudgetSchema),
    /** Optional USD session cap. Requires price oracle. */
    usd: z.object({
      maxPerSession: finiteNumber(z.number().positive()),
      /** If true, block play when price is unavailable. Default false (fail-open). */
      failClosed: z.boolean().default(false),
    }).optional(),
    maxEntriesPerPool: z.number().int().positive().default(10),
  })
  .refine((d) => Object.keys(d.tokenBudgets).length > 0, {
    message: 'At least one token budget must be defined',
  });

// ── Pool Filter ───────────────────────────────────────────────

/**
 * Pool fee-token filter. Three forms:
 *   - `'any'` — match any pool regardless of fee token (default)
 *   - `'HBAR'` / `'LAZY'` — single-token filter, backward compat
 *   - `['HBAR', 'LAZY']` — explicit allow-list, both allowed
 *
 * The array form is used when a user has positive balance in
 * multiple tokens and wants the play loop to consider pools in
 * any of them. `MultiUserAgent.playForUser` builds this dynamically
 * from the user's actual token balances. Writing the array form
 * to a strategy JSON file is also valid.
 */
export const FeeTokenFilterSchema = z.union([
  z.enum(['HBAR', 'LAZY', 'any']),
  z.array(z.enum(['HBAR', 'LAZY'])).min(1),
]);

export const PoolFilterSchema = z.object({
  type: z.enum(['all', 'global', 'community']).default('all'),
  minWinRate: finiteNumber(z.number().min(0).max(100)).optional(),
  maxEntryFee: finiteNumber(z.number().positive()).optional(),
  /** Filter by fee token symbol for pool discovery. Symbols are fine here
   *  since this is a pre-filter on MCP data (which returns symbols).
   *  See FeeTokenFilterSchema for the supported shapes. */
  feeToken: FeeTokenFilterSchema.default('any'),
  minPrizeCount: z.number().int().nonnegative().default(1),
});

/**
 * Check whether a pool's fee token symbol matches a feeToken filter
 * value. Handles all three shapes: 'any', single symbol, and array.
 */
export function matchesFeeTokenFilter(
  filter: 'HBAR' | 'LAZY' | 'any' | ('HBAR' | 'LAZY')[],
  poolFeeTokenSymbol: string,
): boolean {
  if (filter === 'any') return true;
  if (Array.isArray(filter)) {
    return filter.includes(poolFeeTokenSymbol as 'HBAR' | 'LAZY');
  }
  return poolFeeTokenSymbol === filter;
}

// ── Play Style ────────────────────────────────────────────────

export const PlayStyleSchema = z.object({
  action: z
    .enum(['buy', 'buy_and_roll', 'buy_and_redeem'])
    .default('buy_and_roll'),
  entriesPerBatch: z.number().int().positive().default(1),
  // R4-FG-22: minExpectedValue allows -Infinity intentionally as a
  // sentinel — null lower bound — but rejects NaN. Don't apply
  // finiteNumber here; do refine to reject NaN.
  minExpectedValue: z
    .number()
    .refine((n) => !Number.isNaN(n), { message: 'minExpectedValue cannot be NaN' })
    .default(-Infinity),
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
export type FeeTokenFilter = z.infer<typeof FeeTokenFilterSchema>;
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
