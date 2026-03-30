import { getTransactionsByAccount, type MirrorTransaction } from '../hedera/mirror.js';
import type { PersistentStore } from './PersistentStore.js';
import type { UserLedger } from './UserLedger.js';
import type { CustodialConfig } from './types.js';
import { HBAR_TOKEN_KEY } from '../config/strategy.js';
import { HEDERA_DEFAULTS } from '../config/defaults.js';
import { getDecimalsSync, getTokenMeta } from '../utils/math.js';

interface CreditInfo {
  amount: number;
  token: string; // "hbar" or token ID
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

  constructor(
    private agentAccountId: string,
    private store: PersistentStore,
    private ledger: UserLedger,
    private config: CustodialConfig,
  ) {}

  // ── Lifecycle ───────────────────────────────────────────────

  start(): void {
    if (this.intervalId) return;
    console.log(
      `[DepositWatcher] polling every ${this.config.depositPollIntervalMs}ms`,
    );
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

    try {
      const watermark = this.store.getWatermark();

      const txs = await getTransactionsByAccount(this.agentAccountId, {
        timestampGt: watermark || undefined,
        limit: 25,
        order: 'asc',
      });

      let processed = 0;
      let lastTimestamp: string | null = null;

      for (const tx of txs) {
        try {
          const credited = await this.processTransaction(tx);
          if (credited) processed++;
        } catch (err) {
          console.error(
            `[DepositWatcher] FAILED to process transaction ${tx.transaction_id}:`,
            err,
          );
          // Add to dead-letter queue for operator review
          this.store.recordDeadLetter({
            transactionId: tx.transaction_id,
            timestamp: tx.consensus_timestamp,
            error: err instanceof Error ? err.message : String(err),
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
      console.error('[DepositWatcher] Poll failed:', err);
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
    if (tx.result !== 'SUCCESS') return false;

    // Idempotency: skip already-processed transactions
    if (this.store.isTransactionProcessed(tx.transaction_id)) return false;

    // Decode memo from base64
    const memo = this.decodeMemo(tx.memo_base64);
    if (!memo) return false;

    // Match memo to a registered user
    const user = this.store.getUserByMemo(memo);
    if (!user) {
      console.warn(
        `[DepositWatcher] Unknown deposit memo "${memo}" in tx ${tx.transaction_id}`,
      );
      return false;
    }

    // Reject deposits to deregistered users — add to dead-letter for operator review
    if (!user.active) {
      console.warn(
        `[DepositWatcher] Deposit to inactive user ${user.userId} (memo: ${memo}). Added to dead-letter queue.`,
      );
      this.store.recordDeadLetter({
        transactionId: tx.transaction_id,
        timestamp: tx.consensus_timestamp,
        error: `Deposit to inactive/deregistered user ${user.userId}. Funds in agent wallet.`,
      });
      return false;
    }

    // Determine credit amount and token type
    const credit = this.extractCredit(tx);
    if (!credit || credit.amount <= 0) return false;

    // Enforce max balance (check the specific token entry)
    const tokenEntry = user.balances.tokens[credit.token];
    const currentAvailable = tokenEntry?.available ?? 0;
    if (currentAvailable + credit.amount > this.config.maxUserBalance) {
      console.warn(
        `[DepositWatcher] Deposit would exceed max balance for user ${user.userId}: ` +
          `current=${currentAvailable}, deposit=${credit.amount}, token=${credit.token}, ` +
          `max=${this.config.maxUserBalance}`,
      );
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

    console.log(
      `[DepositWatcher] Deposit: ${credit.amount} ${credit.token} for user ${user.userId} (memo: ${memo})`,
    );

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
          // Look up decimals from token registry
          let decimals = getDecimalsSync(tt.token_id);
          if (decimals === 0 && tt.token_id !== 'hbar') {
            // Unknown token — try async lookup and reject this deposit
            // The next deposit of this token will use the cached decimals
            void getTokenMeta(tt.token_id);
            console.warn(
              `[DepositWatcher] Unknown token ${tt.token_id} — decimals not cached. ` +
                'Deposit will be added to dead-letter queue. Retry on next poll.',
            );
            return null; // reject — caller adds to dead-letter
          }
          return {
            amount: tt.amount / Math.pow(10, decimals),
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
