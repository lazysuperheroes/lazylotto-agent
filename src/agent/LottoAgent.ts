import { Client } from '@hashgraph/sdk';
import type { Strategy } from '../config/strategy.js';
import { resolveBudgetKey, HBAR_TOKEN_KEY } from '../config/strategy.js';
import {
  createClient,
  getWalletInfo,
} from '../hedera/wallet.js';
import {
  executeIntent,
  type IntentResponse,
} from '../hedera/contracts.js';
import {
  associateToken,
  approveFungibleToken,
  setupApprovals,
} from '../hedera/tokens.js';
import {
  getTokenBalances,
  waitForMirrorNode,
} from '../hedera/mirror.js';
import {
  listPools,
  getPool,
  calculateEv,
  getUserState,
  getSystemInfo,
  checkPrerequisites,
  buyEntries,
  roll as mcpRoll,
  closeMcpClient,
  type PoolSummary,
  type PoolDetail,
  type EvCalculation,
  type SystemInfo,
} from '../mcp/client.js';
import { BudgetManager } from './BudgetManager.js';
import { StrategyEngine, type ScoredPool } from './StrategyEngine.js';
import { assertKillSwitchDisabled } from '../lib/killswitch.js';
import {
  ReportGenerator,
  type PoolResult,
  type SessionReport,
} from './ReportGenerator.js';
import { errorMsg, hbarToNumber, tokenBalanceToNumber, toEvmAddress } from '../utils/format.js';

/**
 * Result of the phase-5 prize transfer attempt. Surfaced back to
 * MultiUserAgent so the session record can carry the truth instead
 * of the previous hardcoded `prizesTransferred: true`.
 *
 * - skipped: nothing to do (no pending prizes, transferToOwner off,
 *   or no ownerAddress configured)
 * - succeeded: contract call returned, prizes are now owned by EOA
 * - failed: contract call exhausted retries — operator must run the
 *   recovery tool to push the prizes through
 */
export type PrizeTransferOutcome =
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

// ── Prerequisite shape returned by MCP check_prerequisites ────

interface Prerequisite {
  type: string;
  satisfied: boolean;
  reason: string;
  token?: string;
  symbol?: string;
  target?: string;
  targetName?: string;
  requiredAmount?: string;
  currentAmount?: string;
  action?: {
    sdkTransaction: string;
    description: string;
    params: Record<string, unknown>;
  };
}

// ── Agent ─────────────────────────────────────────────────────

export class LottoAgent {
  private client: Client;
  private strategy: Strategy;
  private budgetManager: BudgetManager;
  private strategyEngine: StrategyEngine;
  private reportGenerator: ReportGenerator;
  private systemInfo: SystemInfo | null = null;
  private _playing = false;

  constructor(strategy: Strategy) {
    this.client = createClient();
    // Inject OWNER_EOA from env if strategy doesn't specify an ownerAddress
    if (!strategy.playStyle.ownerAddress && process.env.OWNER_EOA) {
      strategy = {
        ...strategy,
        playStyle: { ...strategy.playStyle, ownerAddress: process.env.OWNER_EOA },
      };
    }
    this.strategy = strategy;
    this.budgetManager = new BudgetManager(strategy.budget);
    this.strategyEngine = new StrategyEngine(strategy);
    this.reportGenerator = new ReportGenerator();
  }

  // ── Public: first-time wallet setup ─────────────────────────

