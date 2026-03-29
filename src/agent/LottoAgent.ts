import { Client, AccountId } from '@hashgraph/sdk';
import { Interface, MaxUint256 } from 'ethers';
import { createRequire } from 'node:module';
import type { Strategy } from '../config/strategy.js';
import { GAS_ESTIMATES } from '../config/defaults.js';
import {
  createClient,
  getWalletInfo,
  getOperatorAccountId,
} from '../hedera/wallet.js';
import {
  executeIntent,
  executeEncodedCall,
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
  type TokenBalance,
} from '../hedera/mirror.js';
import {
  listPools,
  calculateEv,
  getUserState,
  getSystemInfo,
  checkPrerequisites,
  buyEntries,
  roll as mcpRoll,
  closeMcpClient,
  type PoolSummary,
  type EvCalculation,
  type SystemInfo,
} from '../mcp/client.js';
import { BudgetManager } from './BudgetManager.js';
import { StrategyEngine, type ScoredPool } from './StrategyEngine.js';
import {
  ReportGenerator,
  type PoolResult,
  type SessionReport,
} from './ReportGenerator.js';

// CJS interop — @lazysuperheroes/lazy-lotto ships CommonJS
const esmRequire = createRequire(import.meta.url);
const { LazyLottoABI } = esmRequire('@lazysuperheroes/lazy-lotto');

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

function errorMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── Agent ─────────────────────────────────────────────────────

export class LottoAgent {
  private client: Client;
  private strategy: Strategy;
  private budgetManager: BudgetManager;
  private strategyEngine: StrategyEngine;
  private reportGenerator: ReportGenerator;
  private systemInfo: SystemInfo | null = null;

