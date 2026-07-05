import { getTransactionsByAccount, type MirrorTransaction } from '../hedera/mirror.js';
import type { IStore } from './IStore.js';
import type { UserLedger } from './UserLedger.js';
import type { CustodialConfig } from './types.js';
import { MaxUserBalanceExceededError } from './types.js';
import { HBAR_TOKEN_KEY } from '../config/strategy.js';
import { getTokenMeta, getTokenMetaSync } from '../utils/math.js';
import { logger } from '../lib/logger.js';
import { getEffectiveRakePercent } from './rakeHoliday.js';

interface CreditInfo {
  amount: number;
  token: string; // "hbar" or token ID
}

/**
 * R2-FG-26 (round-2 G-01 P7): typed sentinel thrown by extractCredit
 * when a deposit references an unknown token. pollOnce catches this
 * specifically and HOLDS the watermark for that tx so the next poll
 * cycle (after the registry warms) can re-process it. Pre-fix: a
 * generic Error was thrown and the watermark advanced unconditionally,
 * silently dropping the deposit forever despite the comment claiming
 * auto-retry.
 */
class UnknownTokenError extends Error {
  readonly tokenId: string;
  constructor(tokenId: string) {
    super(
      `Unknown token ${tokenId} — not in registry. ` +
        'Async lookup triggered. Deposit deferred to dead-letter queue (watermark held).',
    );
    this.tokenId = tokenId;
    this.name = 'UnknownTokenError';
  }
}

/**
 * R2-FG-28 (round-2 G-16): per-user dead-letter rate cap. Anyone can
 * deposit to the agent with `memo: ll-VVVV` to credit victim V (or
 * to push V over `maxUserBalance` and force a dead-letter write per
 * deposit). The memo format is publicly observable. Without a cap an
 * attacker can spam the dead-letter queue at low cost — DoS the
 * operator console + bloat Redis.
 *
 * Counter is `dl-rate:<userId>` with a 1-hour rolling window. Above
 * `MAX_DEAD_LETTERS_PER_USER_PER_HOUR`, the deposit is dropped with a
 * single `deposit_spam_detected` aggregate row instead of N
 * per-deposit rows.
 */
const MAX_DEAD_LETTERS_PER_USER_PER_HOUR = 5;
const DL_RATE_CAP_TTL_SEC = 3600;

async function shouldRateLimitDlForUser(
  userId: string,
): Promise<{ rateLimited: boolean; count: number }> {
  try {
    const { getRedis, KEY_PREFIX } = await import('../auth/redis.js');
    const redis = await getRedis();
    // R3-FG-59 (round-3 P2-008): use module-load NET capture via
    // KEY_PREFIX.dlRate. Pre-fix read process.env at runtime; tests
    // (or any env mutation) split counters across prefixes.
    const key = `${KEY_PREFIX.dlRate}${userId}`;
    const count = await redis.incr(key);
    if (count === 1) {
      try {
        await redis.expire(key, DL_RATE_CAP_TTL_SEC);
      } catch {
        /* TTL is hygiene */
      }
    }
    return {
      rateLimited: count > MAX_DEAD_LETTERS_PER_USER_PER_HOUR,
      count,
    };
  } catch {
    // Redis unavailable — fail-open (don't block legitimate dead-letters).
    return { rateLimited: false, count: 0 };
  }
}

/**
 * In-memory observability counters for the deposit watcher.
 *
 * These counters live for the lifetime of the watcher instance —
 * meaning the lifetime of one Lambda warm container in serverless
 * mode, or the lifetime of the CLI process. They give operators a
 * single-call view into "is deposit detection working at all?"
 * without having to grep logs.
 *
 * The counters intentionally distinguish between:
 *   - `processed`: deposits credited to a registered user
 *   - `skippedUnmatchedLazyMemo`: memo starts with `ll-` but no user
 *     matches — suspicious, may indicate stale memos or a registration
 *     race
 *   - `skippedExceedsMaxBalance`: would push the user over the cap
 *     — funds stay in wallet, requires operator action
 *   - `skippedNonDeposit`: any other skip (no memo, non-`ll-` memo,
 *     duplicate, non-success result) — these are normal background
 *     noise and aren't surfaced individually
 *   - `errors`: exceptions that bubbled out of `processTransaction`,
 *     also recorded in the dead-letter queue
 */
export interface DepositWatcherStats {
  processed: number;
  skippedUnmatchedLazyMemo: number;
  skippedExceedsMaxBalance: number;
  skippedNonDeposit: number;
  errors: number;
  pollCount: number;
  lastPollAt: string | null;
  lastDepositAt: string | null;
  lastError: { message: string; at: string } | null;
}

