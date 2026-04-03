import type { Client } from '@hashgraph/sdk';
import { createClient, getOperatorAccountId } from '../hedera/wallet.js';
import { LottoAgent } from '../agent/LottoAgent.js';
import { PersistentStore } from './PersistentStore.js';
import type { IStore } from './IStore.js';
import { UserLedger } from './UserLedger.js';
import { AccountingService } from './AccountingService.js';
import { DepositWatcher } from './DepositWatcher.js';
import { NegotiationHandler } from './NegotiationHandler.js';
import { GasTracker } from './GasTracker.js';
import type {
  CustodialConfig,
  UserAccount,
  PlaySessionResult,
  WithdrawalRecord,
  OperatorState,
} from './types.js';
import { UserNotFoundError, InsufficientBalanceError, UserInactiveError, hasAvailableToken, reserveSummary } from './types.js';
import type { SessionReport } from '../agent/ReportGenerator.js';
import { randomUUID } from 'node:crypto';
import { reconcile, type ReconciliationResult } from './Reconciliation.js';

// ── Health snapshot returned by getHealth() ─────────────────────

export interface AgentHealth {
  isRunning: boolean;
  startedAt: string | null;
  uptime: number;
  depositWatcherRunning: boolean;
  totalUsers: number;
  activeUsers: number;
  pendingReserves: Record<string, number>;
  errorCount: number;
  operator: OperatorState;
}

// ── MultiUserAgent ──────────────────────────────────────────────
//
// Main orchestrator for the multi-user custodial lottery agent.
// Ties together deposit watching, play scheduling, prize routing,
// and withdrawal processing for an arbitrary number of users
// sharing a single Hedera agent wallet.
//
// Design invariants:
//   - Per-user mutex prevents concurrent plays/withdrawals for the
//     same user. Different users can be processed in sequence but
//     never interleaved (prize disambiguation).
//   - Reserve-before-spend: funds are reserved from the user's
//     available balance before any on-chain interaction. On failure,
//     the full reservation is released.
//   - One user's failure never crashes the agent.
// ─────────────────────────────────────────────────────────────────

export class MultiUserAgent {
  private client!: Client;
  private store!: IStore;
  private ledger!: UserLedger;
  private accounting!: AccountingService;
  private depositWatcher!: DepositWatcher;
  private negotiation!: NegotiationHandler;
  private gasTracker!: GasTracker;
  private config: CustodialConfig;
  private isRunning = false;
  private startedAt: string | null = null;
  private errorCount = 0;

  // Per-user mutex to prevent concurrent plays/withdrawals
  private userLocks: Map<string, Promise<void>> = new Map();
  private lockResolvers: Map<string, () => void> = new Map();