  constructor(strategy: Strategy) {
    this.client = createClient();
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

    const sys = await this.loadSystemInfo();
    console.log(`LazyLotto: ${sys.contractAddresses.lazyLotto}`);
    console.log(`Pools:     ${sys.totalPools}`);

    const lazyTokenId = process.env.LAZY_TOKEN_ID ?? sys.lazyToken;
    try {
      await associateToken(this.client, lazyTokenId);
      console.log(`Associated LAZY token: ${lazyTokenId}`);
    } catch (e: unknown) {
      if (errorMsg(e).includes('TOKEN_ALREADY_ASSOCIATED')) {
        console.log('LAZY token already associated.');
      } else throw e;
    }

    await setupApprovals(this.client, {
      lazyTokenId,
      gasStationId:
        process.env.LAZY_GAS_STATION_ID ?? sys.contractAddresses.gasStation,
      storageId:
        process.env.LAZYLOTTO_STORAGE_ID ?? sys.contractAddresses.storage,
    });
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
    this.budgetManager = new BudgetManager(this.strategy.budget);
    this.reportGenerator.begin(
      this.strategy.name,
      this.strategy.budget.currency
    );
    let accountId = '';
    let balance = 0;

    try {
      // ── Phase 1: Preflight ────────────────────────────────────
      console.log('\n[1/6] Preflight');
      const preflight = await this.preflight();
      accountId = preflight.accountId;
      balance = preflight.balance;

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
      for (const sp of scored) {
        if (this.budgetManager.isExhausted()) {
          console.log('  Session budget exhausted.');
          break;
        }
        if (!this.budgetManager.checkReserve(balance)) {
          console.log(
            `  Reserve (${this.strategy.budget.reserveBalance} ` +
              `${this.strategy.budget.currency}) reached. Stopping.`
          );
          break;
        }

        const result = await this.safePlayPool(sp, accountId);
        this.reportGenerator.addPoolResult(result);
      }
    } catch (e) {
      console.error('\nSession error:', errorMsg(e));
    } finally {
      // ── Phase 5: Transfer prizes (always attempt) ─────────────
      if (accountId) {
        console.log('\n[5/6] Checking prizes');
        await this.safeTransferPrizes(accountId);
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
    balance: number;
  }> {
    const info = await getWalletInfo(this.client);
    const accountId = info.accountId.toString();
    const hbar = Number(info.hbarBalance.toTinybars().toString()) / 1e8;

    console.log(`  Wallet:  ${accountId}`);
    console.log(`  Network: ${info.network}`);
    console.log(`  HBAR:    ${hbar.toFixed(4)}`);

    // Resolve balance in budget currency
    let balance: number;
    if (this.strategy.budget.currency === 'HBAR') {
      balance = hbar;
    } else {
      const lazyTokenId =
        process.env.LAZY_TOKEN_ID ?? (await this.loadSystemInfo()).lazyToken;
      const tokens = await getTokenBalances(accountId);
      balance = this.tokenBalance(tokens, lazyTokenId);
      console.log(`  LAZY:    ${balance}`);
    }

    // Check reserve
    if (balance < this.strategy.budget.reserveBalance) {
      throw new Error(
        `Balance ${balance} ${this.strategy.budget.currency} is below ` +
          `reserve ${this.strategy.budget.reserveBalance}. Aborting.`
      );
    }

    console.log(
      `  Budget:  ${this.strategy.budget.maxSpendPerSession} ` +
        `${this.strategy.budget.currency} ` +
        `(reserve: ${this.strategy.budget.reserveBalance})`
    );

    return { accountId, balance };
  }

  // ══════════════════════════════════════════════════════════════
  //  Phase 2 — Discover
  // ══════════════════════════════════════════════════════════════

  private async discover(): Promise<PoolSummary[]> {
    const all: PoolSummary[] = [];
    let offset = 0;
    const pageSize = 50;

    // Paginate through all available pools
    while (true) {
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
    return filtered;
  }

  // ══════════════════════════════════════════════════════════════
  //  Phase 3 — Evaluate
  // ══════════════════════════════════════════════════════════════

  private async evaluate(
    pools: PoolSummary[],
    accountId: string
  ): Promise<ScoredPool[]> {
    const evResults: EvCalculation[] = [];

    for (const pool of pools) {
      try {
        const ev = await calculateEv(pool.poolId, accountId);
        evResults.push(ev);
        console.log(
          `  #${pool.poolId} ${pool.name}: ` +
            `EV=${ev.expectedValue.toFixed(2)}, ` +
            `winRate=${(ev.effectiveWinRate * 100).toFixed(1)}%, ` +
            `fee=${pool.entryFee} ${pool.feeTokenSymbol}`
        );
      } catch (e) {
        console.warn(
          `  #${pool.poolId} ${pool.name}: EV calc failed (${errorMsg(e)})`
        );
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
    accountId: string
  ): Promise<PoolResult> {
    const empty: PoolResult = {
      poolId: sp.pool.poolId,
      poolName: sp.pool.name,
      entriesBought: 0,
      amountSpent: 0,
      rolled: false,
      wins: 0,
      prizesClaimed: 0,
      prizesTransferred: 0,
    };

    try {
      return await this.playPool(sp.pool, sp.ev, accountId);
    } catch (e) {
      console.error(`  Pool #${sp.pool.poolId} failed: ${errorMsg(e)}`);
      return empty;
    }
  }

  private async playPool(
    pool: PoolSummary,
    ev: EvCalculation,
    accountId: string
  ): Promise<PoolResult> {
    const result: PoolResult = {
      poolId: pool.poolId,
      poolName: pool.name,
      entriesBought: 0,
      amountSpent: 0,
      rolled: false,
      wins: 0,
      prizesClaimed: 0,
      prizesTransferred: 0,
    };

    // Calculate how many entries we can buy
    const maxEntries = this.budgetManager.maxEntriesForPool(
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
    const prereqs = (await checkPrerequisites(
      accountId,
      pool.poolId,
      action,
      batchSize
    )) as Prerequisite[];

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

    // ── 4b. Buy entries via MCP intent → Hedera SDK execution ─
    const intentResponse = (await buyEntries(
      pool.poolId,
      batchSize,
      action,
      accountId
    )) as IntentResponse;

    const buyTx = await executeIntent(this.client, intentResponse);
    console.log(
      `    Bought ${batchSize} entries: ${buyTx.transactionId} (${buyTx.status})`
    );

    result.entriesBought = batchSize;
    result.amountSpent = pool.entryFee * batchSize;
    this.budgetManager.recordSpend(pool.poolId, result.amountSpent);

    // buy_and_roll and buy_and_redeem include the roll in the same tx
    if (action === 'buy_and_roll' || action === 'buy_and_redeem') {
      result.rolled = true;
    }

    // ── 4c. Roll separately if action was plain 'buy' ─────────
    if (action === 'buy') {
      await waitForMirrorNode();
      try {
        const rollIntent = (await mcpRoll(
          pool.poolId,
          accountId
        )) as IntentResponse;
        const rollTx = await executeIntent(this.client, rollIntent);
        console.log(`    Rolled: ${rollTx.transactionId} (${rollTx.status})`);
        result.rolled = true;
      } catch (e) {
        console.error(`    Roll failed: ${errorMsg(e)}`);
      }
    }

    // ── 4d. Check for wins ────────────────────────────────────
    if (result.rolled) {
      await waitForMirrorNode();
      try {
        const state = await getUserState(accountId);
        result.wins = state.pendingPrizesCount;
        if (result.wins > 0) {
          console.log(`    Won ${result.wins} prize(s)!`);
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

  private async safeTransferPrizes(accountId: string): Promise<void> {
    try {
      await this.transferAllPrizes(accountId);
    } catch (e) {
      console.error(`  Prize transfer failed: ${errorMsg(e)}`);
    }
  }

  private async transferAllPrizes(accountId: string): Promise<void> {
    if (!this.strategyEngine.shouldTransferToOwner()) {
      console.log('  transferToOwner disabled in strategy.');
      return;
    }

    const ownerAddress = this.strategyEngine.getOwnerAddress();
    if (!ownerAddress) {
      console.log(
        '  No ownerAddress in strategy — prizes remain in agent wallet.'
      );
      console.log('  Set playStyle.ownerAddress to auto-forward prizes.');
      return;
    }

    // Check pending prizes via MCP read
    const state = await getUserState(accountId);
    if (state.pendingPrizesCount === 0) {
      console.log('  No pending prizes to transfer.');
      return;
    }

    console.log(
      `  ${state.pendingPrizesCount} pending prize(s) — ` +
        `transferring to ${ownerAddress}`
    );

    // Convert owner to EVM address for Solidity call
    const ownerEvmAddress = ownerAddress.startsWith('0x')
      ? ownerAddress
      : '0x' + AccountId.fromString(ownerAddress).toSolidityAddress();

    // Encode transferPendingPrizes(address recipient, uint256 index)
    // with MaxUint256 = type(uint256).max = transfer ALL prizes at once
    const iface = new Interface(LazyLottoABI as readonly string[]);
    const encoded = iface.encodeFunctionData('transferPendingPrizes', [
      ownerEvmAddress,
      MaxUint256,
    ]);

    // Execute via direct Hedera SDK contract call
    const contractId = await this.getContractId();
    const txResult = await executeEncodedCall(
      this.client,
      contractId,
      GAS_ESTIMATES.transferPendingPrizes.base,
      encoded
    );

    console.log(
      `  Transferred ${state.pendingPrizesCount} prize(s): ` +
        `${txResult.transactionId} (${txResult.status})`
    );
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

  private tokenBalance(tokens: TokenBalance[], tokenId: string): number {
    const t = tokens.find((tok) => tok.token_id === tokenId);
    if (!t) return 0;
    return t.balance / Math.pow(10, t.decimals);
  }
}