// ── Constants ────────────────────────────────────────────────────

const TINYBARS_PER_HBAR = 1e8;

// ── DepositWatcher ───────────────────────────────────────────────
//
// Polls the Hedera mirror node for incoming transactions to the
// agent wallet, matches them to registered users by memo, and
// credits their balances via the UserLedger.
//
// Design decisions:
//   - Overlapping poll guard prevents concurrent mirror node queries
//     if a previous poll is still in-flight (mirror node latency).
//   - Individual transaction errors are caught and logged so that
//     one bad transaction does not halt the entire poll loop.
//   - Watermark advances only after at least one transaction has been
//     processed, preventing data loss on empty or error-only pages.
//   - maxUserBalance is checked pre-credit; deposits that would
//     exceed it are skipped (funds stay in wallet for manual handling).
// ─────────────────────────────────────────────────────────────────

export class DepositWatcher {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private stats: DepositWatcherStats = {
    processed: 0,
    skippedUnmatchedLazyMemo: 0,
    skippedExceedsMaxBalance: 0,
    skippedNonDeposit: 0,
    errors: 0,
    pollCount: 0,
    lastPollAt: null,
    lastDepositAt: null,
    lastError: null,
  };

  constructor(
    private agentAccountId: string,
    private store: IStore,
    private ledger: UserLedger,
    private config: CustodialConfig,
  ) {}

  /**
   * Snapshot of the in-memory observability counters. Returned by
   * value so callers can't mutate internal state.
   */
  getStats(): DepositWatcherStats {
    return { ...this.stats, lastError: this.stats.lastError && { ...this.stats.lastError } };
  }

  // ── Lifecycle ───────────────────────────────────────────────

