export interface PoolResult {
  poolId: number;
  poolName: string;
  entriesBought: number;
  amountSpent: number;
  rolled: boolean;
  wins: number;
  prizesClaimed: number;
  prizesTransferred: number;
}

export interface SessionReport {
  startedAt: string;
  endedAt: string;
  strategy: string;
  poolsEvaluated: number;
  poolsPlayed: number;
  totalEntries: number;
  totalSpent: number;
  totalWins: number;
  totalPrizesClaimed: number;
  totalPrizesTransferred: number;
  poolResults: PoolResult[];
  currency: string;
}

export class ReportGenerator {
  private startedAt = new Date();
  private poolResults: PoolResult[] = [];
  private poolsEvaluated = 0;
  private strategy = '';
  private currency = 'LAZY';

  begin(strategy: string, currency: string): void {
    this.startedAt = new Date();
    this.poolResults = [];
    this.poolsEvaluated = 0;
    this.strategy = strategy;
    this.currency = currency;
  }

  setPoolsEvaluated(count: number): void {
    this.poolsEvaluated = count;
  }

  addPoolResult(result: PoolResult): void {
    this.poolResults.push(result);
  }

  generate(): SessionReport {
    const now = new Date();
    return {
      startedAt: this.startedAt.toISOString(),
      endedAt: now.toISOString(),
      strategy: this.strategy,
      poolsEvaluated: this.poolsEvaluated,
      poolsPlayed: this.poolResults.length,
      totalEntries: this.poolResults.reduce((s, r) => s + r.entriesBought, 0),
      totalSpent: this.poolResults.reduce((s, r) => s + r.amountSpent, 0),
      totalWins: this.poolResults.reduce((s, r) => s + r.wins, 0),
      totalPrizesClaimed: this.poolResults.reduce((s, r) => s + r.prizesClaimed, 0),
      totalPrizesTransferred: this.poolResults.reduce((s, r) => s + r.prizesTransferred, 0),
      poolResults: this.poolResults,
      currency: this.currency,
    };
  }

  print(report: SessionReport): void {
    console.log('\n═══════════════════════════════════════');
    console.log('  LazyLotto Agent — Session Report');
    console.log('═══════════════════════════════════════');
    console.log(`Strategy:    ${report.strategy}`);
    console.log(`Duration:    ${report.startedAt} → ${report.endedAt}`);
    console.log(`Pools:       ${report.poolsPlayed} played / ${report.poolsEvaluated} evaluated`);
    console.log(`Entries:     ${report.totalEntries}`);
    console.log(`Spent:       ${report.totalSpent} ${report.currency}`);
    console.log(`Wins:        ${report.totalWins}`);
    console.log(`Claimed:     ${report.totalPrizesClaimed}`);
    console.log(`Transferred: ${report.totalPrizesTransferred}`);
    console.log('───────────────────────────────────────');

    for (const r of report.poolResults) {
      const status = r.wins > 0 ? '🏆' : '·';
      console.log(
        `  ${status} Pool #${r.poolId} (${r.poolName}): ${r.entriesBought} entries, ${r.amountSpent} ${report.currency}, ${r.wins} wins`
      );
    }

    console.log('───────────────────────────────────────');
    console.log(`Spent:       -${report.totalSpent} ${report.currency}`);
    if (report.totalWins > 0) {
      console.log(`Prizes:      ${report.totalWins} won (transferred to owner, claim from dApp)`);
    }
    console.log('═══════════════════════════════════════\n');
  }
}
