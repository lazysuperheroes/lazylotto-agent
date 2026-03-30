import type { Strategy, PoolFilter } from '../config/strategy.js';
import type { PoolSummary, EvCalculation } from '../mcp/client.js';

export interface ScoredPool {
  pool: PoolSummary;
  ev: EvCalculation;
  score: number;
}

export class StrategyEngine {
  private readonly strategy: Strategy;

  constructor(strategy: Strategy) {
    this.strategy = strategy;
  }

  filterPools(pools: PoolSummary[]): PoolSummary[] {
    const f = this.strategy.poolFilter;
    return pools.filter((p) => {
      if (p.paused || p.closed) return false;
      if (f.minWinRate !== undefined && p.winRatePercent < f.minWinRate) return false;
      if (f.maxEntryFee !== undefined && p.entryFee > f.maxEntryFee) return false;
      if (f.feeToken !== 'any' && p.feeTokenSymbol !== f.feeToken) return false;
      if (p.prizeCount < f.minPrizeCount) return false;
      return true;
    });
  }

  scorePools(pools: PoolSummary[], evResults: EvCalculation[]): ScoredPool[] {
    const evMap = new Map(evResults.map((ev) => [ev.poolId, ev]));

    const scored: ScoredPool[] = [];
    for (const pool of pools) {
      const ev = evMap.get(pool.poolId);
      if (!ev) continue;

      // Score = EV per entry (positive is profitable, negative is cost of entertainment)
      const score = ev.expectedValue;

      if (score >= this.strategy.playStyle.minExpectedValue) {
        scored.push({ pool, ev, score });
      }
    }

    // Sort by score descending (best EV first)
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  getEntriesPerBatch(): number {
    return this.strategy.playStyle.entriesPerBatch;
  }

  getAction(): string {
    return this.strategy.playStyle.action;
  }

  shouldPreferNftPrizes(): boolean {
    return this.strategy.playStyle.preferNftPrizes;
  }

  shouldTransferToOwner(): boolean {
    return this.strategy.playStyle.transferToOwner;
  }

  getOwnerAddress(): string | undefined {
    return this.strategy.playStyle.ownerAddress;
  }
}
