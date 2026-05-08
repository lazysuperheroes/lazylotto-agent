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
    const path = resolve(__dirname, '..', '..', 'strategies', `${name}.json`);
    let fileExists = false;
    try {
      const fileRaw = readFileSync(path, 'utf-8');
      fileExists = true;
      try {
        const parsed = JSON.parse(fileRaw);
        return resolveTokenAliases(StrategySchema.parse(parsed));
      } catch (parseErr) {
        // R5-FG-100 (R4-FG-76 deferral): parse failure on a built-in
        // file should NOT silently fall through to inline. Pre-fix
        // R4-FG-76 deferred this; the bug was that an operator
        // editing strategies/balanced.json with a typo (or a future
        // schema bump that the inline copy is ahead of) saw the
        // inline copy's behavior instead of their edits, with no
        // warning. Now: warn loudly so the fall-through to inline
        // is visible.
        console.warn(
          `[loadStrategy] WARNING: strategies/${name}.json EXISTS but failed to parse: ` +
            `${parseErr instanceof Error ? parseErr.message : String(parseErr)}. ` +
            `Falling back to inlined strategy. Operator edits to the file will be IGNORED ` +
            `until the parse error is fixed.`,
        );
      }
    } catch {
      // ENOENT / read-failure — silent fall-through to inline (this
      // is the serverless path; the file doesn't exist on Vercel).
      void fileExists;
    }
    // Fallback to inlined strategy (serverless OR malformed file)
    const raw = INLINE_STRATEGIES[name];
    if (raw) return resolveTokenAliases(StrategySchema.parse(raw));
    throw new Error(`Built-in strategy "${name}" not found on filesystem or inline`);
  }

  // R4-FG-71 (round-4 low): refuse path-shaped names with traversal
  // segments. Pre-fix any non-built-in `name` was passed to
  // `readFileSync(resolve(name))`, which combined with operator
  // misconfiguration of `STRATEGY=../../etc/passwd` (or a future
  // user-controlled call site) would read arbitrary files. The CLI
  // should use an explicit `--strategy-file <path>` flag — which we
  // don't have today, so for now the hardening here is to reject
  // `..` segments and absolute paths.
  if (name.includes('..') || name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) {
    throw new Error(
      `Strategy "${name}" rejected: path traversal segments + absolute paths ` +
      `are not allowed via the strategy name. Use a built-in (${BUILT_IN.join(', ')}) ` +
      `or add an explicit --strategy-file flag for arbitrary paths (R4-FG-71).`,
    );
  }
  // Treat as file path (relative; resolved against CWD).
  const raw = JSON.parse(readFileSync(resolve(name), 'utf-8'));
  return resolveTokenAliases(StrategySchema.parse(raw));
}
