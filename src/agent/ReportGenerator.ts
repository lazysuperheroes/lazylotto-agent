/**
 * A specific NFT won as part of a prize (token + serial pair).
 * hederaId + serial uniquely identifies the NFT on-chain.
 */
export interface PrizeNft {
  /** On-chain symbol (e.g. "HSuite", "LSH Comic #1"). */
  token: string;
  /** Hedera token ID ("0.0.X") — canonical lookup key. */
  hederaId: string;
  /** Serial number. */
  serial: number;
}

export interface PrizeDetail {
  fungibleAmount?: number;
  fungibleToken?: string;
  /** Total NFT count in this prize (includes all serials across collections). */
  nftCount?: number;
  /** Specific NFTs won — enriched from the dApp MCP's pendingPrizes.nfts. */
  nfts?: PrizeNft[];
}

export interface PoolResult {
  poolId: number;
  poolName: string;
  entriesBought: number;
  amountSpent: number;
  feeTokenSymbol: string;
  rolled: boolean;
  wins: number;
  prizesClaimed: number;
  prizesTransferred: number;
  prizeDetails: PrizeDetail[];
}

export interface SessionReport {
  startedAt: string;
  endedAt: string;
  strategy: string;
  poolsEvaluated: number;
  poolsPlayed: number;
  totalEntries: number;
  totalSpent: number;
  spentByToken: Record<string, number>;
  totalWins: number;
  totalPrizesClaimed: number;
  totalPrizesTransferred: number;
  totalPrizeValue: number;
  prizesByToken: Record<string, number>;
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
    const spentByToken: Record<string, number> = {};
    for (const r of this.poolResults) {
      const sym = r.feeTokenSymbol || 'HBAR';
      spentByToken[sym] = (spentByToken[sym] ?? 0) + r.amountSpent;
    }
    // Aggregate prize values across all pools
    const prizesByToken: Record<string, number> = {};
    let totalPrizeValue = 0;
    for (const r of this.poolResults) {
      for (const p of r.prizeDetails) {
        if (p.fungibleAmount && p.fungibleToken) {
          prizesByToken[p.fungibleToken] = (prizesByToken[p.fungibleToken] ?? 0) + p.fungibleAmount;
          totalPrizeValue += p.fungibleAmount;
        }
      }
    }
    return {
      startedAt: this.startedAt.toISOString(),
      endedAt: now.toISOString(),
      strategy: this.strategy,
      poolsEvaluated: this.poolsEvaluated,
      poolsPlayed: this.poolResults.length,
      totalEntries: this.poolResults.reduce((s, r) => s + r.entriesBought, 0),
      totalSpent: this.poolResults.reduce((s, r) => s + r.amountSpent, 0),
      spentByToken,
      totalWins: this.poolResults.reduce((s, r) => s + r.wins, 0),
      totalPrizesClaimed: this.poolResults.reduce((s, r) => s + r.prizesClaimed, 0),
      totalPrizesTransferred: this.poolResults.reduce((s, r) => s + r.prizesTransferred, 0),
      totalPrizeValue,
      prizesByToken,
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
    const spentParts = Object.entries(report.spentByToken)
      .map(([sym, amt]) => `${amt} ${sym}`)
      .join(' + ');
    console.log(`Spent:       ${spentParts || '0'}`);
    console.log(`Wins:        ${report.totalWins}`);
    console.log('───────────────────────────────────────');

    for (const r of report.poolResults) {
      const status = r.wins > 0 ? '🏆' : '·';
      console.log(
        `  ${status} Pool #${r.poolId} (${r.poolName}): ${r.entriesBought} entries, ${r.amountSpent} ${r.feeTokenSymbol}, ${r.wins} wins`
      );
    }

    console.log('───────────────────────────────────────');
    console.log(`Spent:       ${spentParts || '0'}`);
    if (report.totalWins > 0) {
      console.log(`Prizes:      ${report.totalWins} won (transferred to owner, claim from dApp)`);
    }
    console.log('═══════════════════════════════════════\n');
  }
}