  async setup(): Promise<void> {
    const info = await getWalletInfo(this.client);
    console.log(`Wallet:  ${info.accountId}`);
    console.log(`Network: ${info.network}`);
    console.log(`HBAR:    ${info.hbarBalance}`);

    let sys: SystemInfo | null = null;
    try {
      sys = await this.loadSystemInfo();
      console.log(`LazyLotto: ${sys.contractAddresses?.lazyLotto ?? 'from .env'}`);
      console.log(`Pools:     ${sys.totalPools ?? 'unknown'}`);
    } catch (e) {
      console.warn(`Could not load system info from MCP: ${errorMsg(e)}`);
      console.warn('Using contract addresses from .env instead.');
    }

    const lazyTokenId = process.env.LAZY_TOKEN_ID ?? sys?.lazyToken;
    if (lazyTokenId) {
      try {
        await associateToken(this.client, lazyTokenId);
        console.log(`Associated LAZY token: ${lazyTokenId}`);
      } catch (e: unknown) {
        if (errorMsg(e).includes('TOKEN_ALREADY_ASSOCIATED')) {
          console.log('LAZY token already associated.');
        } else throw e;
      }
    }

    const gasStationId = process.env.LAZY_GAS_STATION_ID ?? sys?.contractAddresses?.gasStation;
    const storageId = process.env.LAZYLOTTO_STORAGE_ID ?? sys?.contractAddresses?.storage;

    if (!lazyTokenId) {
      console.warn('LAZY_TOKEN_ID not set — skipping token setup. Set it in .env.');
    }
    if (!gasStationId) {
      console.warn('LAZY_GAS_STATION_ID not set — skipping approvals. Set it in .env.');
    }

    if (lazyTokenId && gasStationId) {
      await setupApprovals(this.client, {
        lazyTokenId,
        gasStationId,
        storageId: storageId ?? '',
      });
    }

    // Close connections so process can exit
    try { await closeMcpClient(); } catch { /* best-effort */ }
    try { this.client.close(); } catch { /* best-effort */ }

    console.log('Setup complete.');
  }

  // ── Public: print wallet status ─────────────────────────────

