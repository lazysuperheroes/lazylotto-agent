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

/**
 * Outcome of phase-5 prize transfer, surfaced from LottoAgent so the
 * downstream session record can carry the truth instead of guessing.
 * Mirrors the discriminated union in LottoAgent.ts (kept here as a
 * structural type to avoid a circular import — ReportGenerator is
 * deliberately a leaf module).
 */
export type PrizeTransferOutcomeReport =
  | { status: 'skipped'; reason: string }
  | {
      status: 'succeeded';
      contractTxId: string;
      prizeCount: number;
      attempt: number;
      gasUsed: number;
      ownerEoa: string;
    }
  | {
      status: 'failed';
      prizeCount: number;
      ownerEoa: string;
      error: string;
      attemptsLog: { attempt: number; gas: number; error?: string }[];
    };

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
  /**
   * Result of the phase-5 prize transfer attempt. `undefined` only if
   * the session aborted before phase 5 (rare — phase 5 runs in a
   * finally block). MultiUserAgent uses this to set the session
   * record's `prizesTransferred` flag and to dead-letter failures.
   */
  prizeTransferOutcome?: PrizeTransferOutcomeReport;
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

  /**
   * Total wins seen so far in this session — used by the cross-user
   * contamination check in LottoAgent.transferAllPrizes (Task E). Live
   * count, not the finalized report value.
   */
  getCurrentWinCount(): number {
    return this.poolResults.reduce((s, r) => s + r.wins, 0);
  }

  /**
   * Stash the phase-5 prize transfer outcome so it lands in the next
   * generate() call. Set by LottoAgent in the finally block after
   * safeTransferPrizes runs.
   */
  setPrizeTransferOutcome(outcome: PrizeTransferOutcomeReport): void {
    this.prizeTransferOutcome = outcome;
  }

  private prizeTransferOutcome?: PrizeTransferOutcomeReport;

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
      ...(this.prizeTransferOutcome ? { prizeTransferOutcome: this.prizeTransferOutcome } : {}),
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
