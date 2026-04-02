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

/**
 * Load and validate a strategy by name or file path.
 * Always applies resolveTokenAliases.
 */
export function loadStrategy(name: string): Strategy {
  if (BUILT_IN.includes(name)) {
    const path = resolve(__dirname, '..', '..', 'strategies', `${name}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return resolveTokenAliases(StrategySchema.parse(raw));
  }

  // Treat as file path
  const raw = JSON.parse(readFileSync(resolve(name), 'utf-8'));
  return resolveTokenAliases(StrategySchema.parse(raw));
}
