import { getTransactionsByAccount, type MirrorTransaction } from '../hedera/mirror.js';
import type { PersistentStore } from './PersistentStore.js';
import type { UserLedger } from './UserLedger.js';
import type { CustodialConfig } from './types.js';

// ── Constants ────────────────────────────────────────────────────

const TINYBARS_PER_HBAR = 1e8;
const LAZY_DECIMALS = 1; // $LAZY uses 1 decimal place: 10 base units = 1 LAZY

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
            `[DepositWatcher] Error processing transaction ${tx.transaction_id}:`,
            err,
          );
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

    // Determine credit amount — try token transfers first, fall back to HBAR
    const creditAmount = this.extractCreditAmount(tx);
    if (creditAmount <= 0) return false;

    // Enforce max balance
    if (user.balances.available + creditAmount > this.config.maxUserBalance) {
      console.warn(
        `[DepositWatcher] Deposit would exceed max balance for user ${user.userId}: ` +
          `current=${user.balances.available}, deposit=${creditAmount}, ` +
          `max=${this.config.maxUserBalance}`,
      );
      return false;
    }

    // Credit the user's balance via the ledger
    await this.ledger.creditDeposit(
      user.userId,
      creditAmount,
      tx.transaction_id,
      user.rakePercent,
    );

    console.log(
      `[DepositWatcher] Deposit detected: ${creditAmount} for user ${user.userId} (memo: ${memo})`,
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
   * Extract the credit amount from a transaction.
   *
   * Priority:
   *   1. LAZY token transfer to the agent account
   *   2. HBAR transfer to the agent account (fallback)
   *
   * Returns 0 if no positive inbound transfer is found.
   */
  private extractCreditAmount(tx: MirrorTransaction): number {
    const lazyTokenId = process.env.LAZY_TOKEN_ID;

    // Check token transfers first (LAZY deposits are the primary flow)
    if (lazyTokenId && tx.token_transfers?.length) {
      const tokenTransfer = tx.token_transfers.find(
        (t) =>
          t.token_id === lazyTokenId &&
          t.account === this.agentAccountId &&
          t.amount > 0,
      );
      if (tokenTransfer) {
        // LAZY has 1 decimal place: raw amount / 10
        return tokenTransfer.amount / Math.pow(10, LAZY_DECIMALS);
      }
    }

    // Fallback: HBAR transfer
    if (tx.transfers?.length) {
      const hbarTransfer = tx.transfers.find(
        (t) => t.account === this.agentAccountId && t.amount > 0,
      );
      if (hbarTransfer) {
        return hbarTransfer.amount / TINYBARS_PER_HBAR;
      }
    }

    return 0;
  }
}
