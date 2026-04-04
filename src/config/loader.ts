/**
 * Shared strategy loading — single source of truth.
 *
 * Used by index.ts, NegotiationHandler, and MCP tools.
 * Ensures resolveTokenAliases is always applied.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StrategySchema, type Strategy } from './strategy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BUILT_IN = ['conservative', 'balanced', 'aggressive'];

/**
 * Resolve "lazy" alias in tokenBudgets to the actual LAZY_TOKEN_ID from env.
 */
export function resolveTokenAliases(strategy: Strategy): Strategy {
  const lazyTokenId = process.env.LAZY_TOKEN_ID;
  const budgets = strategy.budget.tokenBudgets;

  if (budgets['lazy'] && !lazyTokenId) {
    console.warn(
      '[Config] Strategy uses "lazy" token budget but LAZY_TOKEN_ID is not set in .env. ' +
        'LAZY pools will be skipped because the budget key cannot be resolved.'
    );
    return strategy;
  }

  if (!lazyTokenId) return strategy;
  if (!budgets['lazy']) return strategy;

  const resolved = { ...budgets };
  resolved[lazyTokenId] = resolved['lazy'];
  delete resolved['lazy'];

  return {
    ...strategy,
    budget: { ...strategy.budget, tokenBudgets: resolved },
  };
}

// Built-in strategies inlined for serverless environments where the
// strategies/ directory is not available on the filesystem.
const INLINE_STRATEGIES: Record<string, unknown> = {
  conservative: {"name":"conservative","version":"0.2","description":"Low risk. Targets high win rate pools only (10%+). Small batches, tight budget, generous reserve. Suitable for cautious users or smaller balances.","poolFilter":{"type":"all","minWinRate":10,"feeToken":"any","minPrizeCount":1},"budget":{"tokenBudgets":{"hbar":{"maxPerSession":25,"maxPerPool":10,"reserve":20},"lazy":{"maxPerSession":100,"maxPerPool":40,"reserve":30}},"maxEntriesPerPool":3},"playStyle":{"action":"buy_and_roll","entriesPerBatch":1,"minExpectedValue":-5,"transferToOwner":true,"preferNftPrizes":false},"schedule":{"enabled":false,"cron":"0 */8 * * *","maxSessionsPerDay":3}},
  balanced: {"name":"balanced","version":"0.2","description":"Moderate risk. Plays all pool types with a reasonable EV threshold. Good default for most users and deposit sizes.","poolFilter":{"type":"all","feeToken":"any","minPrizeCount":1},"budget":{"tokenBudgets":{"hbar":{"maxPerSession":100,"maxPerPool":40,"reserve":10},"lazy":{"maxPerSession":500,"maxPerPool":200,"reserve":50}},"maxEntriesPerPool":5},"playStyle":{"action":"buy_and_roll","entriesPerBatch":2,"minExpectedValue":-20,"transferToOwner":true,"preferNftPrizes":false},"schedule":{"enabled":false,"cron":"0 */6 * * *","maxSessionsPerDay":4}},
  aggressive: {"name":"aggressive","version":"0.2","description":"Higher risk. Targets prize-rich pools (2+ prizes), larger batches, looser EV threshold. For users with larger balances chasing big wins.","poolFilter":{"type":"all","feeToken":"any","minPrizeCount":2},"budget":{"tokenBudgets":{"hbar":{"maxPerSession":500,"maxPerPool":200,"reserve":5},"lazy":{"maxPerSession":2000,"maxPerPool":800,"reserve":25}},"usd":{"maxPerSession":100},"maxEntriesPerPool":20},"playStyle":{"action":"buy_and_roll","entriesPerBatch":5,"minExpectedValue":-100,"transferToOwner":true,"preferNftPrizes":false,"stopOnWins":3},"schedule":{"enabled":false,"cron":"0 */4 * * *","maxSessionsPerDay":6}},
};

/**
 * Load and validate a strategy by name or file path.
 * Always applies resolveTokenAliases.
 *
 * Built-in strategies are tried from the filesystem first (CLI), then
 * from inlined copies (serverless where strategies/ doesn't exist).
 */
export function loadStrategy(name: string): Strategy {
  if (BUILT_IN.includes(name)) {
    // Try filesystem first (CLI / local dev)
    try {
      const path = resolve(__dirname, '..', '..', 'strategies', `${name}.json`);
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      return resolveTokenAliases(StrategySchema.parse(raw));
    } catch {
      // Fallback to inlined strategy (serverless)
      const raw = INLINE_STRATEGIES[name];
      if (raw) return resolveTokenAliases(StrategySchema.parse(raw));
      throw new Error(`Built-in strategy "${name}" not found on filesystem or inline`);
    }
  }

  // Treat as file path
  const raw = JSON.parse(readFileSync(resolve(name), 'utf-8'));
  return resolveTokenAliases(StrategySchema.parse(raw));
}
