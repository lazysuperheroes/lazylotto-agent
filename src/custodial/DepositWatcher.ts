import { getTransactionsByAccount, type MirrorTransaction } from '../hedera/mirror.js';
import type { IStore } from './IStore.js';
import type { UserLedger } from './UserLedger.js';
import type { CustodialConfig } from './types.js';
import { HBAR_TOKEN_KEY } from '../config/strategy.js';
import { getTokenMeta, getTokenMetaSync } from '../utils/math.js';
import { logger } from '../lib/logger.js';

interface CreditInfo {
  amount: number;
  token: string; // "hbar" or token ID
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
          this.store.recordDeadLetter({
            transactionId: tx.transaction_id,
            timestamp: tx.consensus_timestamp,
            error: err instanceof Error ? err.message : String(err),
            sender: this.extractSender(tx) ?? undefined,
            memo: this.decodeMemo(tx.memo_base64),
          });
        }
        // Track the last timestamp regardless of processing outcome
        // so we advance past failed/skipped transactions
        lastTimestamp = tx.consensus_timestamp;
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
  private async processTransaction(tx: MirrorTransaction): Promise<boolean> {
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
      this.store.recordDeadLetter({
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
      // Funds stay in wallet for manual handling — record so operators
      // can see this without scraping logs.
      this.store.recordDeadLetter({
        transactionId: tx.transaction_id,
        timestamp: tx.consensus_timestamp,
        error: `Deposit ${credit.amount} ${credit.token} would exceed max balance for user ${user.userId} (current: ${currentAvailable}, max: ${this.config.maxUserBalance}).`,
        sender: this.extractSender(tx) ?? undefined,
        memo,
      });
      return false;
    }

    // Credit the user's balance via the ledger (token-specific)
    await this.ledger.creditDeposit(
      user.userId,
      credit.amount,
      tx.transaction_id,
      user.rakePercent,
      credit.token,
    );

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
            // Unknown token — trigger async lookup for future poll cycles
            void getTokenMeta(tt.token_id);
            // Throw so pollOnce's catch block creates a dead-letter entry
            throw new Error(
              `Unknown token ${tt.token_id} — not in registry. ` +
                'Async lookup triggered. Deposit deferred to dead-letter queue.'
            );
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
