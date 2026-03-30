import type { Budget, TokenBudget } from '../config/strategy.js';
import type { PriceOracle } from '../hedera/prices.js';

// ── Types ─────────────────────────────────────────────────────

export interface SpendRecord {
  poolId: number;
  amount: number;
  entries: number;
  token: string;
  timestamp: number;
}

export interface TokenBudgetSummary {
  token: string;
  maxPerSession: number;
  maxPerPool: number;
  reserve: number;
  spent: number;
  remaining: number;
}

export interface BudgetSummary {
  tokens: TokenBudgetSummary[];
  maxEntriesPerPool: number;
  usdCap: number | null;
  usdSpent: number;
  records: SpendRecord[];
}

// ── BudgetManager ─────────────────────────────────────────────

export class BudgetManager {
  private spent: SpendRecord[] = [];
  private usdAccumulator = 0;
  private readonly budget: Budget;
  private readonly oracle?: PriceOracle;

  constructor(budget: Budget, oracle?: PriceOracle) {
    this.budget = budget;
    this.oracle = oracle;
  }

  // ── Per-token queries ─────────────────────────────────────

  /** Get the token budget config, or undefined if this token isn't budgeted. */
  private getTokenBudget(token: string): TokenBudget | undefined {
    return this.budget.tokenBudgets[token];
  }

  /** Total spent for a specific token across all pools. */
  totalSpentFor(token: string): number {
    return this.spent
      .filter((r) => r.token === token)
      .reduce((sum, r) => sum + r.amount, 0);
  }

  /** Remaining budget for a specific token in this session. */
  remainingFor(token: string): number {
    const tb = this.getTokenBudget(token);
    if (!tb) return 0;
    return Math.max(0, tb.maxPerSession - this.totalSpentFor(token));
  }

  /** Amount spent on a specific pool for a specific token. */
  spentOnPool(token: string, poolId: number): number {
    return this.spent
      .filter((r) => r.token === token && r.poolId === poolId)
      .reduce((sum, r) => sum + r.amount, 0);
  }

  /** Remaining budget for a specific token in a specific pool. */
  remainingForPool(token: string, poolId: number): number {
    const tb = this.getTokenBudget(token);
    if (!tb) return 0;
    return Math.max(0, tb.maxPerPool - this.spentOnPool(token, poolId));
  }

  /** Whether this token+pool+amount combination is affordable. */
  canAfford(token: string, poolId: number, amount: number): boolean {
    if (!this.getTokenBudget(token)) return false;
    return amount <= this.remainingFor(token) && amount <= this.remainingForPool(token, poolId);
  }

  /** Maximum entries that can be bought in a pool given the token budget. */
  maxEntriesForPool(token: string, poolId: number, entryFee: number): number {
    const tb = this.getTokenBudget(token);
    if (!tb) return 0;
    if (entryFee <= 0) return this.budget.maxEntriesPerPool;

    const bySession = Math.floor(this.remainingFor(token) / entryFee);
    const byPool = Math.floor(this.remainingForPool(token, poolId) / entryFee);
    const byLimit = this.budget.maxEntriesPerPool - this.entriesForPool(poolId);
    return Math.max(0, Math.min(bySession, byPool, byLimit));
  }

  // ── Spend tracking ────────────────────────────────────────

  /** Record a spend. If oracle available and USD cap configured, accumulates USD. */
  recordSpend(poolId: number, amount: number, token: string, entries = 1): void {
    this.spent.push({
      poolId,
      amount,
      entries,
      token,
      timestamp: Date.now(),
    });

    // USD accumulation (best-effort, non-blocking sync approximation)
    if (this.budget.usd && this.oracle) {
      // Price lookup is async but we accumulate synchronously from cached values
      // The oracle caches prices from prior calls, so this is a sync cache read
      const cachedPrice = this.oracle.getCachedUsdPrice(token);
      if (cachedPrice !== null) {
        this.usdAccumulator += amount * cachedPrice;
      }
    }
  }

  // ── Session-level checks ──────────────────────────────────

  /** Whether a specific token's session budget is fully spent. */
  isExhaustedFor(token: string): boolean {
    return this.remainingFor(token) <= 0;
  }

  /** Whether ALL token budgets are exhausted. */
  isFullyExhausted(): boolean {
    return Object.keys(this.budget.tokenBudgets).every((t) =>
      this.isExhaustedFor(t)
    );
  }

  /** Whether ANY token still has session budget remaining. */
  hasAnyBudgetRemaining(): boolean {
    return Object.keys(this.budget.tokenBudgets).some(
      (t) => this.remainingFor(t) > 0
    );
  }

  /** Whether the current balance for a token still exceeds its reserve. */
  checkReserve(token: string, currentBalance: number): boolean {
    const tb = this.getTokenBudget(token);
    if (!tb) return false;
    return currentBalance - this.totalSpentFor(token) >= tb.reserve;
  }

  /** Whether the USD cap has been exceeded (if configured). */
  usdCapExceeded(): boolean {
    if (!this.budget.usd) return false;
    return this.usdAccumulator >= this.budget.usd.maxPerSession;
  }

  /** Total USD spent (0 if no oracle or no USD cap). */
  get totalUsdSpent(): number {
    return this.usdAccumulator;
  }

  /** All token keys that have a budget configured. */
  get budgetedTokens(): string[] {
    return Object.keys(this.budget.tokenBudgets);
  }

  // ── Internals ─────────────────────────────────────────────

  private entriesForPool(poolId: number): number {
    return this.spent
      .filter((r) => r.poolId === poolId)
      .reduce((sum, r) => sum + r.entries, 0);
  }

  // ── Summary ───────────────────────────────────────────────

  getSummary(): BudgetSummary {
    return {
      tokens: Object.entries(this.budget.tokenBudgets).map(([token, tb]) => ({
        token,
        maxPerSession: tb.maxPerSession,
        maxPerPool: tb.maxPerPool,
        reserve: tb.reserve,
        spent: this.totalSpentFor(token),
        remaining: this.remainingFor(token),
      })),
      maxEntriesPerPool: this.budget.maxEntriesPerPool,
      usdCap: this.budget.usd?.maxPerSession ?? null,
      usdSpent: this.usdAccumulator,
      records: [...this.spent],
    };
  }
}
