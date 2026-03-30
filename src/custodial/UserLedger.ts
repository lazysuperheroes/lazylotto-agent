import type { PersistentStore } from './PersistentStore.js';
import type { AccountingService } from './AccountingService.js';
import type { UserAccount, UserBalances, DepositRecord, TokenBalanceEntry } from './types.js';
import { InsufficientBalanceError, UserNotFoundError, UserInactiveError, getTokenEntry, emptyTokenEntry } from './types.js';
import { roundForToken } from '../utils/math.js';

// ── UserLedger ──────────────────────────────────────────────────
//
// Security-critical balance management for the multi-user custodial agent.
// Wraps PersistentStore and AccountingService, enforcing the
// reserve-before-spend pattern:
//
//   reserve(userId, amount)     -- lock funds before play
//   settleSpend(userId, amount) -- deduct from reserved after success
//   releaseReserve(userId, amt) -- return reserved on failure
//
// All HCS-20 accounting calls are fire-and-forget: failures are logged
// but never block balance operations, because local ledger consistency
// takes priority over the on-chain audit trail.
// ────────────────────────────────────────────────────────────────

export class UserLedger {
  constructor(
    private store: PersistentStore,
    private accounting: AccountingService,
    private agentAccountId: string,
  ) {}

  // ── Helpers ───────────────────────────────────────────────────

  private getUserOrThrow(userId: string): UserAccount {
    const user = this.store.getUser(userId);
    if (!user) throw new UserNotFoundError(userId);
    return user;
  }

  // ── Deposits ──────────────────────────────────────────────────

  /**
   * Credit a deposit to a user's available balance after deducting rake.
   *
   * Idempotent: if the transaction has already been processed, returns the
   * current balance without making any changes.
   *
   * @param userId      - Internal user identifier
   * @param grossAmount - Total tokens received (1 decimal place for LAZY)
   * @param txId        - On-chain Hedera transaction ID (idempotency key)
   * @param rakePercent - Platform fee percentage (e.g. 1.0 for 1%)
   * @param token       - Token identifier ("hbar" for native, token ID for FTs)
   * @returns Updated user balances
   */
  async creditDeposit(
    userId: string,
    grossAmount: number,
    txId: string,
    rakePercent: number,
    token: string,
  ): Promise<UserBalances> {
    // 1. Idempotency check
    if (this.store.isTransactionProcessed(txId)) {
      return this.getUserOrThrow(userId).balances;
    }

    // 2. Validate user exists
    const user = this.getUserOrThrow(userId);

    // 3. Calculate rake split (rounded to token's decimal precision)
    const rakeAmount = roundForToken(grossAmount * (rakePercent / 100), token);
    const netAmount = roundForToken(grossAmount - rakeAmount, token);

    // 4. Credit user balance
    const newBalances = this.store.updateBalance(userId, (b) => {
      const entry = b.tokens[token] ?? emptyTokenEntry();
      return {
        tokens: {
          ...b.tokens,
          [token]: {
            ...entry,
            available: entry.available + netAmount,
            totalDeposited: entry.totalDeposited + grossAmount,
            totalRake: entry.totalRake + rakeAmount,
          },
        },
      };
    });

    // 5. Credit operator (platform) rake
    this.store.updateOperator((op) => ({
      ...op,
      balances: { ...op.balances, [token]: (op.balances[token] ?? 0) + rakeAmount },
      totalRakeCollected: { ...op.totalRakeCollected, [token]: (op.totalRakeCollected[token] ?? 0) + rakeAmount },
    }));

    // 6. Persist deposit record
    this.store.recordDeposit({
      transactionId: txId,
      userId,
      grossAmount,
      rakeAmount,
      netAmount,
      tokenId: token === 'hbar' ? null : token,
      memo: user.depositMemo,
      timestamp: new Date().toISOString(),
    });

    // 7. Fire HCS-20 accounting (non-blocking)
    try {
      await this.accounting.recordDeposit(user.hederaAccountId, netAmount, txId);
    } catch (err) {
      console.warn(
        `[UserLedger] HCS-20 recordDeposit failed for user ${userId}, txId ${txId}:`,
        err,
      );
    }

    try {
      await this.accounting.recordRake(user.hederaAccountId, this.agentAccountId, rakeAmount);
    } catch (err) {
      console.warn(
        `[UserLedger] HCS-20 recordRake failed for user ${userId}, txId ${txId}:`,
        err,
      );
    }

    // Flush immediately for financial durability (bypass debounce)
    await this.store.flush();

    return newBalances;
  }

  // ── Reserve / Settle / Release ────────────────────────────────

