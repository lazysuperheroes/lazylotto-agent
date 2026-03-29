import type { Budget } from '../config/strategy.js';

export interface SpendRecord {
  poolId: number;
  amount: number;
  entries: number;
  currency: string;
  timestamp: number;
}

export class BudgetManager {
  private spent: SpendRecord[] = [];
  private readonly budget: Budget;

  constructor(budget: Budget) {
    this.budget = budget;
  }

  get totalSpent(): number {
    return this.spent.reduce((sum, r) => sum + r.amount, 0);
  }

  get remaining(): number {
    return Math.max(0, this.budget.maxSpendPerSession - this.totalSpent);
  }

  spentOnPool(poolId: number): number {
    return this.spent
      .filter((r) => r.poolId === poolId)
      .reduce((sum, r) => sum + r.amount, 0);
  }

  remainingForPool(poolId: number): number {
    return Math.max(0, this.budget.maxSpendPerPool - this.spentOnPool(poolId));
  }

  canAfford(poolId: number, amount: number): boolean {
    return amount <= this.remaining && amount <= this.remainingForPool(poolId);
  }

  maxEntriesForPool(poolId: number, entryFee: number): number {
    if (entryFee <= 0) return this.budget.maxEntriesPerPool;
    const bySession = Math.floor(this.remaining / entryFee);
    const byPool = Math.floor(this.remainingForPool(poolId) / entryFee);
    const byLimit = this.budget.maxEntriesPerPool - this.entriesForPool(poolId);
    return Math.max(0, Math.min(bySession, byPool, byLimit));
  }

  recordSpend(poolId: number, amount: number, entries = 1): void {
    this.spent.push({
      poolId,
      amount,
      entries,
      currency: this.budget.currency,
      timestamp: Date.now(),
    });
  }

  isExhausted(): boolean {
    return this.remaining <= 0;
  }

  checkReserve(currentBalance: number): boolean {
    return currentBalance - this.totalSpent >= this.budget.reserveBalance;
  }

  private entriesForPool(poolId: number): number {
    return this.spent
      .filter((r) => r.poolId === poolId)
      .reduce((sum, r) => sum + r.entries, 0);
  }

  getSummary() {
    return {
      budget: this.budget,
      totalSpent: this.totalSpent,
      remaining: this.remaining,
      records: [...this.spent],
    };
  }
}
