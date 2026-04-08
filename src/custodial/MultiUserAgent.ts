import type { Client } from '@hashgraph/sdk';
import { createClient, getOperatorAccountId } from '../hedera/wallet.js';
import { LottoAgent } from '../agent/LottoAgent.js';
import type { IStore } from './IStore.js';
import { UserLedger } from './UserLedger.js';
import { AccountingService } from './AccountingService.js';
import { DepositWatcher, type DepositWatcherStats } from './DepositWatcher.js';
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
import { computePoolsRoot, type PrizeEntry } from './hcs20-v2.js';
import type { SessionReport } from '../agent/ReportGenerator.js';
import { randomUUID } from 'node:crypto';
import { reconcile, type ReconciliationResult } from './Reconciliation.js';
import { logger } from '../lib/logger.js';
import { assertKillSwitchDisabled } from '../lib/killswitch.js';
import { acquireOperatorLock, releaseOperatorLock } from '../lib/locks.js';
import { HBAR_TOKEN_KEY } from '../config/strategy.js';

// ── HCS-20 v2 helpers ─────────────────────────────────────────────
//
// Local helpers used by the play session emission path. Kept at
// module scope rather than as MultiUserAgent methods because they're
// pure conversion / mapping functions with no agent state.

/**
 * Map a PoolResult.feeTokenId to the spentToken value the v2 audit
 * messages should carry. The audit reader uses this to attribute
 * spending per token, and external auditors rely on it to verify
 * the agent didn't lie about which token was charged.
 *
 * "hbar" / "HBAR" / "" → "HBAR" (canonical native form)
 * Hedera token ID (0.0.X) → returned unchanged
 *
 * The reader and the writer must agree on this mapping or the
 * poolsRoot Merkle hash on play_session_close won't match what the
 * reader recomputes from the pool messages it actually saw.
 */
function poolFeeTokenForAudit(feeTokenId: string | undefined): string {
  if (!feeTokenId) return 'HBAR';
  if (feeTokenId === 'hbar' || feeTokenId === 'HBAR') return 'HBAR';
  return feeTokenId;
}

/**
 * Convert the agent's internal PrizeDetail[] shape (from
 * ReportGenerator) into the v2 wire shape PrizeEntry[]. Folds NFT
 * prizes by token ID so each NFT collection becomes a single entry
 * with a serials array, even if the prize details listed serials
 * individually.
 */
function convertPrizeDetailsToV2(
  prizeDetails: { fungibleAmount?: number; fungibleToken?: string; nfts?: { token: string; hederaId: string; serial: number }[] }[],
): PrizeEntry[] {
  const result: PrizeEntry[] = [];
  // Group NFT serials by hederaId so a multi-serial win lands as one
  // entry. The wire shape supports an array of serials per token.
  const nftByToken = new Map<string, { sym: string; serials: Set<number> }>();

  for (const d of prizeDetails) {
    if (d.fungibleAmount && d.fungibleAmount > 0 && d.fungibleToken) {
      result.push({ t: 'ft', tk: d.fungibleToken, amt: d.fungibleAmount });
    }
    for (const n of d.nfts ?? []) {
      const key = n.hederaId;
      if (!nftByToken.has(key)) {
        nftByToken.set(key, { sym: n.token, serials: new Set() });
      }
      nftByToken.get(key)!.serials.add(n.serial);
    }
  }

  for (const [hederaId, { sym, serials }] of nftByToken) {
    result.push({
      t: 'nft',
      tk: hederaId,
      sym,
      ser: Array.from(serials).sort((a, b) => a - b),
    });
  }

  return result;
}

/**
 * Map the LottoAgent PrizeTransferOutcome (in-process discriminated
 * union) to the v2 wire shape on play_session_close.prizeTransfer.
 * "Skipped" sessions (no prizes won) write status:'skipped' which
 * the reader treats as a successful close — there was nothing to
 * transfer.
 */
function mapPrizeTransferOutcome(
  outcome:
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
      }
    | undefined,
): {
  status: 'succeeded' | 'skipped' | 'failed' | 'recovered';
  txId?: string;
  attempts?: number;
  gasUsed?: number;
  lastError?: string;
} {
  if (!outcome) return { status: 'skipped' };
  if (outcome.status === 'skipped') return { status: 'skipped' };
  if (outcome.status === 'succeeded') {
    return {
      status: 'succeeded',
      txId: outcome.contractTxId,
      attempts: outcome.attempt,
      gasUsed: outcome.gasUsed,
    };
  }
  // failed
  return {
    status: 'failed',
    attempts: outcome.attemptsLog.length,
    lastError: outcome.error,
  };
}

// ── Health snapshot returned by getHealth() ─────────────────────