  /**
   * Atomically move funds from available to reserved before a play session.
   *
   * The check and mutation happen inside the store's updater callback so
   * no TOCTOU race is possible against concurrent callers.
   *
   * @throws UserNotFoundError        if user does not exist
   * @throws UserInactiveError        if user has been deregistered
   * @throws InsufficientBalanceError if available < amount
   */
  reserve(userId: string, amount: number, token: string): UserBalances {
    amount = roundForToken(amount, token);
    const user = this.getUserOrThrow(userId);
    if (!user.active) throw new UserInactiveError(userId);

    return this.store.updateBalance(userId, (b) => {
      const entry = b.tokens[token] ?? emptyTokenEntry();
      if (entry.available < amount) {
        throw new InsufficientBalanceError(userId, amount, entry.available);
      }
      return {
        tokens: {
          ...b.tokens,
          [token]: {
            ...entry,
            available: entry.available - amount,
            reserved: entry.reserved + amount,
          },
        },
      };
    });
  }

  /**
   * Deduct from reserved after a successful play.
   *
   * Called once the on-chain lottery entries have been confirmed.
   */
  settleSpend(userId: string, amountSpent: number, token: string): UserBalances {
    amountSpent = roundForToken(amountSpent, token);
    return this.store.updateBalance(userId, (b) => {
      const entry = b.tokens[token] ?? emptyTokenEntry();
      const deduction = Math.min(amountSpent, entry.reserved);
      if (amountSpent > entry.reserved) {
        console.warn(
          `[UserLedger] settleSpend: amount ${amountSpent} > reserved ${entry.reserved} for ${userId}/${token}. Clamping.`
        );
      }
      return {
        tokens: {
          ...b.tokens,
          [token]: { ...entry, reserved: entry.reserved - deduction },
        },
      };
    });
  }

  /**
   * Move reserved funds back to available on failure.
   *
   * Called when a play session fails or is cancelled so the user's
   * funds are not permanently locked.
   */
  releaseReserve(userId: string, amount: number, token: string): UserBalances {
    amount = roundForToken(amount, token);
    return this.store.updateBalance(userId, (b) => {
      const entry = b.tokens[token] ?? emptyTokenEntry();
      const release = Math.min(amount, entry.reserved);
      if (amount > entry.reserved) {
        console.warn(
          `[UserLedger] releaseReserve: amount ${amount} > reserved ${entry.reserved} for ${userId}/${token}. Clamping.`
        );
      }
      return {
        tokens: {
          ...b.tokens,
          [token]: {
            ...entry,
            available: entry.available + release,
            reserved: entry.reserved - release,
          },
        },
      };
    });
  }

  // ── Withdrawals ───────────────────────────────────────────────

  /**
   * Deduct from available balance for an outbound withdrawal.
   *
   * The caller is responsible for executing the on-chain token transfer
   * after this method returns. If the transfer fails, the caller must
   * reverse the balance change manually.
   *
   * @throws UserNotFoundError        if user does not exist
   * @throws InsufficientBalanceError if available < amount
   */
  async processWithdrawal(userId: string, amount: number, token: string): Promise<UserBalances> {
    amount = roundForToken(amount, token);
    const user = this.getUserOrThrow(userId);

    // Atomic check-and-deduct
    const newBalances = this.store.updateBalance(userId, (b) => {
      const entry = b.tokens[token] ?? emptyTokenEntry();
      if (entry.available < amount) {
        throw new InsufficientBalanceError(userId, amount, entry.available);
      }
      return {
        tokens: {
          ...b.tokens,
          [token]: {
            ...entry,
            available: entry.available - amount,
            totalWithdrawn: entry.totalWithdrawn + amount,
          },
        },
      };
    });

    // Flush immediately for financial durability (bypass debounce)
    await this.store.flush();

    // Fire HCS-20 accounting (non-blocking)
    try {
      await this.accounting.recordWithdrawal(user.hederaAccountId, amount);
    } catch (err) {
      console.warn(
        `[UserLedger] HCS-20 recordWithdrawal failed for user ${userId}:`,
        err,
      );
    }

    return newBalances;
  }

  // ── User Lifecycle ────────────────────────────────────────────

  /**
   * Deactivate a user. After deregistration the user can only withdraw
   * their remaining balance -- no new deposits, plays, or reserves.
   */
  deregisterUser(userId: string): void {
    const user = this.getUserOrThrow(userId);
    user.active = false;
    this.store.saveUser(user);
  }

  // ── Queries ───────────────────────────────────────────────────

  /**
   * Return the current balances for a user.
   *
   * @throws UserNotFoundError if user does not exist
   */
  getBalance(userId: string): UserBalances {
    return this.getUserOrThrow(userId).balances;
  }

  /**
   * Check whether a user can afford a given amount.
   *
   * Returns true only if the user exists, is active, and has sufficient
   * available balance. Never throws.
   */
  canAfford(userId: string, amount: number, token: string): boolean {
    const user = this.store.getUser(userId);
    if (!user) return false;
    if (!user.active) return false;
    const entry = user.balances.tokens[token];
    return entry ? entry.available >= amount : amount <= 0;
  }
}
