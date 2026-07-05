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
import { RELEASE_SCRIPT, acquireOperatorLock, releaseOperatorLock } from '../lib/locks.js';
import { getRedis, KEY_PREFIX } from '../auth/redis.js';
import { HBAR_TOKEN_KEY } from '../config/strategy.js';
import {
  transferHbar,
  transferToken,
  PreserveClaimError,
} from '../hedera/transfers.js';
import { escalateUncertainDlFailure } from '../lib/escalation.js';
import { mintAuditOrphanId } from '../lib/orphanIds.js';

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
    | {
        status: 'blocked';
        reason: string;
        pendingPrizesCount: number;
        expectedFromThisSession: number;
        ownerEoa: string;
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
  // F1 (2026-07-04): a contamination-blocked sweep did NOT transfer the
  // prizes — record it on the audit trail as a non-transfer ('failed' is
  // the closest existing wire status; the distinct recovery detail lives
  // in the prize_transfer_blocked_contamination dead-letter).
  if (outcome.status === 'blocked') {
    return {
      status: 'failed',
      lastError:
        `blocked_cross_user_contamination: ${outcome.pendingPrizesCount} pending ` +
        `> ${outcome.expectedFromThisSession} won this session`,
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

/**
 * R8-FG-25 / Phase-6 Cluster E: typed sentinel for the F24
 * per-token operator-pending claim "already in flight" condition.
 *
 * Pre-fix `operatorWithdrawFees` discriminated this branch via
 * `claimErr.message.includes('already in flight')` against a string
 * literal constructed seven lines earlier in the same function.
 * That's the same archetype-seed that produced R5-FG-3: a future
 * copy-edit on the message text silently flips the catch's branch
 * and the operator sees a misleading error wrapping a real claim
 * conflict as a "Redis unreachable" failure.
 */
export class InFlightClaimError extends Error {
  readonly __claimInFlight = true as const;
  constructor(message?: string) {
    super(message);
    this.name = 'InFlightClaimError';
  }
}

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
      // 0.3.3: route agentSeq through the store so two warm Lambdas
      // writing v2 messages for different users cannot emit the same
      // sequence number. RedisStore uses SETNX + INCR; PersistentStore
      // uses an in-memory Map (single-process).
      store: this.store,
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

  /**
   * 0.3.4: expose the DepositWatcher so the admin replay-deposit
   * route can re-run a single mirror-node transaction through the
   * normal credit flow. Bypasses the watermark — intended for
   * operator-driven recovery of dead-lettered deposits whose
   * underlying error is now resolved (e.g. token registered after
   * the deposit landed).
   */
  getDepositWatcher(): DepositWatcher {
    return this.depositWatcher;
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
  async deregisterUser(userId: string): Promise<void> {
    // R3-FG-33 (round-3 P5-PU-002): block deregister if any unresolved
    // play_uncertain entry references this userId. Pre-fix the user
    // could deregister with held reservations; manual reconstruction
    // tooling later threw `UserNotFoundError` on `releaseReserve` and
    // the DL row wedged permanently with F15's `successTriagedAt`
    // gate refusing force-release.
    await this.store.refreshDeadLetters().catch(() => undefined);
    const openPlays = this.store.getDeadLetters().filter(
      (e) =>
        e.kind === 'play_uncertain' &&
        !e.resolvedAt &&
        (e.details as { userId?: string })?.userId === userId,
    );
    if (openPlays.length > 0) {
      throw new Error(
        `Cannot deregister ${userId}: ${openPlays.length} unresolved play_uncertain ` +
          `entr${openPlays.length === 1 ? 'y' : 'ies'} reference this user. Resolve via ` +
          `reconcile / admin force-release before deregistering.`,
      );
    }
    this.ledger.deregisterUser(userId);
  }

  /**
   * Switch an existing user to a different strategy preset. Available
   * presets are defined in NegotiationHandler.AVAILABLE_STRATEGIES.
   * The user's balances, deposit memo, and registration date are
   * preserved — only the strategy snapshot changes. Takes effect on
   * the next play session.
   *
   * After the store write succeeds, writes a strategy_change
   * audit-trail message to HCS-20 so third parties can reconstruct
   * which strategy was active for any given play session. The HCS-20
   * write is best-effort — if the topic isn't configured or the
   * submit fails, the local strategy change still stands (we've
   * already saved the user record) and we log the miss. We do NOT
   * roll back the local change on audit-write failure because the
   * user's intent has been captured; audit-trail recovery can
   * backfill via a reconcile pass if needed.
   */
  async updateUserStrategy(
    userId: string,
    newStrategyName: string,
    performedBy: string = 'user',
  ): Promise<UserAccount> {
    await assertKillSwitchDisabled();

    // Capture the old strategy name BEFORE the mutation so the
    // HCS-20 audit entry has both sides of the transition. Looking
    // up the user again AFTER the mutation would give us the new
    // name for both slots.
    const prior = this.store.getUser(userId);
    const previousStrategy = prior?.strategyName ?? 'unknown';

    const updated = await this.negotiation.updateUserStrategy(userId, newStrategyName);

    // No-op paths (same strategy): NegotiationHandler returns the
    // user unchanged — still emits one audit anchor so the trail
    // records the intent. Skipping would create a gap between user
    // action and audit history that's annoying to explain.
    try {
      await this.accounting.recordStrategyChange({
        user: updated.hederaAccountId,
        previousStrategy,
        newStrategy: updated.strategyName,
        newStrategyVersion: updated.strategyVersion,
        performedBy,
      });
    } catch (auditErr) {
      // F17 (2026-05-06 audit A-03): persist an `audit_trail_orphaned`
      // dead-letter so the operator surfaces missing strategy_change
      // anchors the same way verifier paths do — silently dropping
      // would let an external auditor walking the topic see a
      // strategy switch in the next session that the topic itself
      // never recorded, looking like tampering.
      console.warn(
        `[MultiUserAgent] strategy_change audit write failed for ${userId}:`,
        auditErr instanceof Error ? auditErr.message : auditErr,
      );
      try {
        await this.store.upsertDeadLetter({
          // R4-FG-28: bare Date.now() collides on millisecond ties;
          // use mintAuditOrphanId for the uuid-suffixed tail.
          transactionId: mintAuditOrphanId('audit-orphan:strategy', userId),
          timestamp: new Date().toISOString(),
          error: `strategy_change audit write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
          kind: 'audit_trail_orphaned',
          details: {
            sourceKind: 'strategy_change',
            userId,
            userAccountId: updated.hederaAccountId,
            previousStrategy,
            newStrategy: updated.strategyName,
            newStrategyVersion: updated.strategyVersion,
            performedBy,
          },
        });
      } catch {
        /* logged above */
      }
      // R3-FG-17: escalate strategy_change audit failure too.
      try {
        const { escalateUncertainDlFailure } = await import('../lib/escalation.js');
        await escalateUncertainDlFailure({
          kind: 'audit_trail_orphaned',
          uncertainTxId: `strategy:${userId}:${Date.now()}`,
          userId,
          cause: auditErr,
        });
      } catch (escErr) {
        console.error('strategy_change audit-failure escalation also failed:', escErr);
      }
    }

    return updated;
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

    // R-MEDIUM-2: refuse new play if the user already has 3 unresolved
    // play_uncertain rows. Each held reservation locks balance until
    // reconcile / force-release resolves it; without a cap a user
    // hitting transient mirror lag could lock all their funds behind
    // held reservations. Self-DoS scope only (filter pins userId), not
    // cross-user. Same shape as the L21 cap on processWithdrawal.
    await this.store.refreshDeadLetters().catch(() => undefined);
    const userOpenPlays = this.store
      .getDeadLetters()
      .filter(
        (e) =>
          e.kind === 'play_uncertain' &&
          !e.resolvedAt &&
          (e.details as { userId?: string })?.userId === userId,
      );
    if (userOpenPlays.length >= 3) {
      this.releaseLock(userId);
      throw new Error(
        `Play blocked: ${userOpenPlays.length} unresolved play_uncertain ` +
          `entries for user ${userId} (cap: 3). Resolve via reconcile / ` +
          `admin force-release before retrying.`,
      );
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

    // R2-FG-29: declare here (outside the try) so the catch block
    // can reference them. Used to detect "settle happened then we
    // threw before v2 anchor" → emit audit_trail_orphaned.
    let settleHappened = false;
    let partialSpendByToken: Record<string, number> = {};

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

      // R10-FG-2 / Phase-9 Cluster C: store.getUser now returns
      // Readonly<UserAccount>, so a direct property mutation here
      // would be a type error (and was a sibling of R10-FG-2's
      // store-cache mutation hazard). Persist via saveUser of a
      // fresh object instead. The downstream code reads user.balances
      // / user.eoaAddress / user.strategySnapshot — none of which
      // depend on the lastPlayedAt update.
      this.store.saveUser({ ...user, lastPlayedAt: new Date().toISOString() });

      // R2-FG-29 (round-2 G-11 / G-12): `settleHappened` /
      // `partialSpendByToken` are declared OUTSIDE the try so the
      // catch block can reference them; we only assign here.
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
          // R2-FG-29: record partial-spend state for the outer catch.
          partialSpendByToken[token] = actualSpent;
          settleHappened = true;
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
          // Propagate the canonical pool fee token. PoolResult.feeTokenId
          // is the budget key used by the play loop and the v2 audit
          // trail; persisting it into PlaySessionResult lets the
          // dashboard display per-pool spend without guessing.
          feeTokenId: r.feeTokenId,
          rolled: r.rolled,
          wins: r.wins,
          prizeDetails: r.prizeDetails,
        })),
        totalSpent: actualSpent,
        // Per-token spend breakdown. Derived from per-pool settlements
        // (spentByTokenId) rather than report.spentByToken so the map
        // reflects the ACTUAL spend after reservations settled, not
        // the mid-session report view. Keys match the per-token
        // settlement ledger: "hbar" for native HBAR or a Hedera token
        // id for FTs. Normalized to "HBAR" upper-case here so downstream
        // (dashboard + audit) doesn't have to branch on case.
        spentByToken: Object.fromEntries(
          Array.from(spentByTokenId.entries()).map(([t, amt]) => [
            t === 'hbar' ? 'HBAR' : t,
            amt,
          ]),
        ),
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

      // Record play session. The user record was already persisted at
      // line 736 via saveUser({...user, lastPlayedAt: ...}); balance
      // changes are persisted via this.ledger.settleSpend ->
      // store.updateBalance internally.
      //
      // R12-FG-2 / Phase-9.5 Cluster F: the explicit `this.store.saveUser(user)`
      // that previously stood here was redundant post-Phase-9 AND
      // actively harmful — it re-persisted the original Readonly
      // snapshot bound at line 534, REVERTING the lastPlayedAt update
      // from line 736. Pre-Phase-9 the `user` reference was mutated in
      // place (so it carried the new timestamp by line 874), which
      // masked the redundancy. Phase-9's Readonly migration broke the
      // mutation path; the redundant saveUser then surfaced as a
      // sibling-site regression of R10-FG-2's archetype.
      this.store.recordPlaySession(session);

      // Dead-letter the failure (Task B). When phase 5 exhausts the
      // retry ladder we record a structured entry the operator can
      // see in the admin dashboard and resolve via the recovery tool.
      // The contract call has already failed; the prizes are stranded
      // in the agent wallet until an operator runs the recovery.
      if (transferOutcome?.status === 'failed') {
        try {
          await this.store.upsertDeadLetter({
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
              // R5-FG-65 + R5-FG-66: preserve the receipt-uncertain
              // signal + last-submitted contract txId so the
              // recovery script (recover-stuck-prizes.ts) can
              // mirror-check BEFORE re-submitting. Pre-fix the
              // recovery script read pendingPrizesCount and
              // double-submitted when the original receipt-uncertain
              // tx had actually landed.
              ...(transferOutcome.receiptUncertain ? { receiptUncertain: true } : {}),
              ...(transferOutcome.lastSubmittedTxId
                ? { lastSubmittedTxId: transferOutcome.lastSubmittedTxId }
                : {}),
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

      // F1 (2026-07-04 custodial audit): contamination BLOCK. The
      // shared-wallet sweep was refused because the agent wallet held
      // MORE pending prizes than this session won — a prior user's
      // prizes are stranded in it (see LottoAgent.transferAllPrizes).
      // Dead-letter so the operator runs per-user recovery; BOTH this
      // session's prizes AND the prior stranded prizes remain pending.
      if (transferOutcome?.status === 'blocked') {
        try {
          await this.store.upsertDeadLetter({
            transactionId: sessionId,
            timestamp: new Date().toISOString(),
            error:
              `cross-user contamination: ${transferOutcome.pendingPrizesCount} pending prize(s) ` +
              `> ${transferOutcome.expectedFromThisSession} won this session`,
            sender: user.hederaAccountId,
            kind: 'prize_transfer_blocked_contamination',
            details: {
              userId,
              sessionId,
              prizesByToken: report.prizesByToken,
              pendingPrizesCount: transferOutcome.pendingPrizesCount,
              expectedFromThisSession: transferOutcome.expectedFromThisSession,
              ownerEoa: transferOutcome.ownerEoa,
            },
          });
          logger.error('prize transfer BLOCKED — cross-user contamination', {
            component: 'MultiUserAgent',
            event: 'prize_transfer_blocked_contamination',
            userId,
            sessionId,
            pendingPrizesCount: transferOutcome.pendingPrizesCount,
            expectedFromThisSession: transferOutcome.expectedFromThisSession,
          });
        } catch (deadLetterErr) {
          // The recovery anchor could not be persisted — page the
          // operator (F17 made this escalation reliable). Without it a
          // contamination event is invisible and the stranded prizes sit
          // until the reconcile cron notices.
          logger.error('failed to dead-letter contamination block — paging', {
            component: 'MultiUserAgent',
            event: 'dead_letter_write_failed',
            userId,
            sessionId,
            error: deadLetterErr instanceof Error ? deadLetterErr.message : String(deadLetterErr),
          });
          try {
            await escalateUncertainDlFailure({
              kind: 'prize_transfer_blocked_contamination',
              uncertainTxId: sessionId,
              userId,
              cause: deadLetterErr,
            });
          } catch {
            /* escalation is best-effort; the logger.error above is the floor */
          }
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
        // F12 (2026-07-05 custodial audit): capture the POST-slim prizes
        // that each recordPlayPoolResult actually wrote on chain, so the
        // close poolsRoot below is computed over exactly what a topic-only
        // reader recomputes — not the full pre-slim set.
        const writtenPrizesByPool: ReturnType<typeof convertPrizeDetailsToV2>[] = [];
        for (let i = 0; i < playedPools.length; i++) {
          const pool = playedPools[i]!;
          const prizes = convertPrizeDetailsToV2(pool.prizeDetails ?? []);
          const spentToken = poolFeeTokenForAudit(pool.feeTokenId);
          // R5-FG-22 (P5-SR-001): increment BEFORE the await. Pre-fix
          // the post-await increment lost the count of any pool whose
          // submit landed on the topic but whose await threw a
          // ReceiptUncertainError or transient SDK error → the abort
          // path computed `abortedPoolsRoot` over `slice(0, i-1)`,
          // missing pool i — but the topic HAS the message → reader
          // recomputed Merkle over i pool messages and abort marker
          // carried root over i-1 → roots disagreed → reader marked
          // session orphaned (not aborted), masking the real failure
          // mode and breaking `closed_aborted` recovery semantics.
          v2WrittenPools++;
          try {
            const written = await this.accounting.recordPlayPoolResult({
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
            writtenPrizesByPool[i] = written.prizes;
          } catch (poolErr) {
            // Best-effort: if submit definitely never reached the
            // network (pre-submit validation throw), decrement back
            // — the abort-root will be computed over slice(0, i)
            // matching what the topic actually has. PreserveClaim
            // shapes (ReceiptUncertain / PostSubmit) leave the count
            // optimistic since the topic likely has the message.
            if (!(poolErr instanceof PreserveClaimError)) {
              v2WrittenPools = Math.max(0, v2WrittenPools - 1);
            }
            throw poolErr;
          }
        }

        // 3. Close — compute Merkle root from the canonical pool data
        // R4-FG-23 (round-4 high): bind sessionId/user/agent into the
        // root so two sessions with identical pool data produce
        // distinct roots. Without the binding a compromised operator
        // (or replay-window attacker) could swap a `play_session_close`
        // between sessions whose pool sequences happen to match.
        const poolsRoot = await computePoolsRoot(
          playedPools.map((p, i) => ({
            poolId: p.poolId,
            spent: p.amountSpent,
            spentToken: poolFeeTokenForAudit(p.feeTokenId),
            wins: p.wins,
            // F12: hash the POST-slim prizes actually written on chain
            // (fall back to full only if a pool write somehow returned
            // nothing — shouldn't happen on the success path).
            prizes: writtenPrizesByPool[i] ?? convertPrizeDetailsToV2(p.prizeDetails ?? []),
          })),
          {
            sessionId: session.sessionId,
            user: user.hederaAccountId,
            agent: agentAccountId,
          },
        );
        await this.accounting.recordPlaySessionClose({
          sessionId: session.sessionId,
          user: user.hederaAccountId,
          agent: agentAccountId,
          poolsPlayed: playedPools.length,
          poolsRoot,
          // F12: the close root was computed over the post-slim prizes → v2.
          poolsRootV: 2,
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
        // R4-FG-24 (round-4 high): compute Merkle root over the pools
        // that DID get emitted before the v2 sequence failed. Without
        // this a compromised operator could write an aborted message
        // claiming `completedPools: 0` for a session whose pool
        // messages already wrote — verify-audit would treat it as
        // aborted, ignore the spend, and reconstruct user spent=0
        // while operator pocketed the spend. Best-effort: if the root
        // computation throws (shouldn't, pure crypto over local data),
        // emit aborted without it and the reader falls back to the
        // legacy completedPools count check.
        let abortedPoolsRoot: string | undefined;
        try {
          const completed = playedPools.slice(0, v2WrittenPools);
          if (completed.length > 0) {
            abortedPoolsRoot = await computePoolsRoot(
              completed.map((p) => ({
                poolId: p.poolId,
                spent: p.amountSpent,
                spentToken: poolFeeTokenForAudit(p.feeTokenId),
                wins: p.wins,
                prizes: convertPrizeDetailsToV2(p.prizeDetails ?? []),
              })),
              {
                sessionId: session.sessionId,
                user: user.hederaAccountId,
                agent: agentAccountId,
              },
            );
          }
        } catch (rootErr) {
          console.warn(
            '[MultiUserAgent] aborted-poolsRoot computation failed:',
            rootErr instanceof Error ? rootErr.message : String(rootErr),
          );
        }
        try {
          await this.accounting.recordPlaySessionAborted({
            sessionId: session.sessionId,
            user: user.hederaAccountId,
            agent: agentAccountId,
            completedPools: v2WrittenPools,
            ...(abortedPoolsRoot ? { poolsRoot: abortedPoolsRoot } : {}),
            reason: 'v2_write_failure',
            lastError: errMsg,
          });
        } catch (abortErr) {
          // 0.3.4: when BOTH the v2 close AND the aborted-marker
          // fall-back fail, the session has been settled in the local
          // ledger but has NO HCS-20 marker on chain. External
          // auditors reconstructing balances from the topic see the
          // user's pre-play balance — the spend is invisible. Pre-fix
          // this was only console.warn'd; the operator had no signal.
          // Now we dead-letter so the admin dashboard surfaces the
          // session for manual replay, and reconcile can cross-check
          // recent PlaySessionResult records against topic markers.
          const abortErrMsg = abortErr instanceof Error ? abortErr.message : String(abortErr);
          console.warn(
            '[MultiUserAgent] V2 aborted marker also failed — dead-lettering session as audit_trail_orphaned:',
            abortErrMsg,
          );
          try {
            await this.store.upsertDeadLetter({
              transactionId: session.sessionId,
              timestamp: new Date().toISOString(),
              error: `Audit trail orphaned: v2 close failed (${errMsg}), abort marker also failed (${abortErrMsg})`,
              kind: 'audit_trail_orphaned',
              sender: user.hederaAccountId,
              details: {
                userId: user.userId,
                sessionId: session.sessionId,
                completedPools: v2WrittenPools,
                totalPools: playedPools.length,
                spentByToken: session.spentByToken,
                closeError: errMsg,
                abortError: abortErrMsg,
              },
            });
          } catch (dlErr) {
            // If even the dead-letter write fails we're in a really bad
            // state — Redis is wedged. Surface loudly. Reconcile cron
            // is the last line of defence (it cross-checks recent
            // PlaySessionResult against topic markers).
            console.error(
              '[MultiUserAgent] CRITICAL: dead-letter write also failed — operator MUST inspect Redis health:',
              dlErr,
            );
          }
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
      // R6-FG-2 (P1-001 + P3-003): gate on parent PreserveClaimError
      // so any subclass preserves reservations uniformly.
      if (error instanceof PreserveClaimError) {
        const uncertainTxId = error.transactionId;
        // Receipt-uncertain or post-submit error on a contract
        // submission. The on-chain action MAY have landed; releasing
        // the reservations would let the user re-play with a fresh
        // balance. KEEP reservations. Persist a play_uncertain
        // dead-letter so reconcile can resolve via mirror node:
        //   - Confirmed FAILED → release reservations.
        //   - Confirmed SUCCESS → flag for manual triage.
        //   - Still NOT_FOUND → next reconcile pass; 24h NOT_FOUND
        //     promotes to FAILED.
        try {
          await this.store.upsertDeadLetter({
            transactionId: uncertainTxId,
            timestamp: new Date().toISOString(),
            error: error.message,
            kind: 'play_uncertain',
            details: {
              userId,
              tokenReservations: Array.from(tokenReservations.entries()).map(
                ([token, amount]) => ({ token, amount }),
              ),
            },
          });
        } catch (dlErr) {
          // H11: dead-letter write failure during uncertain catch is
          // the worst possible state (held reserves, no recovery
          // anchor). Log loudly + escalate.
          logger.error(
            'CRITICAL: play_uncertain dead-letter write failed — held reserves with no recovery anchor',
            {
              component: 'MultiUserAgent',
              event: 'play_uncertain_dl_write_failed',
              userId,
              uncertainTxId,
              error: dlErr instanceof Error ? dlErr.message : String(dlErr),
            },
          );
          await escalateUncertainDlFailure({
            kind: 'play_uncertain',
            userId,
            uncertainTxId,
            cause: dlErr,
          });
        }
        logger.error('play post-submit uncertain — dead-lettered', {
          component: 'MultiUserAgent',
          event: 'play_receipt_uncertain',
          userId,
          uncertainTxId,
          errorClass: error.constructor.name,
        });
        // Reservations INTENTIONALLY retained. Rethrow.
        throw error;
      }
      // Confirmed pre-submit OR on-chain failure: release every
      // reservation on failure (per-token). The catch is wide because:
      //   - If play() threw, no settlement happened, so the full
      //     reservation is still locked.
      //   - If play() returned but settlement threw on a defense-
      //     in-depth check, some tokens may have been settled and
      //     others not. We track which we settled on the success
      //     path; here we just attempt to release everything that's
      //     in tokenReservations and let releaseReserve clamp to
      //     whatever's actually still reserved (it min()s against
      //     entry.reserved internally).
      // R2-FG-29: if settle ran (partialSpendByToken non-empty) and
      // we threw before the v2 anchor was written, write
      // `audit_trail_orphaned` so the dashboard surfaces partial
      // spend. The local balance has been debited; without this row
      // the user appears short with no on-chain explanation.
      if (settleHappened && Object.keys(partialSpendByToken).length > 0) {
        try {
          await this.store.upsertDeadLetter({
            // R4-FG-28: bare Date.now() collides on millisecond ties.
            transactionId: mintAuditOrphanId('audit-orphan:in-band:play-settle', userId),
            timestamp: new Date().toISOString(),
            error:
              `playForUser threw between settle and v2 anchor: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            kind: 'audit_trail_orphaned',
            details: {
              sourceKind: 'in_band_play_settle',
              sourceTxId: 'unknown',
              userId,
              partialSpendByToken,
              phase: 'settle_then_throw_pre_v2',
            },
          });
        } catch {
          /* logged below */
        }
        logger.error(
          'R2-FG-29: playForUser settled balances then threw before v2 anchor — audit_trail_orphaned written',
          {
            component: 'MultiUserAgent',
            event: 'play_settle_then_throw',
            userId,
            partialSpendByToken,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
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
   * Concurrency invariant (F10): the per-user lock MUST be held across
   * BOTH the velocity-cap check AND the on-chain transfer. The
   * read-modify-write pattern in `checkWithdrawalVelocity` is not
   * atomic at the Redis layer (we read, compute, then write), so
   * without a wrapping lock two concurrent withdrawals could both
   * pass the cap check. Two layers of locking enforce this:
   *
   *   1. In-process mutex via `this.acquireLock(userId)` below,
   *      serializing within a single Lambda or CLI process.
   *   2. Distributed lock via `acquireUserLock` at the route layer
   *      (web `/api/user/withdraw` and the `multi_user_withdraw` MCP
   *      tool both wrap this call in `acquireUserLock(userId)`),
   *      serializing across warm Lambda instances.
   *
   * If a future caller bypasses route-layer locking (e.g. an internal
   * cron, a refund flow, an HCS-10 negotiation handler), it MUST also
   * acquire the distributed user lock before invoking
   * `processWithdrawal`. The in-process mutex alone is not sufficient
   * in serverless — two warm Lambdas would each hold their OWN mutex.
   */
  // R4-FG-37 (round-4 medium): `token` is required. The string-literal
  // default 'hbar' violated the project's "always match by token ID"
  // rule (CLAUDE.md security rule #1) — a caller that forgot to pass
  // `token` would silently process an HBAR withdrawal when the user
  // intended a token withdrawal.
  async processWithdrawal(userId: string, amount: number, token: string): Promise<WithdrawalRecord> {
    await this.acquireLock(userId);
    try {
      const user = this.store.getUser(userId);
      if (!user) throw new UserNotFoundError(userId);

      // L21: refuse new withdrawal if the user already has 3 unresolved
      // withdrawal_uncertain rows. Each receipt-uncertain catch holds
      // a reserve until reconcile resolves it, so without a cap a user
      // hitting transient mirror lag could lock all their balance
      // behind held reserves. Cap also defends the dead-letter list
      // from runaway pollution.
      await this.store.refreshDeadLetters().catch(() => undefined);
      const userOpenUncertain = this.store
        .getDeadLetters()
        .filter(
          (e) =>
            e.kind === 'withdrawal_uncertain' &&
            !e.resolvedAt &&
            (e.details as { userId?: string })?.userId === userId,
        );
      if (userOpenUncertain.length >= 3) {
        throw new Error(
          `Withdrawal blocked: ${userOpenUncertain.length} unresolved ` +
            `withdrawal_uncertain entries for user ${userId} (cap: 3). ` +
            `Resolve via reconcile / admin force-release before retrying.`,
        );
      }

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
        // R6-FG-1 (P1-002 + P3-001 + P10-002): gate on parent
        // `PreserveClaimError` so any subclass (ReceiptUncertainError,
        // PostSubmitError, future) preserves the reserve uniformly.
        // Pre-fix only ReceiptUncertainError preserved → PostSubmitError
        // (signer disposed, V8 OOM, network reset between execute()
        // and awaitReceipt) fell through to releaseReserve → on-chain
        // may have landed → fresh-key retry double-spends.
        if (transferError instanceof PreserveClaimError) {
          const uncertainTxId = transferError.transactionId;
          // Audit finding C24 applied to withdraw: if we release the
          // reserve here, a retry with a fresh idempotency key (or
          // no key) would let the user spend that balance AGAIN, then
          // a successful original tx would drain the operator wallet
          // a second time. KEEP the reserve. Persist a
          // withdrawal_uncertain dead-letter so reconcile verifies
          // the tx on chain and either settles (success) or releases
          // the reserve (failed).
          try {
            await this.store.upsertDeadLetter({
              transactionId: uncertainTxId,
              timestamp: new Date().toISOString(),
              error: transferError.message,
              kind: 'withdrawal_uncertain',
              details: {
                userId,
                recipientAccountId: user.hederaAccountId,
                withdrawTxId: uncertainTxId,
                amount,
                tokenKey: withdrawToken,
                isHbar,
              },
            });
          } catch (dlErr) {
            logger.error(
              'CRITICAL: withdrawal_uncertain dead-letter write failed — reserve held but no recovery anchor',
              {
                component: 'MultiUserAgent',
                event: 'withdrawal_uncertain_dl_write_failed',
                userId,
                withdrawTxId: uncertainTxId,
                error: dlErr instanceof Error ? dlErr.message : String(dlErr),
              },
            );
            await escalateUncertainDlFailure({
              kind: 'withdrawal_uncertain',
              userId,
              uncertainTxId,
              cause: dlErr,
            });
          }
          logger.error('withdrawal post-submit uncertain — dead-lettered', {
            component: 'MultiUserAgent',
            event: 'withdrawal_receipt_uncertain',
            userId,
            withdrawTxId: uncertainTxId,
            amount,
            token: withdrawToken,
            errorClass: transferError.constructor.name,
          });
          // Reserve INTENTIONALLY retained. Rethrow so withIdempotency
          // (which checks isPreserveClaim) preserves its claim and
          // the caller surfaces uncertainty.
          throw transferError;
        }
        // Confirmed pre-submit OR on-chain failure — release reserve.
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
      //
      // F17 (2026-05-06 audit A-01): on failure, write an
      // `audit_trail_orphaned` dead-letter so the operator surfaces
      // the missing on-chain anchor. The local mutations
      // (settleSpend / totalWithdrawn / recordWithdrawal) already
      // happened — silently dropping the audit failure leaves
      // topic-only reconstructions reporting a higher balance than
      // Redis (= apparent operator under-payment).
      try {
        await this.accounting.recordWithdrawal(
          user.hederaAccountId,
          amount,
          withdrawToken,
          transactionId,
        );
      } catch (auditErr) {
        logger.warn('in-band withdrawal audit write failed', {
          component: 'MultiUserAgent',
          event: 'in_band_withdraw_audit_failed',
          userId,
          withdrawTxId: transactionId,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
        try {
          await this.store.upsertDeadLetter({
            // R4-FG-27: salt by writer phase + UUID-tail so multi-pass
            // failures for the same source don't collide.
            transactionId: mintAuditOrphanId('audit-orphan:in-band:withdrawal', transactionId),
            timestamp: new Date().toISOString(),
            error: `in-band withdrawal audit write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
            kind: 'audit_trail_orphaned',
            details: {
              sourceKind: 'withdrawal',
              sourceTxId: transactionId,
              userId,
              userAccountId: user.hederaAccountId,
              amount,
              tokenKey: withdrawToken,
              recipientAccountId: user.hederaAccountId,
              withdrawTxId: transactionId,
            },
          });
        } catch {
          /* logged above */
        }
        // R3-FG-17 (round-3 P9-001): page the operator. Pre-fix only
        // wrote a DL row + log; the escalation kind union didn't even
        // accept `audit_trail_orphaned`. Now extended in escalation.ts.
        try {
          const { escalateUncertainDlFailure } = await import('../lib/escalation.js');
          await escalateUncertainDlFailure({
            kind: 'audit_trail_orphaned',
            uncertainTxId: transactionId,
            userId,
            cause: auditErr,
          });
        } catch (escErr) {
          logger.error('in-band withdrawal audit-failure escalation also failed', {
            component: 'MultiUserAgent',
            error: escErr instanceof Error ? escErr.message : String(escErr),
          });
        }
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
    // M14: fail fast if LAZY_TOKEN_ID is missing for a LAZY
    // withdrawal — the env-stability landmine in the verifier
    // depends on the same env var being set for the entire
    // submit→reconcile lifecycle. Detecting at submit time prevents
    // a dead-letter being written with `tokenKey: 'lazy'` (literal
    // fallback) that the verifier would later debit against the
    // wrong key.
    if (token === 'LAZY' && !process.env.LAZY_TOKEN_ID) {
      throw new Error(
        'LAZY_TOKEN_ID not configured — cannot withdraw LAZY fees. Set the env and retry.',
      );
    }

    // Refresh operator state from Redis post-lock so we see the
    // latest rake totals from any deposits credited on other Lambdas
    // before we read tokenBalance below. Without this refresh, a
    // freshly-credited deposit on Lambda B is invisible to Lambda A's
    // local cache, causing Lambda A to under-withdraw the fee
    // (annoying — operator sees a smaller-than-expected number,
    // tries again, gets the rest). Not a double-X but worth getting
    // right now that we hold the lock.
    await this.store.refreshOperator();
    const operator = this.store.getOperator();
    // M14 guard above ensures LAZY_TOKEN_ID is set when token === 'LAZY'.
    const tokenKey = token === 'HBAR' ? 'hbar' : process.env.LAZY_TOKEN_ID!;
    const tokenBalance = operator.balances[tokenKey] ?? 0;
    if (tokenBalance < amount) {
      throw new InsufficientBalanceError('operator', amount, tokenBalance);
    }

    // C2 + L21: refuse new submit if there are unresolved
    // operator_fee_withdraw_uncertain rows for this same tokenKey.
    // The receipt-uncertain catch leaves operator state un-debited,
    // so a fresh-key retry would pass the balance check above and
    // fire a SECOND on-chain transfer. If the original lands, the
    // operator wallet drains twice. Reconcile (or admin force-release)
    // must resolve the existing uncertain row before a retry is safe.
    // Total cap of 10 prevents dead-letter pollution from runaway
    // timeouts.
    await this.store.refreshDeadLetters().catch(() => undefined);
    const allOpenOperatorUncertain = this.store
      .getDeadLetters()
      .filter(
        (e) => e.kind === 'operator_fee_withdraw_uncertain' && !e.resolvedAt,
      );
    const sameTokenOpen = allOpenOperatorUncertain.filter(
      (e) => (e.details as { tokenKey?: string })?.tokenKey === tokenKey,
    );
    if (sameTokenOpen.length > 0) {
      throw new Error(
        `Operator fee withdrawal blocked: ${sameTokenOpen.length} unresolved ` +
          `operator_fee_withdraw_uncertain entries for ${tokenKey}. ` +
          `Resolve via reconcile or admin force-release before retrying.`,
      );
    }
    if (allOpenOperatorUncertain.length >= 10) {
      throw new Error(
        `Operator fee withdrawal blocked: ${allOpenOperatorUncertain.length} ` +
          `total unresolved operator_fee_withdraw_uncertain entries (cap: 10). ` +
          `Resolve via reconcile / admin force-release before submitting more.`,
      );
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

    const sender = getOperatorAccountId(this.client);

    // F24 (2026-05-06 audit OP-02): per-token in-flight claim. The
    // existing operator-lock at the route serializes calls but its
    // TTL (120s) is too short to bridge a worst-case Lambda freeze
    // between `awaitReceipt` resolving and `updateOperator` firing.
    // A retry with a fresh idempotency key during that freeze would
    // see no DL (no ReceiptUncertainError fired) and submit a SECOND
    // on-chain transfer — operator double-pay.
    //
    // The pre-submit claim is per-token (only one operator-fee
    // withdraw of any token can be in flight at a time). 30-min TTL
    // covers worst-case Lambda freeze + retry window. SET-NX so two
    // concurrent calls see the in-flight signal and refuse. Cleared
    // after `updateOperator` flush succeeds; left in place on
    // ReceiptUncertainError (verifier resolves the dead-letter and
    // operators clear the claim via force-release if needed).
    const PENDING_CLAIM_KEY = `${KEY_PREFIX.lockOperator}withdraw-pending:${tokenKey}`;
    const PENDING_CLAIM_TTL_SEC = 30 * 60;
    // R3-FG-2 (round-3 P2-003 / P5-OF-001): fence the claim VALUE so
    // releasers compare-and-delete via RELEASE_SCRIPT instead of an
    // unfenced DEL. Pre-fix release sites used plain `redis.del()` —
    // a stale verifier or force-release completion DEL'd a fresh
    // acquirer's claim → operator double-pay. Persist the fence onto
    // the dead-letter row so the verifier + force-release release
    // paths can match it.
    const pendingClaimFence = randomUUID();
    let pendingClaimAcquired = false;
    try {
      const redis = await getRedis();
      const claimResult = await redis.set(
        PENDING_CLAIM_KEY,
        pendingClaimFence,
        { nx: true, ex: PENDING_CLAIM_TTL_SEC },
      );
      if (claimResult === null) {
        // R8-FG-25 / Phase-6 Cluster E: typed sentinel replaces the
        // pre-Phase-6 message-substring discrimination. Pre-fix the
        // catch below tested
        // `claimErr.message.includes('already in flight')` against
        // the literal message string from a few lines up — a future
        // copy-edit on either side would silently flip the branch.
        // Now we throw a typed sentinel and discriminate via
        // `instanceof InFlightClaimError`.
        throw new InFlightClaimError(
          `Operator fee withdrawal blocked: a same-token withdrawal ` +
            `(${token}) is already in flight on another Lambda or has not ` +
            `yet completed its post-conditions. Wait for the verifier or ` +
            `force-release the claim if you've manually confirmed completion.`,
        );
      }
      pendingClaimAcquired = true;
    } catch (claimErr) {
      if (claimErr instanceof InFlightClaimError) {
        throw claimErr;
      }
      // Redis unreachable — fail closed. Operator-fee withdraw is
      // irreversible; refuse without the per-token claim safety net.
      throw new Error(
        `Operator fee withdrawal blocked: in-flight claim could not be ` +
          `acquired (${claimErr instanceof Error ? claimErr.message : String(claimErr)}). ` +
          `Refusing to submit without the F24 per-token freeze guard.`,
      );
    }

    let transactionId: string;

    try {
      if (token === 'HBAR') {
        const result = await transferHbar(this.client, sender, recipientAccountId, amount);
        transactionId = result.transactionId;
      } else {
        const lazyTokenId = process.env.LAZY_TOKEN_ID;
        if (!lazyTokenId) throw new Error('LAZY_TOKEN_ID not configured');
        const result = await transferToken(this.client, sender, recipientAccountId, lazyTokenId, amount);
        transactionId = result.transactionId;
      }
    } catch (transferError) {
      // R6-FG-3 (P1-003 + P3-002): gate on parent PreserveClaimError.
      // Pre-fix only ReceiptUncertainError preserved the F24 claim;
      // PostSubmitError DELed it → fresh-key retry passed SET-NX
      // → operator double-pay if original landed.
      const isUncertain = transferError instanceof PreserveClaimError;
      // F24: pre-submit / confirmed-failure path — release the
      // per-token claim so a retry can run. PreserveClaim shapes
      // (uncertain + post-submit) retain the claim for verifier
      // resolution.
      if (pendingClaimAcquired && !isUncertain) {
        try {
          // R3-FG-2: fenced compare-and-delete instead of unfenced DEL.
          const redis = await getRedis();
          await redis.eval(RELEASE_SCRIPT, [PENDING_CLAIM_KEY], [pendingClaimFence]);
        } catch {
          /* TTL is the fallback */
        }
      }
      if (isUncertain) {
        const uncertainTxId = transferError.transactionId;
        // C24 applied to operator fee withdraw: tx may have landed.
        // Persist a dead-letter; operator state INTENTIONALLY not
        // debited yet so reconcile can choose: confirmed-success
        // → debit and resolve; confirmed-failed → just resolve;
        // still-uncertain → leave for next pass.
        try {
          await this.store.upsertDeadLetter({
            transactionId: uncertainTxId,
            timestamp: new Date().toISOString(),
            error: transferError.message,
            kind: 'operator_fee_withdraw_uncertain',
            details: {
              recipientAccountId,
              withdrawTxId: uncertainTxId,
              amount,
              tokenKey,
              token,
              // R3-FG-2: persist the F24 claim fence so the verifier
              // and force-release release paths can compare-and-delete
              // only their own claim, never a fresh acquirer's.
              pendingClaimFence,
            },
          });
        } catch (dlErr) {
          logger.error(
            'CRITICAL: operator_fee_withdraw_uncertain dead-letter write failed',
            {
              component: 'MultiUserAgent',
              event: 'operator_fee_withdraw_uncertain_dl_write_failed',
              withdrawTxId: uncertainTxId,
              error: dlErr instanceof Error ? dlErr.message : String(dlErr),
            },
          );
          await escalateUncertainDlFailure({
            kind: 'operator_fee_withdraw_uncertain',
            uncertainTxId,
            cause: dlErr,
          });
        }
        logger.error('operator fee withdrawal post-submit uncertain', {
          component: 'MultiUserAgent',
          event: 'operator_fee_withdraw_receipt_uncertain',
          withdrawTxId: uncertainTxId,
          amount,
          token,
          errorClass: transferError.constructor.name,
        });
        throw transferError;
      }
      throw transferError;
    }

    // Update operator state — only on confirmed success.
    this.store.updateOperator((op) => ({
      ...op,
      balances: { ...op.balances, [tokenKey]: (op.balances[tokenKey] ?? 0) - amount },
      totalWithdrawnByOperator: { ...op.totalWithdrawnByOperator, [tokenKey]: (op.totalWithdrawnByOperator[tokenKey] ?? 0) + amount },
    }));
    // F24: release the per-token claim after operator state mutates.
    // Order: state-then-claim. If the claim DEL fails after the state
    // update, the TTL handles it; the operator-lock at the route level
    // also serializes future calls so the worst case is a 30-min delay
    // before the next withdraw of the same token can proceed.
    try {
      await this.store.flush();
    } catch {
      /* flush failure logged inside store; continue to release */
    }
    if (pendingClaimAcquired) {
      try {
        // R3-FG-2: fenced compare-and-delete.
        const redis = await getRedis();
        await redis.eval(RELEASE_SCRIPT, [PENDING_CLAIM_KEY], [pendingClaimFence]);
      } catch {
        /* TTL is the fallback */
      }
    }

    // Record via HCS-20 accounting (non-blocking) — pass the token so
    // the on-chain record can be correctly attributed when the operator
    // is withdrawing non-HBAR rake (e.g. LAZY platform fees).
    //
    // F17 (audit A-02): on failure, write `audit_trail_orphaned` so
    // operators surface the missing on-chain anchor. F18 (audit A-13):
    // include `transactionId` (the on-chain withdraw tx) so the reader
    // can dedup duplicate burns on retry.
    try {
      await this.accounting.recordOperatorWithdrawal(
        getOperatorAccountId(this.client),
        amount,
        token,
        transactionId,
      );
    } catch (auditErr) {
      logger.warn('in-band operator-fee withdraw audit write failed', {
        component: 'MultiUserAgent',
        event: 'in_band_operator_withdraw_audit_failed',
        withdrawTxId: transactionId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
      try {
        await this.store.upsertDeadLetter({
          // R4-FG-27: salt by writer phase + UUID-tail.
          transactionId: mintAuditOrphanId('audit-orphan:in-band:operator-fee-withdraw', transactionId),
          timestamp: new Date().toISOString(),
          error: `in-band operator-fee withdraw audit write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
          kind: 'audit_trail_orphaned',
          details: {
            sourceKind: 'operator_fee_withdraw',
            sourceTxId: transactionId,
            agentAccountId: getOperatorAccountId(this.client),
            amount,
            tokenKey: token,
            withdrawTxId: transactionId,
          },
        });
      } catch {
        /* logged above */
      }
      // R3-FG-17: escalate in-band operator-fee audit failure too.
      try {
        const { escalateUncertainDlFailure } = await import('../lib/escalation.js');
        await escalateUncertainDlFailure({
          kind: 'audit_trail_orphaned',
          uncertainTxId: transactionId,
          cause: auditErr,
        });
      } catch (escErr) {
        logger.error('in-band operator-fee audit-failure escalation also failed', {
          component: 'MultiUserAgent',
          error: escErr instanceof Error ? escErr.message : String(escErr),
        });
      }
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
   * Threads the AccountingService and UserLedger through so the
   * receipt-uncertain verification steps can complete the deferred
   * bookkeeping (HCS-20 audit, settle/release reserve) when the
   * on-chain outcome resolves.
   */
  /**
   * Expose the UserLedger for admin recovery tools (force-release
   * endpoint, etc.). NOT for general use — normal callers should go
   * through the higher-level domain methods. Throws if called before
   * `initialize()` resolves.
   */
  getLedgerForRecovery(): UserLedger {
    if (!this.ledger) {
      throw new Error(
        'MultiUserAgent.getLedgerForRecovery() called before initialize() — ledger not set',
      );
    }
    return this.ledger;
  }

  /**
   * Expose AccountingService for admin recovery tools that need to
   * write HCS-20 audit anchors (e.g. force-release with override).
   * Throws if called before initialize().
   */
  getAccountingForRecovery(): AccountingService {
    if (!this.accounting) {
      throw new Error(
        'MultiUserAgent.getAccountingForRecovery() called before initialize() — accounting not set',
      );
    }
    return this.accounting;
  }

  /**
   * Expose the agent's own account id (the operator wallet). Used by
   * recovery routes that need to attribute on-chain audit messages
   * to the operator wallet without parsing env again.
   */
  getAgentAccountIdForRecovery(): string {
    return getOperatorAccountId(this.client);
  }

  async reconcile(): Promise<ReconciliationResult> {
    // M17: defensive — if a future internal caller invokes reconcile()
    // before initialize() resolves (recovery path, test harness, etc.)
    // we'd silently pass undefined accounting/ledger and skip the
    // verifier post-conditions. Surface the misuse instead.
    if (!this.accounting || !this.ledger) {
      throw new Error(
        'MultiUserAgent.reconcile() called before initialize() — accounting/ledger not set',
      );
    }
    return reconcile(
      this.client,
      this.store,
      undefined,
      this.accounting,
      this.ledger,
    );
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
   *
   * R10-FG-2 / Phase-9 Cluster C: returns ReadonlyArray<Readonly<UserAccount>>
   * mirroring IStore.getAllUsers — callers receive the same
   * read-only contract and can't mutate the cached entries.
   */
  getAllUsersStatus(): ReadonlyArray<Readonly<UserAccount>> {
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
        (e.kind === 'prize_transfer_failed' ||
          // F1 (2026-07-04): a play whose sweep was blocked for
          // contamination also stranded THIS user's prizes — resolve
          // those dead-letters on recovery too.
          e.kind === 'prize_transfer_blocked_contamination') &&
        e.details?.userId === userId &&
        !e.resolvedAt,
    );
    const affectedSessions = affectedEntries
      .map((e) => e.details?.sessionId)
      .filter((s): s is string => typeof s === 'string');

    // F1 (2026-07-04 custodial audit): contamination signal. If OTHER
    // users also have unresolved stranded-prize dead-letters, the shared
    // wallet may hold their prizes too — and this all-or-nothing sweep
    // would send them to `userId`. Surface it LOUDLY so the operator
    // reconciles per user (or knowingly accepts the assignment). We do
    // NOT hard-refuse: the operator is explicitly asserting ownership by
    // targeting this user, and can preview the totals via dryRun first.
    const otherUsersStranded = allDeadLetters.filter(
      (e) =>
        (e.kind === 'prize_transfer_failed' ||
          e.kind === 'prize_transfer_blocked_contamination') &&
        e.details?.userId !== userId &&
        !e.resolvedAt,
    );
    if (otherUsersStranded.length > 0) {
      logger.warn(
        'prize recovery: OTHER users have stranded prizes — this all-or-nothing sweep may misassign their prizes to the target user',
        {
          component: 'MultiUserAgent',
          event: 'prize_recovery_contamination_warning',
          targetUserId: userId,
          otherAffectedUsers: Array.from(
            new Set(
              otherUsersStranded
                .map((e) => e.details?.userId)
                .filter((u): u is string => typeof u === 'string'),
            ),
          ),
        },
      );
    }

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
      // R4-FG-19 (round-4 high): contract tx already shifted prize
      // ownership; recovery is a real state change. Pre-fix this only
      // logged warn — topic-only auditor has no record an emergency
      // operator-initiated recovery happened. Now: write
      // audit_trail_orphaned + page operator so the missing anchor is
      // visible and replayable.
      logger.error('CRITICAL: prize recovery HCS-20 audit failed — topic missing the prize_recovery anchor', {
        component: 'MultiUserAgent',
        event: 'prize_recovery_audit_failed',
        userId,
        contractTxId: txResult.result.transactionId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
      try {
        await this.store.upsertDeadLetter({
          transactionId: mintAuditOrphanId('audit-orphan:prize-recovery', txResult.result.transactionId),
          timestamp: new Date().toISOString(),
          error: `prize_recovery audit failed after on-chain recovery: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
          kind: 'audit_trail_orphaned',
          details: {
            sourceKind: 'prize_recovery_post_success_orphan',
            sourceTxId: txResult.result.transactionId,
            userId,
            userAccountId: user.hederaAccountId,
            prizesTransferred: agentState.pendingPrizesCount,
            affectedSessions,
            phase: 'prize_recovery_audit_failed',
          },
        });
      } catch {
        /* logged above */
      }
      try {
        const { escalateUncertainDlFailure } = await import('../lib/escalation.js');
        await escalateUncertainDlFailure({
          kind: 'audit_trail_orphaned',
          uncertainTxId: txResult.result.transactionId,
          userId,
          cause: auditErr,
        });
      } catch (escErr) {
        logger.error('prize-recovery audit escalation also failed', {
          component: 'MultiUserAgent',
          error: escErr instanceof Error ? escErr.message : String(escErr),
        });
      }
    }

    // 8. Mark dead-letter entries as resolved. `upsertDeadLetter` is a
    //    genuine upsert by transactionId — writing the same entry with
    //    resolvedAt set replaces the unresolved row in-place. (The
    //    pre-0.3.3 `recordDeadLetter` was an append, which silently
    //    duplicated dead-letter rows on every recovery; see
    //    docs/incident-playbook.md Symptom 12.) The wider race — two
    //    operators running recovery simultaneously — is closed by the
    //    per-user lock around `recoverStuckPrizesForUser` at the MCP
    //    tool layer (operator.ts).
    // R3-FG-35 (round-3 P5-PT-001): re-read the dead-letter list AFTER
    // the contract tx. Pre-fix: `affectedEntries` was captured at
    // recovery start. Concurrent play that emitted a NEW
    // prize_transfer_failed DL between snapshot and contract tx had
    // its prizes ALSO transferred (transferAllPrizes empties the
    // user's pending state wholesale), but its DL was NOT in the
    // resolve loop → phantom unresolved row referencing prizes that
    // no longer exist on-chain. Now: refresh + scan for any
    // prize_transfer_failed for this user with timestamp ≤ contract
    // tx and resolve those too.
    await this.store.refreshDeadLetters().catch(() => undefined);
    const recoveryTs = new Date().toISOString();
    const allAffectedNow = this.store.getDeadLetters().filter(
      (e) =>
        e.kind === 'prize_transfer_failed' &&
        !e.resolvedAt &&
        (e.details as { userId?: string })?.userId === userId &&
        e.timestamp <= recoveryTs,
    );
    let resolvedDeadLetters = 0;
    for (const entry of allAffectedNow) {
      try {
        await this.store.upsertDeadLetter({
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
      const { recordRedisSuccess } = await import('../lib/redisHealth.js');
      const redis = await getRedis();
      const key = `${KEY_PREFIX.velocity}${tokenKey}:${userId}`;

      // Read current cumulative volume in the rolling window
      // R9-P3-002 / Phase-7 Cluster C: atomic increment-then-expire.
      // Pre-fix this path was `redis.get → compute → redis.set(ex)`.
      // Two concurrent withdrawals across warm Lambdas both read
      // `current=X`, both compute `proposed=X+amount`, both SET —
      // last-write-wins silently undercounts the velocity cap by
      // `amount`. The cap could be doubled by intentional concurrent
      // retries timed to a Redis-replication window.
      //
      // INCRBY is atomic on Upstash; we increment FIRST then check
      // the result.
      //
      // R10-FG-12 / Phase-9 Cluster E: ROLL BACK on the over-cap
      // branch. Pre-Phase-9 the comment here said "we don't roll
      // back ... velocity-cap counters are intentionally lossy on
      // the over-cap edge" — accepting that a rejected withdrawal
      // raises the counter by `amount`. R10-FG-12 surfaced the
      // attack: a compromised session retrying `withdraw(1500)` 10
      // times against a 1000 cap drives the counter to 15000, and
      // every legitimate withdraw for the next 24h returns 503.
      // The "user can't actually spend it" framing missed the
      // point — the attacker's goal is DoS against the victim's
      // withdraw modal, not theft. INCRBY then DECRBY(amount) on
      // over-cap is a single extra atomic round-trip; the velocity
      // counter ends up at the same value as if the increment had
      // never run.
      const proposed = await redis.incrby(key, amount);
      // (Re)set TTL on every increment so the day-rolling window
      // refreshes from the most-recent activity.
      await redis.expire(key, 24 * 60 * 60);

      if (proposed > cap) {
        // R10-FG-12 rollback: undo the increment so a rejected
        // attempt doesn't permanently inflate the counter against
        // the legitimate user.
        await redis.incrby(key, -amount).catch(() => 0);
        recordRedisSuccess();
        return cap - proposed; // negative = over cap
      }

      recordRedisSuccess();
      return cap - proposed; // positive = remaining
    } catch (e) {
      // Record the failure so the breaker can detect sustained outages.
      try {
        const { recordRedisFailure } = await import('../lib/redisHealth.js');
        recordRedisFailure();
      } catch { /* nothing to do if we can't even import the breaker module */ }

      // 0.3.3 hardening: FAIL CLOSED on a velocity-check Redis error.
      // Pre-fix this path returned `cap` (full allowance), so a single
      // 50ms transient Redis failure between the route's
      // `assertRedisHealthy()` and this check disabled the daily cap
      // for that one withdrawal. Combined with rapid retries timed to
      // brief Redis hiccups, an attacker (or compromised session)
      // could blast through the cap. The breaker only catches
      // sustained outages, not single-call failures.
      //
      // Throwing now: the route's catch block translates this to a
      // 503 `redis_degraded` response — same UX as the breaker's
      // sustained-outage 503 but covers single-call failures too.
      console.error('[velocity] check failed — failing closed:', e);
      throw new Error(
        'velocity_check_unavailable: cannot verify withdrawal velocity ' +
        'cap (Redis unreachable); refusing withdrawal until backend recovers',
      );
    }
  }

  /**
   * Public accessor for the current 24h withdrawal volume (and cap) for
   * a given user/token. Thin wrapper around readVelocityState() in
   * src/custodial/velocity.ts — that helper is the single source of
   * truth so /api/user/status can read velocity without instantiating
   * MultiUserAgent at all.
   */
  async getWithdrawalVelocityState(
    userId: string,
    token: string,
  ): Promise<{ cap: number | null; usedToday: number; remaining: number | null }> {
    const { readVelocityState } = await import('./velocity.js');
    return readVelocityState(userId, token);
  }
}