export interface AgentHealth {
  mode: 'cli' | 'serverless';
  isRunning: boolean;
  startedAt: string | null;
  uptime: number;
  depositWatcherRunning: boolean;
  depositDetection: 'background-poll' | 'on-demand';
  /**
   * Per-instance deposit watcher stats. In serverless mode these reset
   * each time a Lambda cold-starts and only reflect that one container's
   * activity since boot — not a global cluster total. They're still
   * useful as a "did this Lambda see any deposits at all?" health check.
   */
  deposits: DepositWatcherStats;
  /** Number of entries in the dead-letter queue (across all instances, persisted). */
  deadLetterCount: number;
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
   * 1. Create Hedera client from environment (or use injected client)
   * 2. Load persistent state (or use injected store)
   * 3. Wire up accounting, ledger, deposit watcher, negotiation, gas tracker
   *
   * @param options.store  Inject a pre-existing store (serverless: avoids double-instantiation)
   * @param options.client Inject a pre-existing Hedera client
   */
  async initialize(options?: { store?: IStore; client?: Client }): Promise<void> {
    this.client = options?.client ?? createClient();

    const agentAccountId = getOperatorAccountId(this.client);

    if (options?.store) {
      this.store = options.store;
    } else {
      const { createStore } = await import('./createStore.js');
      this.store = await createStore();
    }

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
   * Record an operator control event (e.g. kill switch toggle) on the
   * HCS-20 audit trail. Delegates to AccountingService so the admin
   * route doesn't need to reach into private fields.
   */
  async recordControlEvent(
    event: 'killswitch_enabled' | 'killswitch_disabled',
    details: { reason?: string; by: string },
  ): Promise<void> {
    await this.accounting.recordControlEvent(event, details);
  }

  /**
   * Start the agent: begin watching for deposits.
   */
  start(): void {
    this.isRunning = true;
    this.startedAt = new Date().toISOString();
    this.depositWatcher.start();
    logger.info('multi-user agent started', {
      component: 'MultiUserAgent',
      event: 'agent_started',
    });
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
    logger.info('multi-user agent stopped', {
      component: 'MultiUserAgent',
      event: 'agent_stopped',
    });
  }

  /**
   * Run a single deposit poll cycle against the mirror node.
   * Used in serverless mode where the background watcher doesn't run.
   * Returns the number of deposits successfully processed.
   */
  async pollDepositsOnce(): Promise<number> {
    return this.depositWatcher.pollOnce();
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
    // Domain-layer gate: any caller (MCP tool, Next.js route, HCS-10
    // handler, test harness) must go through this method and therefore
    // cannot bypass the kill switch by skipping the route layer.
    await assertKillSwitchDisabled();
    return this.negotiation.registerUser(accountId, eoaAddress, strategyName, rakePercent);
  }

  /**
   * Deactivate a user. After deregistration the user can only withdraw
   * their remaining balance.
   */
  deregisterUser(userId: string): void {
    this.ledger.deregisterUser(userId);
  }

  /**
   * Switch an existing user to a different strategy preset. Available
   * presets are defined in NegotiationHandler.AVAILABLE_STRATEGIES.
   * The user's balances, deposit memo, and registration date are
   * preserved — only the strategy snapshot changes. Takes effect on
   * the next play session.
   */
  async updateUserStrategy(
    userId: string,
    newStrategyName: string,
  ): Promise<UserAccount> {
    await assertKillSwitchDisabled();
    return this.negotiation.updateUserStrategy(userId, newStrategyName);
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
    // Domain-layer kill switch gate — runs BEFORE lock acquisition so a
    // frozen agent doesn't even briefly hold the user mutex. Covers CLI
    // cron, MCP tools, API routes, tests — no caller can bypass it.
    await assertKillSwitchDisabled();

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

    // ── Per-token reservation (Stage 2) ──────────────────────
    //
    // Build a Map<token, reservedAmount> over the intersection of:
    //   - tokens the user has positive balance in
    //   - tokens the strategy budgets
    //
    // We reserve the per-token cap (or the user's full balance if
    // smaller) for each one. The resulting set defines exactly
    // which fee tokens the play loop can spend in. This replaces
    // the old "pick one primary token" approach which conflated
    // billing with selection and let cross-token spending leak
    // operator funds. See the Stage 1 commit message for the
    // incident background.
    //
    // After play, we settle each token independently from
    // report.poolResults grouped by feeTokenId — no more sum-
    // across-tokens math. Unused reservations are released per
    // token. If any pool spent a token we didn't reserve, that's
    // a defense-in-depth invariant violation and we throw.
    const tokenReservations = new Map<string, number>();
    for (const [tokenKey, tokenBudget] of Object.entries(user.strategySnapshot.budget.tokenBudgets)) {
      const entry = user.balances.tokens[tokenKey];
      const available = entry?.available ?? 0;
      if (available <= 0) continue;
      const cap = tokenBudget.maxPerSession ?? available;
      const reserve = Math.min(cap, available);
      if (reserve > 0) {
        tokenReservations.set(tokenKey, reserve);
      }
    }

    if (tokenReservations.size === 0) {
      this.releaseLock(userId);
      // Pick a representative balance for the error message — HBAR if
      // the user has any, otherwise just 0. The error tells the user
      // they need to deposit before they can play.
      const hbarAvail = user.balances.tokens[HBAR_TOKEN_KEY]?.available ?? 0;
      throw new InsufficientBalanceError(userId, this.config.minDepositAmount, hbarAvail);
    }

    // The "primary token" concept is retained for legacy session
    // record fields and backward-compat ledger calls, but it's
    // now derived from the largest reservation rather than driving
    // settlement.
    let primaryToken = 'hbar';
    let largestReservation = 0;
    for (const [token, amount] of tokenReservations) {
      if (amount > largestReservation) {
        largestReservation = amount;
        primaryToken = token;
      }
    }
    // sessionBudget kept for legacy fields (amountReserved on
    // PlaySessionResult). It's the largest single-token
    // reservation, which is correct as a "headline" number even
    // when multi-token plays happen.
    const sessionBudget = largestReservation;

    if (largestReservation < this.config.minDepositAmount) {
      this.releaseLock(userId);
      throw new InsufficientBalanceError(userId, this.config.minDepositAmount, largestReservation);
    }

    // Reserve every token in the set. If any reservation throws
    // (insufficient balance race), release everything that did
    // succeed and bail.
    const successfullyReserved: { token: string; amount: number }[] = [];
    try {
      for (const [token, amount] of tokenReservations) {
        this.ledger.reserve(userId, amount, token);
        successfullyReserved.push({ token, amount });
      }
    } catch (reserveErr) {
      for (const r of successfullyReserved) {
        try {
          this.ledger.releaseReserve(userId, r.amount, r.token);
        } catch {
          /* best effort */
        }
      }
      this.releaseLock(userId);
      throw reserveErr;
    }

    try {
      // Build a user-specific strategy with their EOA as prize
      // destination. Cap each reserved token's budget to the
      // amount we actually reserved for it, so the LottoAgent
      // budget manager can't overspend. Drop any token from
      // tokenBudgets that we didn't reserve (because the user
      // had 0 balance in it) — the play loop will then refuse
      // to consider pools in that token via maxEntriesForPool().
      const cappedBudgets: Record<string, { maxPerSession: number; maxPerPool: number; reserve: number }> = {};
      for (const [token, reserved] of tokenReservations) {
        const original = user.strategySnapshot.budget.tokenBudgets[token];
        if (!original) continue;
        cappedBudgets[token] = {
          ...original,
          maxPerSession: Math.min(original.maxPerSession, reserved),
        };
      }

      // Pool filter override: restrict to tokens the user has
      // reservations in. Uses the v2 FeeTokenFilterSchema which
      // supports an array form, so mixed-balance users (both HBAR
      // and LAZY) get a precise allow-list instead of falling back
      // to 'any'. Prevents any chance of the play loop considering
      // pools in tokens the user can't afford.
      const lazyTokenId = process.env.LAZY_TOKEN_ID;
      const hasHbarReservation = tokenReservations.has(HBAR_TOKEN_KEY);
      const hasLazyReservation = lazyTokenId ? tokenReservations.has(lazyTokenId) : false;
      let restrictedFeeToken: 'HBAR' | 'LAZY' | 'any' | ('HBAR' | 'LAZY')[];
      if (hasHbarReservation && hasLazyReservation) {
        // Both funded — use the array form for a precise allow-list
        restrictedFeeToken = ['HBAR', 'LAZY'];
      } else if (hasHbarReservation) {
        restrictedFeeToken = 'HBAR';
      } else if (hasLazyReservation) {
        restrictedFeeToken = 'LAZY';
      } else {
        // Neither funded — would have errored above but defensive
        restrictedFeeToken = 'any';
      }
      if (restrictedFeeToken !== user.strategySnapshot.poolFilter.feeToken) {
        logger.info('pool filter restricted to user-funded tokens', {
          component: 'MultiUserAgent',
          event: 'pool_filter_restricted',
          userId,
          original: user.strategySnapshot.poolFilter.feeToken,
          restricted: restrictedFeeToken,
          reservedTokens: Array.from(tokenReservations.keys()),
        });
      }

      const userStrategy = {
        ...user.strategySnapshot,
        poolFilter: {
          ...user.strategySnapshot.poolFilter,
          feeToken: restrictedFeeToken,
        },
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

      // Set lastPlayedAt BEFORE balance operations so that the user object
      // written to Redis by updateBalance() already includes the timestamp.
      // (async fire-and-forget writes can race; the last write wins)
      user.lastPlayedAt = new Date().toISOString();

      // ── Per-token settlement (Stage 2) ─────────────────────
      //
      // Compute spending per token from report.poolResults using
      // the new feeTokenId field. This replaces the old approach
      // of summing totalSpent across all tokens (meaningless cross-
      // token arithmetic) and settling against a single primary
      // token (causing the user to be billed for the wrong token).
      //
      // Defense-in-depth: if any pool spent a token that wasn't
      // in our reservation set, throw — that means the play loop
      // bypassed the budget cap somehow, which is a bug worth
      // crashing on. The catch block below will release every
      // reservation that's still outstanding.
      const spentByTokenId = new Map<string, number>();
      for (const r of report.poolResults) {
        if (r.amountSpent <= 0) continue;
        const token = r.feeTokenId || HBAR_TOKEN_KEY;
        spentByTokenId.set(token, (spentByTokenId.get(token) ?? 0) + r.amountSpent);
      }
      for (const [token, spent] of spentByTokenId) {
        if (!tokenReservations.has(token)) {
          throw new Error(
            `BUG: play loop spent ${spent} of token ${token} but no reservation existed. ` +
              `Reserved tokens: ${Array.from(tokenReservations.keys()).join(', ')}. ` +
              `Releasing all reservations.`,
          );
        }
      }
      // Settle and release per token
      let totalSpentAllTokens = 0;
      for (const [token, reservedAmount] of tokenReservations) {
        const actualSpent = spentByTokenId.get(token) ?? 0;
        if (actualSpent > 0) {
          this.ledger.settleSpend(userId, actualSpent, token);
        }
        const unused = reservedAmount - actualSpent;
        if (unused > 0) {
          this.ledger.releaseReserve(userId, unused, token);
        }
        totalSpentAllTokens += actualSpent; // legacy field, sum across tokens
      }
      // Legacy variable retained because the session record still
      // has a single `totalSpent` field. It's the sum-across-tokens
      // value (semantically meaningful only when all spending is
      // in one token, but kept for backward compat with consumers
      // that don't yet read spentByToken).
      const actualSpent = totalSpentAllTokens;

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

      // Truthful prize-transfer status from LottoAgent (Task A).
      // Phase 5 may have succeeded, skipped, or failed-with-retries —
      // the SessionReport now carries the outcome via prizeTransferOutcome
      // and we propagate it instead of the previous hardcoded `true`.
      const transferOutcome = report.prizeTransferOutcome;
      const prizesActuallyTransferred =
        transferOutcome?.status === 'succeeded' ||
        transferOutcome?.status === 'skipped';

      // Build play session result
      const sessionId = randomUUID();
      const session: PlaySessionResult = {
        sessionId,
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
        prizesTransferred: prizesActuallyTransferred,
        gasCostHbar: estimatedGas,
        amountReserved: sessionBudget,
        amountSettled: actualSpent,
        // amountReleased is the legacy single-token-released field.
        // After per-token settlement it becomes the sum of unused
        // releases across all tokens — same semantics as the legacy
        // field for HBAR-only sessions, slightly different for
        // multi-token sessions but still useful as a "headline"
        // number that consumers can display.
        amountReleased: Array.from(tokenReservations).reduce(
          (sum, [token, reserved]) => sum + Math.max(0, reserved - (spentByTokenId.get(token) ?? 0)),
          0,
        ),
      };

      // Record play session and persist user (lastPlayedAt already set above)
      this.store.recordPlaySession(session);
      this.store.saveUser(user);

      // Dead-letter the failure (Task B). When phase 5 exhausts the
      // retry ladder we record a structured entry the operator can
      // see in the admin dashboard and resolve via the recovery tool.
      // The contract call has already failed; the prizes are stranded
      // in the agent wallet until an operator runs the recovery.
      if (transferOutcome?.status === 'failed') {
        try {
          this.store.recordDeadLetter({
            transactionId: sessionId, // sessionId is the natural key for prize failures
            timestamp: new Date().toISOString(),
            error: transferOutcome.error,
            sender: user.hederaAccountId,
            kind: 'prize_transfer_failed',
            details: {
              userId,
              sessionId,
              prizesByToken: report.prizesByToken,
              prizeCount: transferOutcome.prizeCount,
              attemptsLog: transferOutcome.attemptsLog,
              ownerEoa: transferOutcome.ownerEoa,
            },
          });
          logger.error('prize transfer dead-lettered', {
            component: 'MultiUserAgent',
            event: 'prize_transfer_failed',
            userId,
            sessionId,
            prizeCount: transferOutcome.prizeCount,
            attempts: transferOutcome.attemptsLog.length,
            error: transferOutcome.error,
          });
        } catch (deadLetterErr) {
          // Don't let a dead-letter write failure cascade. The
          // session record itself is already saved with
          // prizesTransferred:false, so the failure is at least
          // visible there.
          logger.warn('failed to dead-letter prize transfer', {
            component: 'MultiUserAgent',
            event: 'dead_letter_write_failed',
            userId,
            sessionId,
            error: deadLetterErr instanceof Error ? deadLetterErr.message : String(deadLetterErr),
          });
        }
      }

      logger.info('play session completed', {
        component: 'MultiUserAgent',
        event: 'play_completed',
        userId,
        sessionId: session.sessionId,
        poolsPlayed: session.poolsPlayed,
        totalSpent: actualSpent,
        totalWins: session.totalWins,
        token: primaryToken,
      });

      // ── HCS-20 v2 audit trail emission ─────────────────────
      //
      // Replace the v1 single-batch message with a structured
      // sequence: open → N pool results → close (or aborted).
      // This makes the audit trail self-sufficient on chain so an
      // independent third party can reconstruct the session
      // without joining against our local PlaySessionResult store.
      //
      // The sequence is wrapped in its own try/catch with an
      // aborted fallback. If any v2 write fails (HCS topic
      // unavailable, agent process killed mid-sequence, contract
      // dispute), we attempt to write play_session_aborted with
      // the count of pool messages that did make it through. The
      // reader's state machine treats aborted as a positive
      // terminal marker (vs missing close → orphaned).
      //
      // Order of writes matters: HCS preserves consensus order
      // within a topic, so the reader sees open before pools
      // before close as long as we await sequentially.
      const agentAccountId = getOperatorAccountId(this.client);
      const playedPools = report.poolResults.filter((r) => r.entriesBought > 0);
      let v2WrittenPools = 0;
      try {
        // 1. Open
        await this.accounting.recordPlaySessionOpen({
          sessionId: session.sessionId,
          user: user.hederaAccountId,
          agent: agentAccountId,
          strategy: user.strategyName,
          boostBps: 0,
          expectedPools: playedPools.length,
        });

        // 2. Per-pool results — sequential await for chain ordering.
        //
        // spentToken now reads from PoolResult.feeTokenId rather
        // than being hardcoded to 'HBAR'. The Stage 2 per-token
        // refactor relies on this for downstream readers /
        // reconciliation to know which token each pool actually
        // charged. Without it, a LAZY pool would show up on the
        // audit trail labelled 'HBAR' and break reconciliation
        // for any third party reading the topic.
        for (let i = 0; i < playedPools.length; i++) {
          const pool = playedPools[i]!;
          const prizes = convertPrizeDetailsToV2(pool.prizeDetails ?? []);
          const spentToken = poolFeeTokenForAudit(pool.feeTokenId);
          await this.accounting.recordPlayPoolResult({
            sessionId: session.sessionId,
            user: user.hederaAccountId,
            agent: agentAccountId,
            poolId: pool.poolId,
            seq: i + 1,
            entries: pool.entriesBought,
            spent: pool.amountSpent,
            spentToken,
            wins: pool.wins,
            prizes,
          });
          v2WrittenPools++;
        }

        // 3. Close — compute Merkle root from the canonical pool data
        const poolsRoot = await computePoolsRoot(
          playedPools.map((p) => ({
            poolId: p.poolId,
            spent: p.amountSpent,
            spentToken: poolFeeTokenForAudit(p.feeTokenId),
            wins: p.wins,
            prizes: convertPrizeDetailsToV2(p.prizeDetails ?? []),
          })),
        );
        await this.accounting.recordPlaySessionClose({
          sessionId: session.sessionId,
          user: user.hederaAccountId,
          agent: agentAccountId,
          poolsPlayed: playedPools.length,
          poolsRoot,
          totalWins: report.totalWins,
          prizeTransfer: mapPrizeTransferOutcome(transferOutcome),
        });
      } catch (v2Err) {
        // V2 sequence partial-write recovery. Try to emit aborted
        // with whatever we have. This is best-effort; if even the
        // aborted write fails the session ends up as orphaned in
        // the reader's state machine, which is still distinguishable
        // from "closed_success" — operators see it and investigate.
        const errMsg = v2Err instanceof Error ? v2Err.message : String(v2Err);
        console.warn(
          `[MultiUserAgent] HCS-20 v2 sequence failed (wrote ${v2WrittenPools}/${playedPools.length} pools): ${errMsg}`,
        );
        try {
          await this.accounting.recordPlaySessionAborted({
            sessionId: session.sessionId,
            user: user.hederaAccountId,
            agent: agentAccountId,
            completedPools: v2WrittenPools,
            reason: 'v2_write_failure',
            lastError: errMsg,
          });
        } catch (abortErr) {
          console.warn(
            '[MultiUserAgent] V2 aborted marker also failed (session will be orphaned in reader):',
            abortErr instanceof Error ? abortErr.message : abortErr,
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
      // CRITICAL: release every reservation on failure (per-token).
      // The catch is wide because:
      //   - If play() threw, no settlement happened, so the full
      //     reservation is still locked.
      //   - If play() returned but settlement threw on a defense-
      //     in-depth check, some tokens may have been settled and
      //     others not. We track which we settled on the success
      //     path; here we just attempt to release everything that's
      //     in tokenReservations and let releaseReserve clamp to
      //     whatever's actually still reserved (it min()s against
      //     entry.reserved internally).
      for (const [token, amount] of tokenReservations) {
        try {
          this.ledger.releaseReserve(userId, amount, token);
        } catch (releaseErr) {
          console.warn(
            `[MultiUserAgent] Failed to release reserve for ${userId} token=${token}: ` +
              `${releaseErr instanceof Error ? releaseErr.message : releaseErr}. ` +
              'Funds may be recovered on restart.',
          );
        }
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
    // Fail fast if the kill switch is engaged — avoid scanning the user
    // list only to have each playForUser() throw. (playForUser() also
    // checks; this is defense in depth + early exit.)
    await assertKillSwitchDisabled();

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

      // Velocity cap: limit total withdrawal volume per user per 24 hours.
      // Bounds blast radius if a user session is compromised.
      //
      // Normalize the token key first — callers may pass 'hbar', 'HBAR',
      // 'Hbar', or a raw token ID. Without normalization, a string-literal
      // compare like `token === 'hbar'` silently disables the cap for
      // 'HBAR' (uppercase) — a very plausible caller bug.
      const normalizedToken = token.toLowerCase();
      const isHbar = normalizedToken === 'hbar' || normalizedToken === HBAR_TOKEN_KEY;

      // Caps are per-token. HBAR cap is the primary one. FT caps default
      // to a very large number unless WITHDRAWAL_DAILY_CAP_<TOKEN> is set
      // (e.g. WITHDRAWAL_DAILY_CAP_LAZY). A zero value disables the cap.
      const capEnvKey = isHbar
        ? 'WITHDRAWAL_DAILY_CAP_HBAR'
        : `WITHDRAWAL_DAILY_CAP_${normalizedToken.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
      const capDefault = isHbar ? 1000 : Number.POSITIVE_INFINITY;
      const dailyCap = Number(process.env[capEnvKey] ?? capDefault);

      if (Number.isFinite(dailyCap) && dailyCap > 0) {
        const remaining = await this.checkWithdrawalVelocity(
          userId,
          amount,
          dailyCap,
          normalizedToken,
        );
        if (remaining < 0) {
          throw new Error(
            `Daily withdrawal cap exceeded for user ${userId}. ` +
            `Cap: ${dailyCap} ${normalizedToken}, would exceed by ${Math.abs(remaining)}. ` +
            `Try a smaller amount or wait for the rolling window to reset.`,
          );
        }
      }

      // Use the normalized token for downstream logic
      const withdrawToken = normalizedToken;

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

      // Record via HCS-20 (non-blocking) — pass token so the on-chain
      // record carries the underlying asset identity. The audit reader
      // prefers the explicit token over the legacy tick heuristic.
      try {
        await this.accounting.recordWithdrawal(user.hederaAccountId, amount, withdrawToken);
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

      logger.info('withdrawal processed', {
        component: 'MultiUserAgent',
        event: 'withdrawal_processed',
        userId,
        amount,
        token: withdrawToken,
        txId: transactionId,
        recipient: user.hederaAccountId,
      });

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

    // Distributed lock around the entire balance-check → transfer →
    // state-update sequence. Without this, two concurrent admin
    // withdraw-fees calls can both pass the TOCTOU balance check and
    // double-spend the operator float. The lock is per-operation, not
    // per-operator, so different admin actions (refund, reconcile) can
    // still run in parallel.
    const lockToken = await acquireOperatorLock('withdraw-fees', 120);
    if (!lockToken) {
      throw new Error(
        'Another operator fee withdrawal is in progress. ' +
        'Wait a moment and try again.',
      );
    }

    try {
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

    // Record via HCS-20 accounting (non-blocking) — pass the token so
    // the on-chain record can be correctly attributed when the operator
    // is withdrawing non-HBAR rake (e.g. LAZY platform fees).
    try {
      await this.accounting.recordOperatorWithdrawal(
        getOperatorAccountId(this.client),
        amount,
        token,
      );
    } catch (e) {
      console.warn(
        '[MultiUserAgent] HCS-20 operator withdrawal recording failed:',
        e instanceof Error ? e.message : e,
      );
    }

    return transactionId;
    } finally {
      await releaseOperatorLock('withdraw-fees', lockToken);
    }
  }

  // ── Queries ────────────────────────────────────────────────────

  /**
   * Return the operator's accumulated balance and totals.
   */
  getOperatorBalance(): OperatorState {
    return this.store.getOperator();
  }

  /**
   * Public access to the AccountingService instance for callers
   * (refund route, recovery tool) that need to write HCS-20 v2
   * audit entries. Returns null if accounting wasn't initialized
   * (test envs, missing topic id, etc.).
   */
  getAccountingService(): AccountingService | null {
    return this.accounting ?? null;
  }

  /**
   * Public access to the underlying store for callers that need
   * direct queries. Used by the refund route and a few admin tools
   * that don't have a higher-level helper. Prefer adding a method
   * on MultiUserAgent over reaching through this in new code.
   */
  getStoreInstance(): IStore {
    return this.store;
  }

  /**
   * Return a structured health snapshot of the agent.
   */
  getHealth(): AgentHealth {
    const allUsers = this.store.getAllUsers();
    const serverless = !this.isRunning && !this.depositWatcher.isRunning();
    return {
      mode: serverless ? 'serverless' : 'cli',
      isRunning: this.isRunning,
      startedAt: this.startedAt,
      uptime: this.startedAt
        ? Date.now() - new Date(this.startedAt).getTime()
        : 0,
      depositWatcherRunning: this.depositWatcher.isRunning(),
      depositDetection: this.depositWatcher.isRunning() ? 'background-poll' : 'on-demand',
      deposits: this.depositWatcher.getStats(),
      deadLetterCount: this.store.getDeadLetters().length,
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

  /**
   * Operator-only recovery action for stuck prizes (Task C).
   *
   * When LottoAgent's phase 5 transferPendingPrizes call fails (typically
   * INSUFFICIENT_GAS) and the failure was dead-lettered (Task B), an
   * operator runs this to push the prizes through using the same retry
   * ladder as the in-flight path. The recovery is recorded on the HCS-20
   * audit topic via AccountingService.recordPrizeRecovery so an
   * independent third party can reconstruct the full history from the
   * topic alone.
   *
   * Safety:
   *   - Idempotent: if no prizes are pending in the agent wallet, returns
   *     'nothing_to_recover' without touching the chain.
   *   - dryRun mode returns the analysis without making any tx.
   *   - The contract call uses transferAllPrizesWithRetry, so all 3
   *     gas-ladder attempts apply here too.
   *   - Cross-user contamination: this transfers ALL of the agent's
   *     currently-pending prizes to the target user. If multiple users
   *     have stranded prizes, the operator must run them one at a time
   *     and verify between calls. The defensive check inside the
   *     in-flight path (LottoAgent.transferAllPrizes) only fires for
   *     live plays — recovery callers are trusted operators who've
   *     already verified the situation.
   *   - On success, marks any prize_transfer_failed dead-letter entries
   *     for this user as resolved with the recovery contract tx ID.
   */
  async recoverStuckPrizesForUser(
    userId: string,
    options: {
      dryRun?: boolean;
      reason: string;
      performedBy: string;
    },
  ): Promise<{
    status: 'recovered' | 'nothing_to_recover' | 'dry_run';
    userId: string;
    userEoa: string;
    pendingPrizesBefore: number;
    pendingPrizesAfter?: number;
    prizesByToken: Record<string, number>;
    nftCount: number;
    contractTxId?: string;
    hcs20RecoveryRecorded: boolean;
    attempts?: number;
    gasUsed?: number;
    affectedSessions: string[];
    resolvedDeadLetters: number;
  }> {
    const user = this.store.getUser(userId);
    if (!user) throw new UserNotFoundError(userId);

    // 1. Read agent's pending prizes via dApp MCP. Lazy import keeps
    //    the MCP client out of the agent's hot path.
    const { getUserState, getSystemInfo } = await import('../mcp/client.js');
    const agentAccountId = getOperatorAccountId(this.client);
    const agentState = await getUserState(agentAccountId);

    // 2. Aggregate the breakdown for the audit log + return value.
    const fungibleByToken: Record<string, number> = {};
    let nftCount = 0;
    for (const p of agentState.pendingPrizes) {
      if (p.fungiblePrize?.amount > 0) {
        const tk = p.fungiblePrize.token;
        fungibleByToken[tk] = (fungibleByToken[tk] ?? 0) + p.fungiblePrize.amount;
      }
      for (const n of p.nfts) {
        nftCount += n.serials.length;
      }
    }

    // 3. Find affected dead-letter entries for this user. Used to mark
    //    them resolved after a successful recovery.
    const allDeadLetters = this.store.getDeadLetters();
    const affectedEntries = allDeadLetters.filter(
      (e) =>
        e.kind === 'prize_transfer_failed' &&
        e.details?.userId === userId &&
        !e.resolvedAt,
    );
    const affectedSessions = affectedEntries
      .map((e) => e.details?.sessionId)
      .filter((s): s is string => typeof s === 'string');

    // 4. Nothing to do?
    if (agentState.pendingPrizesCount === 0) {
      return {
        status: 'nothing_to_recover',
        userId,
        userEoa: user.eoaAddress,
        pendingPrizesBefore: 0,
        prizesByToken: {},
        nftCount: 0,
        hcs20RecoveryRecorded: false,
        affectedSessions,
        resolvedDeadLetters: 0,
      };
    }

    // 5. Dry-run short circuit.
    if (options.dryRun) {
      return {
        status: 'dry_run',
        userId,
        userEoa: user.eoaAddress,
        pendingPrizesBefore: agentState.pendingPrizesCount,
        prizesByToken: fungibleByToken,
        nftCount,
        hcs20RecoveryRecorded: false,
        affectedSessions,
        resolvedDeadLetters: 0,
      };
    }

    // 6. Execute the contract call with the retry ladder.
    const sys = await getSystemInfo();
    const contractId = sys.contractAddresses.lazyLotto;
    const userEvm = (await import('../utils/format.js')).toEvmAddress(user.eoaAddress);
    const { transferAllPrizesWithRetry } = await import('../hedera/contracts.js');
    const txResult = await transferAllPrizesWithRetry(
      this.client,
      contractId,
      userEvm,
      agentState.pendingPrizesCount,
    );

    // 7. Record HCS-20 audit entry. Failure here is non-fatal — the
    //    contract transfer already succeeded, only the audit log
    //    record is missing if this throws.
    let hcs20RecoveryRecorded = false;
    try {
      await this.accounting.recordPrizeRecovery({
        userAccountId: user.hederaAccountId,
        agentAccountId,
        prizesTransferred: agentState.pendingPrizesCount,
        prizesByToken: fungibleByToken,
        contractTxId: txResult.result.transactionId,
        reason: options.reason,
        performedBy: options.performedBy,
        affectedSessions,
        attempts: txResult.attempt,
        gasUsed: txResult.gasUsed,
      });
      hcs20RecoveryRecorded = true;
    } catch (auditErr) {
      logger.warn('prize recovery HCS-20 audit failed', {
        component: 'MultiUserAgent',
        event: 'prize_recovery_audit_failed',
        userId,
        contractTxId: txResult.result.transactionId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }

    // 8. Mark dead-letter entries as resolved. The store's
    //    recordDeadLetter is an upsert by transactionId so writing the
    //    same entry with resolvedAt set updates it in place.
    let resolvedDeadLetters = 0;
    for (const entry of affectedEntries) {
      try {
        this.store.recordDeadLetter({
          ...entry,
          resolvedAt: new Date().toISOString(),
          resolvedBy: options.performedBy,
          resolutionTxId: txResult.result.transactionId,
        });
        resolvedDeadLetters++;
      } catch (resolveErr) {
        logger.warn('failed to mark dead letter resolved', {
          component: 'MultiUserAgent',
          event: 'dead_letter_resolve_failed',
          userId,
          deadLetterId: entry.transactionId,
          error: resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
        });
      }
    }

    // 9. Verify post-recovery state. Mirror node propagation can lag
    //    a few seconds; this is best-effort and just for logging.
    let pendingPrizesAfter: number | undefined;
    try {
      const after = await getUserState(agentAccountId);
      pendingPrizesAfter = after.pendingPrizesCount;
    } catch {
      /* informational only */
    }

    logger.info('stuck prizes recovered', {
      component: 'MultiUserAgent',
      event: 'prizes_recovered',
      userId,
      pendingPrizesBefore: agentState.pendingPrizesCount,
      pendingPrizesAfter,
      contractTxId: txResult.result.transactionId,
      attempts: txResult.attempt,
      gasUsed: txResult.gasUsed,
      resolvedDeadLetters,
    });

    return {
      status: 'recovered',
      userId,
      userEoa: user.eoaAddress,
      pendingPrizesBefore: agentState.pendingPrizesCount,
      pendingPrizesAfter,
      prizesByToken: fungibleByToken,
      nftCount,
      contractTxId: txResult.result.transactionId,
      hcs20RecoveryRecorded,
      attempts: txResult.attempt,
      gasUsed: txResult.gasUsed,
      affectedSessions,
      resolvedDeadLetters,
    };
  }

  /**
   * Query the dApp for prizes currently sitting in the LazyLotto contract
   * waiting for the user's EOA to claim them.
   *
   * Background: when a user wins a prize via the agent, LottoAgent's
   * phase 5 (`transferPendingPrizes`) reassigns the contract's internal
   * `pendingPrizes` mapping from the agent's wallet to the user's EOA.
   * No HBAR/tokens/NFTs actually move on Hedera at that point — they
   * stay in the contract's escrow until the user calls `claimAllPrizes`
   * from the dApp themselves.
   *
   * That means the dApp MCP's `getUserState(eoaAddress)` returns exactly
   * what we want for "show the user what's waiting for them": prizes
   * that have been reassigned to their EOA but haven't been claimed.
   *
   * The agent's internal HBAR/LAZY balance is a separate concept — that
   * tracks deposits the user has made to the agent for it to spend on
   * their behalf. It is NEVER incremented by prizes; that's a common
   * point of confusion. See docs/testnet-user-guide.md and the Recent
   * Plays panel relabel for the user-facing explanation.
   *
   * Returns null if the dApp MCP query fails (network, dApp down, etc.)
   * — callers should treat this as "claim status unavailable" and not
   * cascade the failure to the rest of the dashboard.
   */
  async getPendingPrizesForUser(userId: string): Promise<{
    pendingPrizesCount: number;
    pendingPrizes: Array<{
      poolId: number;
      asNFT: boolean;
      fungiblePrize: { token: string; amount: number };
      nfts: Array<{ token: string; hederaId: string; serials: number[] }>;
    }>;
  } | null> {
    const user = this.store.getUser(userId);
    if (!user) throw new UserNotFoundError(userId);

    try {
      // Lazy import to keep MCP client out of the agent's hot path —
      // it pulls in the @modelcontextprotocol/sdk client transport
      // which is non-trivial.
      const { getUserState } = await import('../mcp/client.js');
      const state = await getUserState(user.eoaAddress);
      return {
        pendingPrizesCount: state.pendingPrizesCount,
        pendingPrizes: state.pendingPrizes,
      };
    } catch (err) {
      logger.warn('getPendingPrizesForUser dApp query failed', {
        component: 'MultiUserAgent',
        event: 'pending_prizes_query_failed',
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
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

  // ── Withdrawal velocity cap ────────────────────────────────────
  //
  // Tracks per-user 24h withdrawal volume in Redis (auth namespace).
  // Returns the remaining capacity after this withdrawal would be
  // applied: positive = OK, negative = over cap (caller should reject).
  //
  // Falls back to "always allow" if Redis isn't available — the cap
  // is a defense-in-depth measure, not the primary auth check.

  /**
   * Per-token 24h rolling withdrawal volume cap.
   * Returns remaining allowance (positive) or the deficit (negative).
   *
   * The key is namespaced under `KEY_PREFIX.velocity + {tokenKey}:{userId}`
   * so different tokens have independent budgets. The per-user lock held
   * by processWithdrawal() serializes the get-then-set within a single
   * process; multi-Lambda concurrency is bounded by the distributed user
   * lock acquired at the route layer.
   */
  private async checkWithdrawalVelocity(
    userId: string,
    amount: number,
    cap: number,
    tokenKey: string,
  ): Promise<number> {
    try {
      const { getRedis, KEY_PREFIX } = await import('../auth/redis.js');
      const redis = await getRedis();
      const key = `${KEY_PREFIX.velocity}${tokenKey}:${userId}`;

      // Read current cumulative volume in the rolling window
      const currentRaw = await redis.get<string>(key);
      const current = currentRaw ? Number(currentRaw) || 0 : 0;
      const proposed = current + amount;

      if (proposed > cap) {
        return cap - proposed; // negative = over cap
      }

      // Within budget — increment and (re)set TTL to 24h
      await redis.set(key, String(proposed), { ex: 24 * 60 * 60 });
      return cap - proposed; // positive = remaining
    } catch (e) {
      console.warn('[velocity] check failed (allowing withdrawal):', e);
      return cap; // fail-open — don't block legit withdrawals on Redis hiccup
    }
  }

  /**
   * Public accessor for the current 24h withdrawal volume (and cap) for
   * a given user/token. Used by /api/user/status to surface the
   * "remaining today" counter in the Withdraw modal so users don't get
   * a raw backend error at submit time.
   */
  async getWithdrawalVelocityState(
    userId: string,
    token: string,
  ): Promise<{ cap: number | null; usedToday: number; remaining: number | null }> {
    const normalized = token.toLowerCase();
    const isHbar = normalized === 'hbar' || normalized === HBAR_TOKEN_KEY;
    const capEnvKey = isHbar
      ? 'WITHDRAWAL_DAILY_CAP_HBAR'
      : `WITHDRAWAL_DAILY_CAP_${normalized.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
    const capDefault = isHbar ? 1000 : Number.POSITIVE_INFINITY;
    const cap = Number(process.env[capEnvKey] ?? capDefault);

    if (!Number.isFinite(cap) || cap <= 0) {
      return { cap: null, usedToday: 0, remaining: null };
    }

    try {
      const { getRedis, KEY_PREFIX } = await import('../auth/redis.js');
      const redis = await getRedis();
      const key = `${KEY_PREFIX.velocity}${normalized}:${userId}`;
      const currentRaw = await redis.get<string>(key);
      const usedToday = currentRaw ? Number(currentRaw) || 0 : 0;
      return { cap, usedToday, remaining: Math.max(0, cap - usedToday) };
    } catch {
      return { cap, usedToday: 0, remaining: cap };
    }
  }
}