  start(): void {
    if (this.intervalId) return;
    logger.info('deposit watcher started', {
      component: 'DepositWatcher',
      pollIntervalMs: this.config.depositPollIntervalMs,
    });
    // Do an initial poll immediately
    void this.pollOnce();
    this.intervalId = setInterval(
      () => void this.pollOnce(),
      this.config.depositPollIntervalMs,
    );
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  isRunning(): boolean {
    return this.intervalId !== null;
  }

  // ── Poll ────────────────────────────────────────────────────

  /**
   * Execute a single poll cycle against the Hedera mirror node.
   *
   * Returns the number of deposits successfully processed. Exposed
   * publicly so tests can invoke it directly without timers.
   */
  async pollOnce(): Promise<number> {
    if (this.isPolling) return 0;
    this.isPolling = true;
    this.stats.pollCount++;
    this.stats.lastPollAt = new Date().toISOString();

    try {
      // R4-FG-67 (round-4 low): refresh the user index so a sibling
      // Lambda's just-registered user is visible to this poll.
      // Pre-fix `registerUser` flushed but the SIBLING Lambda whose
      // `pollOnce` is running might still be holding a stale local
      // user-index (the cache was loaded before the new registration
      // landed). Refreshing here closes the first-deposit unmatched-memo
      // race that R3-FG-30 closed on the writer side. Best-effort —
      // a refresh failure shouldn't block the poll; subsequent passes
      // will retry.
      //
      // R5-FG-41 (P11-005): refresh every Nth poll, not every poll.
      // Pre-fix R4-FG-67 ran SMEMBERS + pipelined GET-per-user on
      // every 60s tick. At 10K users × N warm Lambdas, that's ~167
      // GETs/sec × N just for the watcher, hitting Upstash REST
      // payload caps. Now: refresh on cold-start (pollCount===1) and
      // every REFRESH_USERS_EVERY_N_POLLS ticks afterwards. The
      // unmatched-memo path (later in pollOnce) does an on-demand
      // refresh anyway when it can't find a user, which preserves
      // R3-FG-30's first-deposit guarantee.
      const REFRESH_USERS_EVERY_N_POLLS = 10;
      const shouldRefresh =
        this.stats.pollCount === 1 ||
        this.stats.pollCount % REFRESH_USERS_EVERY_N_POLLS === 0;
      if (shouldRefresh) {
        try {
          await (this.store as { refreshUserIndex?: () => Promise<void> }).refreshUserIndex?.();
        } catch (refreshErr) {
          logger.warn('refreshUserIndex failed at pollOnce start', {
            component: 'DepositWatcher',
            error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
          });
        }
      }
      let watermark = this.store.getWatermark();

      // On first run (no watermark), start from "now" to avoid re-processing
      // all historical transactions for an existing agent account.
      if (!watermark) {
        watermark = `${Math.floor(Date.now() / 1000)}.000000000`;
        this.store.setWatermark(watermark);
        logger.info('no watermark found, starting from now', {
          component: 'DepositWatcher',
          watermark,
        });
      }

      const txs = await getTransactionsByAccount(this.agentAccountId, {
        timestampGt: watermark,
        limit: 25,
        order: 'asc',
      });

      let processed = 0;
      let lastTimestamp: string | null = null;
      // R2-FG-26: track the earliest unknown-token tx we encounter
      // this pass so we can hold the watermark before it. Holding the
      // entire window lets the registry warm up + auto-retry on the
      // next poll cycle.
      let earliestUnknownTokenTs: string | null = null;

      for (const tx of txs) {
        try {
          const credited = await this.processTransaction(tx);
          if (credited) {
            processed++;
            this.stats.processed++;
            this.stats.lastDepositAt = new Date().toISOString();
          }
        } catch (err) {
          this.stats.errors++;
          this.stats.lastError = {
            message: err instanceof Error ? err.message : String(err),
            at: new Date().toISOString(),
          };
          logger.error('deposit processing failed', {
            component: 'DepositWatcher',
            event: 'deposit_failed',
            txId: tx.transaction_id,
            error: err instanceof Error ? err : new Error(String(err)),
          });
          // Add to dead-letter queue for operator review.
          // Capture sender + memo so users can find their stuck deposits.
          // R2-FG-26: stamp `auto_retry: true` on unknown-token entries
          // so the next pass can re-process once the registry warms.
          //
          // R4-FG-20 (round-4 high): bounded retry budget on unknown
          // tokens. Pre-fix the watermark held forever, blocking every
          // subsequent legitimate deposit (HBAR, LAZY, etc.) until
          // manual intervention — single bad-token deposit DoS'd the
          // entire deposit watcher. Now: track `unknownTokenAttempts`
          // on the entry; after MAX_UNKNOWN_TOKEN_ATTEMPTS polls,
          // promote to a hard dead-letter and ADVANCE the watermark.
          // The deposit is still recoverable via /api/admin/replay-
          // deposit; deferring it shouldn't keep the queue wedged.
          const isUnknownToken = err instanceof UnknownTokenError;
          const MAX_UNKNOWN_TOKEN_ATTEMPTS = 10;
          let unknownTokenAttempts = 0;
          let promotedToHardDl = false;
          if (isUnknownToken) {
            const existing = this.store
              .getDeadLetters()
              .find((e) => e.transactionId === tx.transaction_id);
            const prior =
              ((existing?.details as { unknownTokenAttempts?: number } | undefined)?.unknownTokenAttempts) ?? 0;
            unknownTokenAttempts = prior + 1;
            promotedToHardDl = unknownTokenAttempts >= MAX_UNKNOWN_TOKEN_ATTEMPTS;
          }
          await this.store.upsertDeadLetter({
            transactionId: tx.transaction_id,
            timestamp: tx.consensus_timestamp,
            error: err instanceof Error ? err.message : String(err),
            sender: this.extractSender(tx) ?? undefined,
            memo: this.decodeMemo(tx.memo_base64),
            ...(isUnknownToken
              ? {
                  details: {
                    // Stop autoRetrying once we hit the cap so the
                    // operator's replay-deposit endpoint becomes the
                    // single recovery path.
                    autoRetry: !promotedToHardDl,
                    unknownTokenId: (err as UnknownTokenError).tokenId,
                    unknownTokenAttempts,
                    ...(promotedToHardDl ? { promotedAt: new Date().toISOString() } : {}),
                  },
                }
              : {}),
          });
          if (isUnknownToken) {
            if (promotedToHardDl) {
              // R4-FG-20: cap blown — promote to hard DL and let the
              // watermark advance past this tx. Operator can replay via
              // admin endpoint once the token registry is fixed.
              logger.error('unknown-token deposit promoted to hard DL after attempt cap', {
                component: 'DepositWatcher',
                event: 'unknown_token_promoted',
                txId: tx.transaction_id,
                tokenId: (err as UnknownTokenError).tokenId,
                attempts: unknownTokenAttempts,
              });
              // Don't hold watermark — fall through to lastTimestamp advance below.
            } else {
              // Hold watermark BEFORE this tx so it gets re-processed.
              if (
                !earliestUnknownTokenTs ||
                tx.consensus_timestamp < earliestUnknownTokenTs
              ) {
                earliestUnknownTokenTs = tx.consensus_timestamp;
              }
              // Skip the lastTimestamp advance for this tx.
              continue;
            }
          }
        }
        // Track the last timestamp regardless of processing outcome
        // so we advance past failed/skipped transactions
        lastTimestamp = tx.consensus_timestamp;
      }

      // R2-FG-26: if we encountered an unknown-token deposit, hold
      // the watermark just BEFORE that tx so the next poll cycle
      // (after async registry warmup) re-processes it. We pick the
      // smaller of (last-known-good-timestamp, earliestUnknownTokenTs).
      // Mirror's `timestampGt` is exclusive, so subtracting 1 nano
      // would re-fetch the unknown token tx. We just leave lastTimestamp
      // as the last known-good ts before any unknown-token tx (the
      // `continue` above ensures we don't advance past one).
      if (earliestUnknownTokenTs) {
        // Don't advance past the earliest unknown-token tx — hold
        // the watermark at whatever it was before this poll began.
        // (lastTimestamp may already be earlier; if so, use it.)
        if (lastTimestamp && lastTimestamp >= earliestUnknownTokenTs) {
          // lastTimestamp surpassed earliestUnknownTokenTs (because
          // some later tx processed cleanly). Roll back to just before
          // the unknown-token tx so it gets re-tried. We approximate
          // "just before" by leaving the watermark untouched this
          // pass — auto_retry on the dead-letter row drives the
          // re-process via `replay-deposit` admin tooling.
          lastTimestamp = null;
        }
      }

      // Advance watermark to the last transaction seen, even if some
      // were skipped, so we don't re-fetch the same page next poll
      if (lastTimestamp) {
        this.store.setWatermark(lastTimestamp);
      }

      return processed;
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = {
        message: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      };
      logger.error('deposit poll failed', {
        component: 'DepositWatcher',
        event: 'poll_failed',
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return 0;
    } finally {
      this.isPolling = false;
    }
  }

  // ── Private ─────────────────────────────────────────────────

  /**
   * Process a single mirror node transaction. Returns true if a
   * deposit was successfully credited, false if skipped.
   */
  /**
   * Process a single mirror node transaction. Returns true if a
   * deposit was successfully credited, false if skipped.
   *
   * 0.3.4: changed to `public` so the admin replay-deposit route
   * (`POST /api/admin/replay-deposit`) can fetch a tx from mirror by
   * id and re-run it through the same flow that the live poll uses.
   * Bypasses the watermark — designed for operator-driven recovery
   * of dead-lettered deposits whose original errors are now resolved
   * (e.g. token registered after the deposit landed).
   */
  async processTransaction(tx: MirrorTransaction): Promise<boolean> {
    // Only process successful transactions
    if (tx.result !== 'SUCCESS') {
      this.stats.skippedNonDeposit++;
      return false;
    }

    // Idempotency: skip already-processed transactions
    if (this.store.isTransactionProcessed(tx.transaction_id)) {
      this.stats.skippedNonDeposit++;
      return false;
    }

    // Decode memo from base64
    const memo = this.decodeMemo(tx.memo_base64);
    if (!memo) {
      this.stats.skippedNonDeposit++;
      return false;
    }

    // Match memo to a registered user
    const user = this.store.getUserByMemo(memo);
    if (!user) {
      // Only count + log if it looks like a lazylotto memo (ll- prefix).
      // Other memos belong to refunds, withdrawals, or unrelated traffic
      // and are normal background noise.
      if (memo.startsWith('ll-')) {
        this.stats.skippedUnmatchedLazyMemo++;
        logger.warn('deposit memo did not match any user', {
          component: 'DepositWatcher',
          event: 'deposit_unmatched_memo',
          memo,
          txId: tx.transaction_id,
          hint: 'stale memo from previous session, or registration race',
        });
      } else {
        this.stats.skippedNonDeposit++;
      }
      return false;
    }

    // Reject deposits to deregistered users — add to dead-letter for operator review
    if (!user.active) {
      logger.warn('deposit to inactive user', {
        component: 'DepositWatcher',
        event: 'deposit_inactive_user',
        userId: user.userId,
        memo,
        txId: tx.transaction_id,
      });
      // R2-FG-28: per-user dead-letter rate cap — drop with aggregate.
      const { rateLimited, count } = await shouldRateLimitDlForUser(user.userId);
      if (rateLimited) {
        logger.warn('deposit-spam dead-letter rate cap hit; dropping', {
          component: 'DepositWatcher',
          event: 'deposit_spam_dropped',
          userId: user.userId,
          countInWindow: count,
          txId: tx.transaction_id,
        });
        // Single aggregate row keyed by user; subsequent drops within
        // the window collapse onto it via upsertDeadLetter REPLACE.
        await this.store.upsertDeadLetter({
          transactionId: `deposit-spam:${user.userId}`,
          timestamp: tx.consensus_timestamp,
          error:
            `Deposit-spam rate cap exceeded for user ${user.userId} ` +
            `(>${MAX_DEAD_LETTERS_PER_USER_PER_HOUR} dead-letters in 1h). ` +
            `Subsequent deposits are dropped without per-tx rows; this aggregate ` +
            `replaces itself each time.`,
          memo,
        });
        return false;
      }
      await this.store.upsertDeadLetter({
        transactionId: tx.transaction_id,
        timestamp: tx.consensus_timestamp,
        error: `Deposit to inactive/deregistered user ${user.userId}. Funds in agent wallet.`,
        sender: this.extractSender(tx) ?? undefined,
        memo,
      });
      return false;
    }

    // Determine credit amount and token type
    const credit = this.extractCredit(tx);
    if (!credit || credit.amount <= 0) {
      this.stats.skippedNonDeposit++;
      return false;
    }

    // Enforce max balance (check the specific token entry)
    const tokenEntry = user.balances.tokens[credit.token];
    const currentAvailable = tokenEntry?.available ?? 0;
    if (currentAvailable + credit.amount > this.config.maxUserBalance) {
      this.stats.skippedExceedsMaxBalance++;
      logger.warn('deposit exceeds max balance', {
        component: 'DepositWatcher',
        event: 'deposit_exceeds_max',
        userId: user.userId,
        currentAvailable,
        depositAmount: credit.amount,
        token: credit.token,
        max: this.config.maxUserBalance,
        txId: tx.transaction_id,
      });
      // R2-FG-28: per-user dead-letter rate cap.
      const exceedRateCheck = await shouldRateLimitDlForUser(user.userId);
      if (exceedRateCheck.rateLimited) {
        logger.warn('deposit-spam dead-letter rate cap hit (max-balance path); dropping', {
          component: 'DepositWatcher',
          event: 'deposit_spam_dropped',
          userId: user.userId,
          countInWindow: exceedRateCheck.count,
          txId: tx.transaction_id,
        });
        await this.store.upsertDeadLetter({
          transactionId: `deposit-spam:${user.userId}`,
          timestamp: tx.consensus_timestamp,
          error:
            `Deposit-spam rate cap exceeded for user ${user.userId} ` +
            `(>${MAX_DEAD_LETTERS_PER_USER_PER_HOUR} dead-letters in 1h). Aggregate row.`,
          memo,
        });
        return false;
      }
      // Funds stay in wallet for manual handling — record so operators
      // can see this without scraping logs.
      await this.store.upsertDeadLetter({
        transactionId: tx.transaction_id,
        timestamp: tx.consensus_timestamp,
        error: `Deposit ${credit.amount} ${credit.token} would exceed max balance for user ${user.userId} (current: ${currentAvailable}, max: ${this.config.maxUserBalance}).`,
        sender: this.extractSender(tx) ?? undefined,
        memo,
      });
      return false;
    }

    // Credit the user's balance via the ledger (token-specific). The rake is
    // resolved through getEffectiveRakePercent so a user with an active, paid
    // x402 "rake holiday" is charged 0%. creditDeposit itself is UNCHANGED —
    // only the rate passed in differs. See src/custodial/rakeHoliday.ts.
    const rakePercent = await getEffectiveRakePercent(
      user.userId,
      user.rakePercent,
    );
    try {
      await this.ledger.creditDeposit(
        user.userId,
        credit.amount,
        tx.transaction_id,
        rakePercent,
        credit.token,
        // F18 (2026-07-05 custodial audit): the under-lock re-check closes
        // the TOCTOU where the pre-lock check above passed on a stale
        // snapshot and a concurrent deposit credited first.
        this.config.maxUserBalance,
      );
    } catch (creditErr) {
      if (creditErr instanceof MaxUserBalanceExceededError) {
        // The pre-lock check passed on a stale snapshot but a concurrent
        // deposit credited first; the under-lock re-check caught the race.
        // Dead-letter like the pre-lock skip — funds stay in the wallet for
        // manual handling; the user's own balance is simply not over-credited.
        this.stats.skippedExceedsMaxBalance++;
        logger.warn('deposit exceeds max balance (caught under lock — TOCTOU race)', {
          component: 'DepositWatcher',
          event: 'deposit_exceeds_max_under_lock',
          userId: user.userId,
          depositAmount: credit.amount,
          token: credit.token,
          max: this.config.maxUserBalance,
          txId: tx.transaction_id,
        });
        const rateCheck = await shouldRateLimitDlForUser(user.userId);
        if (!rateCheck.rateLimited) {
          await this.store.upsertDeadLetter({
            transactionId: tx.transaction_id,
            timestamp: tx.consensus_timestamp,
            error: `Deposit ${credit.amount} ${credit.token} would exceed max balance for user ${user.userId} under the credit lock (concurrent-deposit race, max: ${this.config.maxUserBalance}).`,
            sender: this.extractSender(tx) ?? undefined,
            memo,
          });
        }
        return false;
      }
      throw creditErr;
    }

    logger.info('deposit credited', {
      component: 'DepositWatcher',
      event: 'deposit_credited',
      userId: user.userId,
      amount: credit.amount,
      token: credit.token,
      txId: tx.transaction_id,
      memo,
    });

    return true;
  }

  /**
   * Decode a base64-encoded memo string. Returns empty string if
   * the memo is missing or cannot be decoded.
   */
  private decodeMemo(memoBase64: string): string {
    if (!memoBase64) return '';
    try {
      return Buffer.from(memoBase64, 'base64').toString('utf-8');
    } catch {
      return '';
    }
  }

  /**
   * Extract the sender account ID from a mirror node transaction.
   * Looks for the account with the largest negative HBAR transfer
   * (excluding the agent itself), or any account that sent FTs to
   * the agent. Returns null if it can't determine a sender.
   */
  private extractSender(tx: MirrorTransaction): string | null {
    // Try token transfers first — sender is the account with negative amount
    if (tx.token_transfers?.length) {
      for (const tt of tx.token_transfers) {
        if (tt.amount < 0 && tt.account !== this.agentAccountId) {
          return tt.account;
        }
      }
    }

    // Fallback: HBAR transfer with the largest negative amount
    if (tx.transfers?.length) {
      let bestSender: string | null = null;
      let bestAmount = 0;
      for (const t of tx.transfers) {
        if (t.account === this.agentAccountId) continue;
        if (t.amount < bestAmount) {
          bestAmount = t.amount;
          bestSender = t.account;
        }
      }
      return bestSender;
    }

    return null;
  }

  /**
   * Extract credit amount and token from a transaction.
   *
   * Checks all token transfers first (any FT to agent), then HBAR.
   * Returns the token ID (or "hbar") along with the amount.
   */
  private extractCredit(tx: MirrorTransaction): CreditInfo | null {
    // Check token transfers first (any FT deposit)
    if (tx.token_transfers?.length) {
      for (const tt of tx.token_transfers) {
        if (tt.account === this.agentAccountId && tt.amount > 0) {
          // Check if token is registered (not just decimals value)
          const meta = getTokenMetaSync(tt.token_id);
          if (!meta) {
            // Unknown token — trigger async lookup for future poll cycles.
            // R3-FG-20: getTokenMeta now THROWS on mirror failure (was
            // silently caching `{decimals: 0}`), so silence the rejection
            // here — the dead-letter we throw below carries the deposit
            // forward; the next pollOnce after registry warm-up retries
            // the lookup organically.
            void getTokenMeta(tt.token_id).catch(() => undefined);
            // R2-FG-26: throw a typed sentinel so pollOnce can detect
            // unknown-token deposits specifically and HOLD the
            // watermark, giving the registry warm-up a chance to
            // resolve. Pre-fix: watermark advanced unconditionally,
            // and the comment promised auto-retry on next poll —
            // which the watermark advance directly contradicted.
            throw new UnknownTokenError(tt.token_id);
          }
          return {
            amount: tt.amount / Math.pow(10, meta.decimals),
            token: tt.token_id,
          };
        }
      }
    }

    // Fallback: HBAR transfer
    if (tx.transfers?.length) {
      const hbarTransfer = tx.transfers.find(
        (t) => t.account === this.agentAccountId && t.amount > 0,
      );
      if (hbarTransfer) {
        return {
          amount: hbarTransfer.amount / TINYBARS_PER_HBAR,
          token: HBAR_TOKEN_KEY,
        };
      }
    }

    return null;
  }
}