  async status(): Promise<void> {
    const info = await getWalletInfo(this.client);
    const accountId = info.accountId.toString();

    console.log(`\nAgent Wallet: ${accountId}`);
    console.log(`Network:      ${info.network}`);
    console.log(`HBAR:         ${info.hbarBalance}`);

    const tokens = await getTokenBalances(accountId);
    for (const t of tokens) {
      console.log(`  ${t.token_id}: ${t.balance / Math.pow(10, t.decimals)}`);
    }

    const state = await getUserState(accountId);
    console.log(`Pending prizes: ${state.pendingPrizesCount}`);
    console.log(`Win rate boost:  ${state.boost} bps`);
    for (const [pid, count] of Object.entries(state.entriesByPool)) {
      if (Number(count) > 0) console.log(`  Pool #${pid}: ${count} entries`);
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  Main play session — 6-phase loop
  // ══════════════════════════════════════════════════════════════

  async play(): Promise<SessionReport> {
    // Domain-layer kill switch gate covers single-user mode too —
    // catches any direct LottoAgent.play() caller (scheduled cron,
    // agent_play MCP tool, tests) without relying on tool-layer checks.
    await assertKillSwitchDisabled();

    this._playing = true;
    try {
      return await this._runPlaySession();
    } finally {
      this._playing = false;
    }
  }

  private async _runPlaySession(): Promise<SessionReport> {
    this.budgetManager = new BudgetManager(this.strategy.budget);
    this.reportGenerator.begin(
      this.strategy.name,
      'multi' // multi-currency; per-token details in budget summary
    );
    let accountId = '';
    let balances = new Map<string, number>();

    try {
      // ── Phase 1: Preflight ────────────────────────────────────
      console.log('\n[1/6] Preflight');
      const preflight = await this.preflight();
      accountId = preflight.accountId;
      balances = preflight.balances;

      // ── Phase 2: Discover ─────────────────────────────────────
      console.log('\n[2/6] Discovering pools');
      const candidates = await this.discover();

      if (candidates.length === 0) {
        console.log('  No pools match strategy filters. Done.');
        return this.finishReport();
      }

      // ── Phase 3: Evaluate ─────────────────────────────────────
      console.log('\n[3/6] Evaluating pools');
      const scored = await this.evaluate(candidates, accountId);
      this.reportGenerator.setPoolsEvaluated(candidates.length);

      if (scored.length === 0) {
        console.log('  No pools pass EV threshold. Done.');
        return this.finishReport();
      }

      // ── Phase 4: Play ─────────────────────────────────────────
      console.log('\n[4/6] Playing');
      let sessionWins = 0;
      for (const sp of scored) {
        if (!this.budgetManager.hasAnyBudgetRemaining()) {
          console.log('  All token budgets exhausted.');
          break;
        }
        if (this.budgetManager.usdCapExceeded()) {
          console.log('  USD session cap reached. Stopping.');
          break;
        }

        // Resolve the budget key for this pool's fee token
        const poolDetail = sp.pool as PoolDetail;
        const budgetKey = resolveBudgetKey(poolDetail.feeTokenId);

        if (this.budgetManager.isExhaustedFor(budgetKey)) {
          console.log(
            `  Budget for ${budgetKey} exhausted. Skipping pool #${sp.pool.poolId}.`
          );
          continue;
        }
        if (!this.budgetManager.checkReserve(budgetKey, balances.get(budgetKey) ?? 0)) {
          console.log(
            `  Reserve for ${budgetKey} reached. Skipping pool #${sp.pool.poolId}.`
          );
          continue;
        }

        const result = await this.safePlayPool(sp, accountId, budgetKey);
        this.reportGenerator.addPoolResult(result);

        // Track wins for stopOnWins
        sessionWins += result.wins;
        const stopOnWins = this.strategy.playStyle.stopOnWins;
        if (stopOnWins && sessionWins >= stopOnWins) {
          console.log(`  Won ${sessionWins} prize(s) — stopOnWins threshold reached.`);
          break;
        }
      }
    } catch (e) {
      console.error('\nSession error:', errorMsg(e));
    } finally {
      // ── Phase 5: Transfer prizes (always attempt) ─────────────
      if (accountId) {
        console.log('\n[5/6] Checking prizes');
        const outcome = await this.safeTransferPrizes(accountId);
        // Stash on the report generator so the SessionReport carries
        // the truth instead of MultiUserAgent guessing/hardcoding.
        this.reportGenerator.setPrizeTransferOutcome(outcome);
      }

      // Close MCP connection after all MCP reads are done
      try {
        await closeMcpClient();
      } catch {
        /* best-effort */
      }
    }

    // ── Phase 6: Report ───────────────────────────────────────
    return this.finishReport();
  }

  // ── Public: strategy management ─────────────────────────────

  setStrategy(strategy: Strategy): void {
    this.strategy = strategy;
    this.budgetManager = new BudgetManager(strategy.budget);
    this.strategyEngine = new StrategyEngine(strategy);
  }

  getStrategy(): Strategy {
    return this.strategy;
  }

  getClient(): Client {
    return this.client;
  }

  isPlaying(): boolean {
    return this._playing;
  }

  async getAgentStatus() {
    const info = await getWalletInfo(this.client);
    const tokens = await getTokenBalances(info.accountId.toString());
    return {
      accountId: info.accountId.toString(),
      network: info.network,
      hbarBalance: info.hbarBalance.toString(),
      tokens,
      strategy: this.strategy.name,
      budget: this.budgetManager.getSummary(),
    };
  }

  // ══════════════════════════════════════════════════════════════
  //  Phase 1 — Preflight
  // ══════════════════════════════════════════════════════════════

  private async preflight(): Promise<{
    accountId: string;
    balances: Map<string, number>;
  }> {
    const info = await getWalletInfo(this.client);
    const accountId = info.accountId.toString();
    const hbar = hbarToNumber(info.hbarBalance);

    console.log(`  Wallet:  ${accountId}`);
    console.log(`  Network: ${info.network}`);
    console.log(`  HBAR:    ${hbar.toFixed(4)}`);

    // Fetch all token balances from mirror node
    const tokenBalances = await getTokenBalances(accountId);

    // Build balance map for all budgeted tokens
    const balances = new Map<string, number>();
    const budgetedTokens = this.budgetManager.budgetedTokens;

    for (const tokenKey of budgetedTokens) {
      if (tokenKey === HBAR_TOKEN_KEY) {
        balances.set(HBAR_TOKEN_KEY, hbar);
      } else {
        balances.set(tokenKey, tokenBalanceToNumber(tokenBalances, tokenKey));
      }
    }

    // Log each budgeted token's balance and budget
    let allBelowReserve = true;
    for (const tokenKey of budgetedTokens) {
      const bal = balances.get(tokenKey) ?? 0;
      const tb = this.strategy.budget.tokenBudgets[tokenKey];
      console.log(
        `  ${tokenKey}: balance=${bal}, ` +
          `budget=${tb.maxPerSession} per session, ` +
          `reserve=${tb.reserve}`
      );

      if (!this.budgetManager.checkReserve(tokenKey, bal)) {
        console.warn(`  WARNING: ${tokenKey} balance is below reserve (${tb.reserve})`);
      } else {
        allBelowReserve = false;
      }
    }

    if (allBelowReserve) {
      throw new Error(
        'All budgeted tokens are below their reserve thresholds. Aborting.'
      );
    }

    return { accountId, balances };
  }

  // ══════════════════════════════════════════════════════════════
  //  Phase 2 — Discover
  // ══════════════════════════════════════════════════════════════

  private async discover(): Promise<PoolDetail[]> {
    const all: PoolSummary[] = [];
    let offset = 0;
    const pageSize = 50;

    // Paginate through all available pools
    while (true) {
      // listPools() already handles response unwrapping and returns PoolSummary[]
      const page = await listPools(
        this.strategy.poolFilter.type,
        offset,
        pageSize
      );
      all.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
      if (all.length >= 200) break; // safety cap
    }

    const filtered = this.strategyEngine.filterPools(all);
    console.log(
      `  ${all.length} total pools -> ${filtered.length} match strategy filters`
    );

    // Fetch full details in parallel (needed for feeTokenId)
    const detailResults = await Promise.allSettled(
      filtered.map((pool) => getPool(pool.poolId))
    );
    const details: PoolDetail[] = [];
    for (let i = 0; i < detailResults.length; i++) {
      const result = detailResults[i];
      if (result.status === 'fulfilled') {
        details.push(result.value);
      } else {
        console.warn(
          `  Pool #${filtered[i].poolId}: failed to fetch details, skipping`
        );
      }
    }

    return details;
  }

  // ══════════════════════════════════════════════════════════════
  //  Phase 3 — Evaluate
  // ══════════════════════════════════════════════════════════════

  private static readonly EV_CONCURRENCY = 10;

  private async evaluate(
    pools: PoolDetail[],
    accountId: string
  ): Promise<ScoredPool[]> {
    const evResults: EvCalculation[] = [];

    // Process EV calculations in batches to avoid overwhelming the MCP endpoint
    for (let i = 0; i < pools.length; i += LottoAgent.EV_CONCURRENCY) {
      const batch = pools.slice(i, i + LottoAgent.EV_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((pool) => calculateEv(pool.poolId, accountId))
      );

      for (let j = 0; j < batch.length; j++) {
        const pool = batch[j];
        const result = results[j];
        if (result.status === 'fulfilled') {
          const ev = result.value;
          evResults.push(ev);
          console.log(
            `  #${pool.poolId} ${pool.name}: ` +
              `EV=${ev.expectedValue.toFixed(2)}, ` +
              `winRate=${(ev.effectiveWinRate * 100).toFixed(1)}%, ` +
              `fee=${pool.entryFee} ${pool.feeTokenSymbol}`
          );
        } else {
          console.warn(
            `  #${pool.poolId} ${pool.name}: EV calc failed (${errorMsg(result.reason)})`
          );
        }
      }
    }

    const scored = this.strategyEngine.scorePools(pools, evResults);
    console.log(`  ${scored.length} pool(s) above EV threshold`);
    return scored;
  }

  // ══════════════════════════════════════════════════════════════
  //  Phase 4 — Play
  // ══════════════════════════════════════════════════════════════

  private async safePlayPool(
    sp: ScoredPool,
    accountId: string,
    budgetKey: string
  ): Promise<PoolResult> {
    const empty: PoolResult = {
      poolId: sp.pool.poolId,
      poolName: sp.pool.name,
      entriesBought: 0,
      amountSpent: 0,
      feeTokenSymbol: sp.pool.feeTokenSymbol,
      rolled: false,
      wins: 0,
      prizesClaimed: 0,
      prizesTransferred: 0,
      prizeDetails: [],
    };

    try {
      return await this.playPool(sp.pool, sp.ev, accountId, budgetKey);
    } catch (e) {
      console.error(`  Pool #${sp.pool.poolId} failed: ${errorMsg(e)}`);
      return empty;
    }
  }

  private async playPool(
    pool: PoolSummary,
    ev: EvCalculation,
    accountId: string,
    budgetKey: string
  ): Promise<PoolResult> {
    const result: PoolResult = {
      poolId: pool.poolId,
      poolName: pool.name,
      entriesBought: 0,
      amountSpent: 0,
      feeTokenSymbol: pool.feeTokenSymbol,
      rolled: false,
      wins: 0,
      prizesClaimed: 0,
      prizesTransferred: 0,
      prizeDetails: [],
    };

    // Calculate how many entries we can buy
    const maxEntries = this.budgetManager.maxEntriesForPool(
      budgetKey,
      pool.poolId,
      pool.entryFee
    );
    const batchSize = Math.min(
      maxEntries,
      this.strategyEngine.getEntriesPerBatch()
    );

    if (batchSize <= 0) {
      console.log(`  Pool #${pool.poolId}: budget insufficient. Skipping.`);
      return result;
    }

    const action = this.strategyEngine.getAction();
    console.log(
      `  Pool #${pool.poolId} (${pool.name}): ` +
        `${batchSize} x ${pool.entryFee} ${pool.feeTokenSymbol}, ` +
        `EV=${ev.expectedValue.toFixed(2)}, action=${action}`
    );

    // ── 4a. Check & auto-fix prerequisites ────────────────────
    const prereqsRaw = await checkPrerequisites(
      accountId,
      pool.poolId,
      action,
      batchSize
    );
    const prereqs = (Array.isArray(prereqsRaw) ? prereqsRaw : []) as Prerequisite[];

    const unsatisfied = prereqs.filter((p) => !p.satisfied);
    if (unsatisfied.length > 0) {
      console.log(`    Fixing ${unsatisfied.length} prerequisite(s)...`);
      for (const prereq of unsatisfied) {
        try {
          await this.handlePrerequisite(prereq);
        } catch (e) {
          console.error(
            `    Prerequisite failed (${prereq.type}): ${errorMsg(e)}`
          );
          console.log(`    Skipping pool #${pool.poolId}.`);
          return result;
        }
      }
      await waitForMirrorNode();
    }

    // Snapshot pending prize count BEFORE this pool's roll
    let prizeCountBefore = 0;
    try {
      const stateBefore = await getUserState(accountId);
      prizeCountBefore = stateBefore.pendingPrizesCount;
    } catch {
      // Non-critical — worst case we report total instead of delta
    }

    // ── 4b. Buy entries via MCP intent → Hedera SDK execution ─
    const intentRaw = await buyEntries(
      pool.poolId,
      batchSize,
      action,
      accountId
    );
    const intentResponse = intentRaw as IntentResponse;
    if (!intentResponse?.intent?.contractId || !intentResponse?.encoded) {
      throw new Error(`Invalid transaction intent from MCP: missing contractId or encoded data`);
    }

    const buyTx = await executeIntent(this.client, intentResponse);
    console.log(
      `    Bought ${batchSize} entries: ${buyTx.transactionId} (${buyTx.status})`
    );

    result.entriesBought = batchSize;
    result.amountSpent = pool.entryFee * batchSize;
    this.budgetManager.recordSpend(pool.poolId, result.amountSpent, budgetKey, batchSize);

    // buy_and_roll and buy_and_redeem include the roll in the same tx
    if (action === 'buy_and_roll' || action === 'buy_and_redeem') {
      result.rolled = true;
    }

    // ── 4c. Roll separately if action was plain 'buy' ─────────
    if (action === 'buy') {
      await waitForMirrorNode();
      try {
        const rollRaw = await mcpRoll(pool.poolId, accountId);
        const rollIntent = rollRaw as IntentResponse;
        const rollTx = await executeIntent(this.client, rollIntent);
        console.log(`    Rolled: ${rollTx.transactionId} (${rollTx.status})`);
        result.rolled = true;
      } catch (e) {
        console.error(`    Roll failed: ${errorMsg(e)}`);
      }
    }

    // ── 4d. Check for wins (delta = after - before) ────────────
    if (result.rolled) {
      await waitForMirrorNode();
      try {
        const stateAfter = await getUserState(accountId);
        const newWins = Math.max(0, stateAfter.pendingPrizesCount - prizeCountBefore);
        result.wins = newWins;

        if (newWins > 0) {
          // Capture prize details from the offset into pendingPrizes.
          // Since the dApp MCP update, pendingPrizes[].nfts contains the full
          // { token, hederaId, serials[] } — capture it for write-history.
          const newPrizes = stateAfter.pendingPrizes.slice(prizeCountBefore);
          console.log(`    Won ${newWins} prize(s)!`);
          for (const prize of newPrizes) {
            const fungible = prize.fungiblePrize;
            // Flatten nfts[].serials[] into a PrizeNft[] (one entry per serial)
            const nfts = prize.nfts.flatMap((n) =>
              n.serials.map((serial) => ({
                token: n.token,
                hederaId: n.hederaId,
                serial,
              })),
            );
            const nftCount = nfts.length;

            const parts: string[] = [];
            if (fungible?.amount) parts.push(`${fungible.amount} ${fungible.token ?? '?'}`);
            if (nftCount > 0) {
              const summary = nfts.map((n) => `${n.token} #${n.serial}`).join(', ');
              parts.push(`${nftCount} NFT(s) [${summary}]`);
            }
            console.log(`      -> ${parts.join(' + ') || 'prize details unavailable'}`);

            result.prizeDetails.push({
              fungibleAmount: fungible?.amount,
              fungibleToken: fungible?.token,
              nftCount: nftCount > 0 ? nftCount : undefined,
              nfts: nftCount > 0 ? nfts : undefined,
            });
          }
        } else {
          console.log('    No wins this round.');
        }
      } catch (e) {
        console.warn(`    Could not check win state: ${errorMsg(e)}`);
      }
    }

    return result;
  }

  // ── Prerequisite handling ───────────────────────────────────

  private async handlePrerequisite(prereq: Prerequisite): Promise<void> {
    if (!prereq.action) {
      console.warn(`    No action for prerequisite: ${prereq.reason}`);
      return;
    }

    const { sdkTransaction, description, params } = prereq.action;
    console.log(`    -> ${description}`);

    switch (sdkTransaction) {
      case 'TokenAssociateTransaction': {
        await associateToken(this.client, params.tokenId as string);
        break;
      }
      case 'AccountAllowanceApproveTransaction': {
        await approveFungibleToken(
          this.client,
          params.tokenId as string,
          params.spender as string,
          params.amount as number
        );
        break;
      }
      default:
        console.warn(`    Unknown SDK transaction: ${sdkTransaction}`);
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  Phase 5 — Transfer Prizes
  //
  //  Uses direct Hedera SDK contract call (NOT claimAllPrizes).
  //  transferPendingPrizes reassigns prizes in-memory to the
  //  owner's EOA — no token associations needed on the agent.
  //  The owner claims via the dApp at their convenience.
  // ══════════════════════════════════════════════════════════════

  private async safeTransferPrizes(accountId: string): Promise<PrizeTransferOutcome> {
    try {
      return await this.transferAllPrizes(accountId);
    } catch (e) {
      const message = errorMsg(e);
      const attemptsLog =
        (e as Error & { attemptsLog?: { attempt: number; gas: number; error?: string }[] }).attemptsLog ?? [];
      console.error(`  Prize transfer failed: ${message}`);
      // The strategy may not have an ownerAddress (single-user CLI
      // mode) — preserve outcome contract for that path.
      const ownerEoa = this.strategyEngine.getOwnerAddress() ?? '';
      return {
        status: 'failed',
        prizeCount: 0, // unknown, may have been read or may have failed before read
        ownerEoa,
        error: message,
        attemptsLog,
      };
    }
  }

  private async transferAllPrizes(accountId: string): Promise<PrizeTransferOutcome> {
    if (!this.strategyEngine.shouldTransferToOwner()) {
      console.log('  transferToOwner disabled in strategy.');
      return { status: 'skipped', reason: 'transferToOwner disabled in strategy' };
    }

    const ownerAddress = this.strategyEngine.getOwnerAddress();
    if (!ownerAddress) {
      console.log(
        '  No ownerAddress in strategy — prizes remain in agent wallet.'
      );
      console.log('  Set playStyle.ownerAddress to auto-forward prizes.');
      return { status: 'skipped', reason: 'no ownerAddress in strategy' };
    }

    // Check pending prizes via MCP read
    const state = await getUserState(accountId);
    if (state.pendingPrizesCount === 0) {
      console.log('  No pending prizes to transfer.');
      return { status: 'skipped', reason: 'no pending prizes' };
    }

    // Defensive cross-user contamination check (Task E):
    // The contract's transferPendingPrizes(owner, MaxUint256) reassigns
    // ALL of the agent wallet's currently-pending prizes to `owner`.
    // If a previous user's transfer failed and their prizes are still
    // in the agent's pending list, this call would incorrectly send
    // them to the current user. We don't have a way to selectively
    // transfer per-user from the contract, but we can at least DETECT
    // and log if the count looks larger than expected.
    //
    // The check: if the dApp reports more pending prizes than this
    // session won, log a structured warning so operators can spot it
    // in Vercel logs.
    const expectedFromThisSession = this.reportGenerator.getCurrentWinCount();
    if (
      expectedFromThisSession > 0 &&
      state.pendingPrizesCount > expectedFromThisSession
    ) {
      console.warn(
        `  ⚠ CROSS-USER WARNING: agent pending prizes (${state.pendingPrizesCount}) > this session's wins (${expectedFromThisSession}). ` +
          `Old stranded prizes may be transferred to ${ownerAddress}. ` +
          `Run reconciliation against play history.`,
      );
    }

    console.log(
      `  ${state.pendingPrizesCount} pending prize(s) — ` +
        `transferring to ${ownerAddress}`
    );

    // Convert owner to EVM address and call shared utility with the
    // retry-with-escalating-gas helper (Task D). Retries 1→2→3 with
    // 225K → 300K → 400K per prize. INSUFFICIENT_GAS is the only
    // retryable error; everything else (revert, network) propagates
    // immediately and gets dead-lettered (Task B).
    const ownerEvmAddress = toEvmAddress(ownerAddress);
    const contractId = await this.getContractId();
    const { transferAllPrizesWithRetry } = await import('../hedera/contracts.js');
    const txResult = await transferAllPrizesWithRetry(
      this.client,
      contractId,
      ownerEvmAddress,
      state.pendingPrizesCount,
    );

    console.log(
      `  Transferred ${state.pendingPrizesCount} prize(s) on attempt ${txResult.attempt}: ` +
        `${txResult.result.transactionId} (${txResult.result.status})`
    );

    return {
      status: 'succeeded',
      contractTxId: txResult.result.transactionId,
      prizeCount: state.pendingPrizesCount,
      attempt: txResult.attempt,
      gasUsed: txResult.gasUsed,
      ownerEoa: ownerAddress,
    };
  }

  // ══════════════════════════════════════════════════════════════
  //  Phase 6 — Report
  // ══════════════════════════════════════════════════════════════

  private finishReport(): SessionReport {
    console.log('\n[6/6] Session complete');
    const report = this.reportGenerator.generate();
    this.reportGenerator.print(report);
    return report;
  }

  // ── Helpers ─────────────────────────────────────────────────

  private async loadSystemInfo(): Promise<SystemInfo> {
    if (!this.systemInfo) {
      this.systemInfo = await getSystemInfo();
    }
    return this.systemInfo;
  }

  private async getContractId(): Promise<string> {
    if (process.env.LAZYLOTTO_CONTRACT_ID) {
      return process.env.LAZYLOTTO_CONTRACT_ID;
    }
    const sys = await this.loadSystemInfo();
    return sys.contractAddresses.lazyLotto;
  }

}