  constructor(config: CustodialConfig) {
    this.config = config;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Initialize all subsystems. Must be called before start().
   *
   * 1. Create Hedera client from environment
   * 2. Load persistent state from disk
   * 3. Wire up accounting, ledger, deposit watcher, negotiation, gas tracker
   */
  async initialize(): Promise<void> {
    this.client = createClient();

    const agentAccountId = getOperatorAccountId(this.client);

    this.store = new PersistentStore(this.config.dataDir);
    await this.store.load();

    this.accounting = new AccountingService({
      client: this.client,
      tick: this.config.hcs20Tick,
      topicId: this.config.hcs20TopicId ?? undefined,
    });

    this.gasTracker = new GasTracker(this.store);

    this.ledger = new UserLedger(this.store, this.accounting, agentAccountId);

    this.depositWatcher = new DepositWatcher(
      agentAccountId,
      this.store,
      this.ledger,
      this.config,
    );

    this.negotiation = new NegotiationHandler(
      this.client,
      this.store,
      this.config,
      agentAccountId,
    );
  }

  /**
   * Start the agent: begin watching for deposits.
   */
  start(): void {
    this.isRunning = true;
    this.startedAt = new Date().toISOString();
    this.depositWatcher.start();
    console.log('[MultiUserAgent] Multi-user agent started');
  }

  /**
   * Gracefully stop the agent.
   *
   * 1. Stop accepting new work
   * 2. Stop the deposit watcher
   * 3. Wait for any in-progress user locks to drain
   * 4. Flush persistent state to disk
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    this.depositWatcher.stop();

    // Wait for all in-progress user locks to resolve
    const pending = Array.from(this.userLocks.values());
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }

    await this.store.flush();
    console.log('[MultiUserAgent] Multi-user agent stopped');
  }

  // ── Accounting Deployment ──────────────────────────────────────

  /**
   * One-time setup: deploy the HCS-20 accounting topic on Hedera.
   * Returns the newly created topic ID.
   */
  async deployAccounting(): Promise<string> {
    return this.accounting.deploy('LazyLotto Credits', '999999999');
  }

  // ── User Registration ──────────────────────────────────────────

  /**
   * Register a new user (or return existing) via the negotiation handler.
   */
  async registerUser(
    accountId: string,
    eoaAddress: string,
    strategyName: string,
    rakePercent?: number,
  ): Promise<UserAccount> {
    return this.negotiation.registerUser(accountId, eoaAddress, strategyName, rakePercent);
  }

  /**
   * Deactivate a user. After deregistration the user can only withdraw
   * their remaining balance.
   */
  deregisterUser(userId: string): void {
    this.ledger.deregisterUser(userId);
  }

  // ── Play ───────────────────────────────────────────────────────

  /**
   * Execute a play session for a single user.
   *
   * This is the most critical method. It:
   *   1. Acquires a per-user mutex (no concurrent plays for same user)
   *   2. Validates the user exists and is active
   *   3. Reserves funds from the user's available balance
   *   4. Creates a fresh LottoAgent with the user's strategy snapshot
   *   5. Runs the 6-phase play loop
   *   6. Settles actual spend, releases unused reserve
   *   7. Records the session and notifies the user
   *
   * On ANY failure after reservation, the full reserved amount is
   * released back to the user's available balance.
   */
  async playForUser(userId: string): Promise<PlaySessionResult> {
    await this.acquireLock(userId);

    const user = this.store.getUser(userId);
    if (!user) {
      this.releaseLock(userId);
      throw new UserNotFoundError(userId);
    }
    if (!user.active) {
      this.releaseLock(userId);
      throw new UserInactiveError(userId);
    }

    // Select the token with the highest available balance to play with.
    // Future enhancement: iterate all budgeted tokens and play each in sequence.
    let primaryToken = 'hbar';
    let bestAvailable = 0;
    for (const tokenKey of Object.keys(user.strategySnapshot.budget.tokenBudgets)) {
      const entry = user.balances.tokens[tokenKey];
      if (entry && entry.available > bestAvailable) {
        bestAvailable = entry.available;
        primaryToken = tokenKey;
      }
    }
    const firstTokenBudget = user.strategySnapshot.budget.tokenBudgets[primaryToken];
    // Get available balance for the primary token
    const tokenEntry = user.balances.tokens[primaryToken];
    const tokenAvailable = tokenEntry?.available ?? 0;
    const maxSession = firstTokenBudget?.maxPerSession ?? tokenAvailable;
    const sessionBudget = Math.min(maxSession, tokenAvailable);

    if (sessionBudget < this.config.minDepositAmount) {
      this.releaseLock(userId);
      throw new InsufficientBalanceError(userId, this.config.minDepositAmount, tokenAvailable);
    }

    // Reserve funds before any on-chain interaction
    this.ledger.reserve(userId, sessionBudget, primaryToken);

    try {
      // Build a user-specific strategy with their EOA as prize destination
      // Cap the token budget to the reserved amount to prevent overspend
      const cappedBudgets = { ...user.strategySnapshot.budget.tokenBudgets };
      if (cappedBudgets[primaryToken]) {
        cappedBudgets[primaryToken] = {
          ...cappedBudgets[primaryToken],
          maxPerSession: Math.min(cappedBudgets[primaryToken].maxPerSession, sessionBudget),
        };
      }
      const userStrategy = {
        ...user.strategySnapshot,
        budget: {
          ...user.strategySnapshot.budget,
          tokenBudgets: cappedBudgets,
        },
        playStyle: {
          ...user.strategySnapshot.playStyle,
          ownerAddress: user.eoaAddress,
          transferToOwner: true,
        },
      };

      // Create a fresh LottoAgent with user's strategy
      const agent = new LottoAgent(userStrategy);
      const report: SessionReport = await agent.play();

      // Settle: deduct actual spend from reserved
      const actualSpent = report.totalSpent;
      this.ledger.settleSpend(userId, actualSpent, primaryToken);

      // Release unused reserve
      const unused = sessionBudget - actualSpent;
      if (unused > 0) {
        this.ledger.releaseReserve(userId, unused, primaryToken);
      }

      // Estimate gas cost (~0.000000082 HBAR per gas unit, ~1.97M gas per pool)
      // Only count pools that actually executed on-chain transactions
      const poolsWithTx = report.poolResults.filter(r => r.entriesBought > 0).length;
      const estimatedGas = poolsWithTx * 1_970_000 * 0.000000082;
      if (estimatedGas > 0) {
        this.gasTracker.recordGas(
          `play-${userId}-${Date.now()}`,
          userId,
          'playSession',
          estimatedGas,
        );
      }

      // Build play session result
      const session: PlaySessionResult = {
        sessionId: randomUUID(),
        userId,
        timestamp: new Date().toISOString(),
        strategyName: user.strategyName,
        strategyVersion: user.strategyVersion,
        boostBps: 0,
        poolsEvaluated: report.poolsEvaluated,
        poolsPlayed: report.poolsPlayed,
        poolResults: report.poolResults.map((r) => ({
          poolId: r.poolId,
          poolName: r.poolName,
          entriesBought: r.entriesBought,
          amountSpent: r.amountSpent,
          rolled: r.rolled,
          wins: r.wins,
          prizeDetails: r.prizeDetails,
        })),
        totalSpent: actualSpent,
        totalWins: report.totalWins,
        totalPrizeValue: report.totalPrizeValue,
        prizesByToken: report.prizesByToken,
        prizesTransferred: true, // LottoAgent handles this in phase 5
        gasCostHbar: estimatedGas,
        amountReserved: sessionBudget,
        amountSettled: actualSpent,
        amountReleased: unused,
      };

      // Record play session
      this.store.recordPlaySession(session);

      // Update user's lastPlayedAt
      user.lastPlayedAt = session.timestamp;
      this.store.saveUser(user);

      // Batch HCS-20 accounting
      const hcs20Ops = report.poolResults
        .filter((r) => r.amountSpent > 0)
        .map((r) => ({
          op: 'burn' as const,
          amt: String(r.amountSpent),
          from: user.hederaAccountId,
          memo: `play:pool-${r.poolId}:${r.entriesBought}-entries`,
        }));

      if (hcs20Ops.length > 0) {
        try {
          await this.accounting.recordPlaySession(session.sessionId, hcs20Ops);
        } catch (e) {
          console.warn(
            '[MultiUserAgent] HCS-20 play session recording failed:',
            e instanceof Error ? e.message : e,
          );
        }
      }

      // Notify user via HCS-10
      try {
        await this.negotiation.notifyPlayResult(user, session);
      } catch {
        /* notification failure is not critical */
      }

      return session;
    } catch (error) {
      // CRITICAL: release ALL reserved funds on failure
      try {
        this.ledger.releaseReserve(userId, sessionBudget, primaryToken);
      } catch (releaseErr) {
        console.warn(
          `[MultiUserAgent] Failed to release reserve for ${userId}: ` +
            `${releaseErr instanceof Error ? releaseErr.message : releaseErr}. ` +
            'Funds may be recovered on restart.',
        );
      }
      throw error;
    } finally {
      this.releaseLock(userId);
    }
  }

  /**
   * Play for all eligible users sequentially.
   *
   * Users are eligible if they are active and have sufficient balance.
   * Sequential execution is mandatory: interleaving users would make
   * prize disambiguation impossible since the agent wallet is shared.
   *
   * Capped at config.maxUsersPerPlayCycle to bound cycle duration.
   */
  async playForAllEligible(): Promise<PlaySessionResult[]> {
    const results: PlaySessionResult[] = [];
    const eligible = this.store.getAllUsers().filter(
      (u) => u.active && hasAvailableToken(u.balances, this.config.minDepositAmount),
    );

    // Play SEQUENTIALLY -- never interleave users (prize disambiguation)
    for (const user of eligible.slice(0, this.config.maxUsersPerPlayCycle)) {
      try {
        const result = await this.playForUser(user.userId);
        results.push(result);
      } catch (e) {
        this.errorCount++;
        console.error(
          `[MultiUserAgent] Play failed for user ${user.userId}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    return results;
  }

  // ── Withdrawals ────────────────────────────────────────────────

  /**
   * Process a user withdrawal: deduct from ledger, execute on-chain
   * token transfer, record the withdrawal, and notify the user.
   *
   * Uses per-user mutex to prevent concurrent withdrawals/plays.
   */
  async processWithdrawal(userId: string, amount: number, token: string = 'hbar'): Promise<WithdrawalRecord> {
    await this.acquireLock(userId);
    try {
      const user = this.store.getUser(userId);
      if (!user) throw new UserNotFoundError(userId);

      // Use the token parameter for withdrawal currency selection
      const withdrawToken = token;
      const isHbar = withdrawToken === 'hbar';

      // Reserve funds first — safe to release if transfer fails
      this.ledger.reserve(userId, amount, withdrawToken);
      let transactionId: string;
      try {
        const { transferHbar, transferToken } = await import('../hedera/transfers.js');
        const sender = getOperatorAccountId(this.client);
        if (isHbar) {
          const result = await transferHbar(this.client, sender, user.hederaAccountId, amount);
          transactionId = result.transactionId;
        } else {
          // Use the actual token ID (not hardcoded LAZY) for any FT withdrawal
          const result = await transferToken(this.client, sender, user.hederaAccountId, withdrawToken, amount);
          transactionId = result.transactionId;
        }
      } catch (transferError) {
        // CRITICAL: release reserved funds on transfer failure
        this.ledger.releaseReserve(userId, amount, withdrawToken);
        throw transferError;
      }

      // Transfer succeeded — settle the withdrawal
      this.ledger.settleSpend(userId, amount, withdrawToken);
      // Update totalWithdrawn on the specific token entry
      this.store.updateBalance(userId, (b) => {
        const entry = b.tokens[withdrawToken];
        if (entry) entry.totalWithdrawn += amount;
        return b;
      });

      // Flush immediately — critical for crash safety (prevents double-withdraw)
      await this.store.flush();

      // Record via HCS-20 (non-blocking)
      try {
        await this.accounting.recordWithdrawal(user.hederaAccountId, amount);
      } catch {
        /* accounting failure is not blocking */
      }

      const record: WithdrawalRecord = {
        userId,
        amount,
        tokenId: isHbar ? null : withdrawToken,
        recipientAccountId: user.hederaAccountId,
        transactionId,
        timestamp: new Date().toISOString(),
      };

      this.store.recordWithdrawal(record);

      const newBalance = this.ledger.getBalance(userId);

      // Notify user
      try {
        await this.negotiation.notifyWithdrawalConfirmed(user, amount, transactionId, newBalance);
      } catch {
        /* notification not critical */
      }

      return record;
    } finally {
      this.releaseLock(userId);
    }
  }

  /**
   * Withdraw accumulated rake fees to the operator's recipient account.
   *
   * 1. Validate operator has sufficient balance for the given token
   * 2. Execute HBAR/LAZY TransferTransaction to the recipient
   * 3. Update operator state: deduct from balances, increment totalWithdrawnByOperator
   * 4. Record via HCS-20 accounting
   * 5. Return the on-chain transaction ID
   */
  async operatorWithdrawFees(
    amount: number,
    recipientAccountId: string,
    token: 'HBAR' | 'LAZY' = 'HBAR',
  ): Promise<string> {
    // Restrict withdrawal to pre-configured address if set
    const allowedAddress = process.env.OPERATOR_WITHDRAW_ADDRESS;
    if (allowedAddress && recipientAccountId !== allowedAddress) {
      throw new Error(
        `Operator withdrawal restricted to ${allowedAddress}. ` +
          `Requested: ${recipientAccountId}`
      );
    }

    const operator = this.store.getOperator();
    const tokenKey = token === 'HBAR' ? 'hbar' : (process.env.LAZY_TOKEN_ID ?? 'lazy');
    const tokenBalance = operator.balances[tokenKey] ?? 0;
    if (tokenBalance < amount) {
      throw new InsufficientBalanceError('operator', amount, tokenBalance);
    }

    // For HBAR withdrawals, ensure enough gas remains for active users.
    // Each active user with a positive balance needs gasReservePerUser HBAR
    // to cover transaction fees for their play/withdrawal operations.
    if (token === 'HBAR') {
      const activeWithBalance = this.store.getAllUsers().filter((u) => {
        if (!u.active) return false;
        return Object.values(u.balances.tokens).some((e) => e.available > 0 || e.reserved > 0);
      });
      const requiredReserve = activeWithBalance.length * this.config.gasReservePerUser;
      const { hbarToNumber } = await import('../utils/format.js');
      const { getWalletInfo } = await import('../hedera/wallet.js');
      const info = await getWalletInfo(this.client);
      const walletHbar = hbarToNumber(info.hbarBalance);
      const remainingAfter = walletHbar - amount;
      if (remainingAfter < requiredReserve) {
        throw new Error(
          `Operator HBAR withdrawal would leave ${remainingAfter.toFixed(2)} HBAR in wallet, ` +
            `but ${activeWithBalance.length} active user(s) require ${requiredReserve.toFixed(2)} HBAR ` +
            `gas reserve (${this.config.gasReservePerUser} HBAR/user). ` +
            `Max withdrawable: ${Math.max(0, walletHbar - requiredReserve).toFixed(2)} HBAR.`
        );
      }
    }

    const { transferHbar, transferToken } = await import('../hedera/transfers.js');
    const sender = getOperatorAccountId(this.client);

    let transactionId: string;

    if (token === 'HBAR') {
      const result = await transferHbar(this.client, sender, recipientAccountId, amount);
      transactionId = result.transactionId;
    } else {
      const lazyTokenId = process.env.LAZY_TOKEN_ID;
      if (!lazyTokenId) throw new Error('LAZY_TOKEN_ID not configured');
      const result = await transferToken(this.client, sender, recipientAccountId, lazyTokenId, amount);
      transactionId = result.transactionId;
    }

    // Update operator state
    this.store.updateOperator((op) => ({
      ...op,
      balances: { ...op.balances, [tokenKey]: (op.balances[tokenKey] ?? 0) - amount },
      totalWithdrawnByOperator: { ...op.totalWithdrawnByOperator, [tokenKey]: (op.totalWithdrawnByOperator[tokenKey] ?? 0) + amount },
    }));

    // Record via HCS-20 accounting (non-blocking)
    try {
      await this.accounting.recordOperatorWithdrawal(
        getOperatorAccountId(this.client),
        amount,
      );
    } catch (e) {
      console.warn(
        '[MultiUserAgent] HCS-20 operator withdrawal recording failed:',
        e instanceof Error ? e.message : e,
      );
    }

    return transactionId;
  }

  // ── Queries ────────────────────────────────────────────────────

  /**
   * Return the operator's accumulated balance and totals.
   */
  getOperatorBalance(): OperatorState {
    return this.store.getOperator();
  }

  /**
   * Return a structured health snapshot of the agent.
   */
  getHealth(): AgentHealth {
    const allUsers = this.store.getAllUsers();
    return {
      isRunning: this.isRunning,
      startedAt: this.startedAt,
      uptime: this.startedAt
        ? Date.now() - new Date(this.startedAt).getTime()
        : 0,
      depositWatcherRunning: this.depositWatcher.isRunning(),
      totalUsers: allUsers.length,
      activeUsers: allUsers.filter((u) => u.active).length,
      pendingReserves: reserveSummary(
        allUsers.reduce(
          (merged, u) => {
            for (const [t, e] of Object.entries(u.balances.tokens)) {
              if (!merged.tokens[t]) merged.tokens[t] = { available: 0, reserved: 0, totalDeposited: 0, totalWithdrawn: 0, totalRake: 0 };
              merged.tokens[t].reserved += e.reserved;
            }
            return merged;
          },
          { tokens: {} } as import('./types.js').UserBalances
        )
      ),
      errorCount: this.errorCount,
      operator: this.store.getOperator(),
    };
  }

  /**
   * Run on-chain balance reconciliation against the internal ledger.
   */
  async reconcile(): Promise<ReconciliationResult> {
    return reconcile(this.client, this.store);
  }

  /**
   * Return a single user's account and balance information.
   * Returns undefined if the user does not exist.
   */
  getUserStatus(userId: string): UserAccount | undefined {
    return this.store.getUser(userId);
  }

  /**
   * Return all registered users' account and balance information.
   */
  getAllUsersStatus(): UserAccount[] {
    return this.store.getAllUsers();
  }

  /**
   * Return play session history for a specific user.
   */
  getPlayHistory(userId: string): PlaySessionResult[] {
    return this.store.getPlaySessionsForUser(userId);
  }

  // ── Per-user Mutex ─────────────────────────────────────────────
  //
  // Simple promise-based mutex keyed by userId. Ensures that play
  // sessions and withdrawals for the same user are serialized.
  // Different users do NOT block each other (though playForAllEligible
  // is inherently sequential for prize disambiguation reasons).

  private static readonly LOCK_TIMEOUT_MS = 300_000; // 5 minutes

  private async acquireLock(userId: string): Promise<void> {
    const deadline = Date.now() + MultiUserAgent.LOCK_TIMEOUT_MS;
    while (this.userLocks.has(userId)) {
      if (Date.now() > deadline) {
        throw new Error(
          `Lock timeout for user ${userId} — a previous operation may be hung`
        );
      }
      await this.userLocks.get(userId);
    }
    // Install a new lock
    let resolveFn!: () => void;
    this.userLocks.set(
      userId,
      new Promise<void>((r) => {
        resolveFn = r;
      }),
    );
    this.lockResolvers.set(userId, resolveFn);
  }

  private releaseLock(userId: string): void {
    const resolver = this.lockResolvers.get(userId);
    this.userLocks.delete(userId);
    this.lockResolvers.delete(userId);
    resolver?.();
  }
}
