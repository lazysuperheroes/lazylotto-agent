import type { IStore } from './IStore.js';
import type { AccountingService } from './AccountingService.js';
import type { UserAccount, UserBalances } from './types.js';
import { InsufficientBalanceError, UserNotFoundError, UserInactiveError, emptyTokenEntry } from './types.js';
import { roundForToken } from '../utils/math.js';
import { acquireUserLock, releaseUserLock } from '../lib/locks.js';

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
    private store: IStore,
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
    // 1. Atomic claim — returns true iff this caller is the first to
    //    claim this on-chain txId. Backed by Redis SADD on RedisStore
    //    (atomic across Lambdas) and by the in-process Set on
    //    PersistentStore. The pre-fix `isTransactionProcessed()` check
    //    was per-Lambda only and caused the duplicate-deposit incident
    //    documented in `docs/incident-playbook.md` — two warm Vercel
    //    functions could each see "not processed" for the same tx and
    //    both credit + write HCS-20 ops.
    if (!(await this.store.tryClaimTransaction(txId))) {
      return this.getUserOrThrow(userId).balances;
    }

    // 2. Per-user lock — defends against the lost-update race where
    //    creditDeposit (deposit watcher, no lock pre-0.3.3) raced
    //    `processRefund` / `playForUser` / `processWithdrawal`
    //    (per-user lock) on the same `user.balances` object. Both
    //    paths read local cache, mutated locally, and `redis.set` was
    //    last-writer-wins — losing one of the updates. Now both sides
    //    serialise on the same lock key.
    //
    //    Backoff: ~6.85s total. Plays/withdrawals run 5-30s typically;
    //    if we can't acquire after the backoff window, release the tx
    //    claim and throw — the next pollDepositsOnce will retry.
    const backoffMs = [50, 100, 200, 500, 1000, 2000, 3000];
    let lockToken: string | null = null;
    for (const delay of [0, ...backoffMs]) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      lockToken = await acquireUserLock(userId, 30);
      if (lockToken) break;
    }
    if (!lockToken) {
      // Release the claim so a future poll can retry. The watcher's
      // dead-letter on the throw is the operator's signal.
      try {
        await this.store.releaseTransactionClaim(txId);
      } catch (releaseErr) {
        console.error(
          `[UserLedger] failed to release claim after lock contention for ${txId}:`,
          releaseErr,
        );
      }
      throw new Error(
        `creditDeposit: could not acquire lock for ${userId} after ` +
        `~6.85s backoff. Tx ${txId} deferred — will retry on next poll.`,
      );
    }

    // Track whether the deposit record has been persisted. After step 5
    // we hold partial state; releasing the tx claim then would risk a
    // double-credit on retry. Before step 5, releasing the claim lets
    // a retry recover.
    let recorded = false;
    try {
      // 3. Refresh local cache so we don't write a stale-overwrite on
      //    top of another Lambda's recent updates.
      await this.store.refreshUser(userId);

      // 4. Validate user exists (post-refresh — deregistration may
      //    have happened concurrently).
      const user = this.getUserOrThrow(userId);

      // Calculate rake split (rounded to token's decimal precision)
      const rakeAmount = roundForToken(grossAmount * (rakePercent / 100), token);
      const netAmount = roundForToken(grossAmount - rakeAmount, token);

      // Credit user balance
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

      // Credit operator (platform) rake
      this.store.updateOperator((op) => ({
        ...op,
        balances: { ...op.balances, [token]: (op.balances[token] ?? 0) + rakeAmount },
        totalRakeCollected: { ...op.totalRakeCollected, [token]: (op.totalRakeCollected[token] ?? 0) + rakeAmount },
      }));

      // 5. Persist deposit record
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
      recorded = true;

      // 6. Fire HCS-20 accounting (non-blocking)
      //
      // Pass the underlying token (HBAR / LAZY / token id) so the on-chain
      // record carries the asset identity. Without it, the audit reader
      // would have to fall back to a LLCRED→HBAR heuristic and lose all
      // LAZY deposits — see the v1 message types section in
      // docs/hcs20-v2-schema.md for the rationale.
      try {
        await this.accounting.recordDeposit(user.hederaAccountId, netAmount, txId, token);
      } catch (err) {
        console.warn(
          `[UserLedger] HCS-20 recordDeposit failed for user ${userId}, txId ${txId}:`,
          err,
        );
      }

      try {
        await this.accounting.recordRake(user.hederaAccountId, this.agentAccountId, rakeAmount, token);
      } catch (err) {
        console.warn(
          `[UserLedger] HCS-20 recordRake failed for user ${userId}, txId ${txId}:`,
          err,
        );
      }

      // 7. Flush BEFORE releasing the lock so the next acquirer reads
      //    a fully-consistent Redis state.
      await this.store.flush();

      return newBalances;
    } catch (err) {
      // Only roll back the claim if we threw BEFORE writing the deposit
      // record. After step 5 the partial state is the lesser evil — a
      // released claim could let another Lambda credit the same tx
      // again on top of our partial state.
      if (!recorded) {
        try {
          await this.store.releaseTransactionClaim(txId);
        } catch (releaseErr) {
          console.error(
            `[UserLedger] failed to release claim for ${txId} after credit error:`,
            releaseErr,
          );
        }
      }
      throw err;
    } finally {
      // Always release the user lock, even on throw.
      await releaseUserLock(userId, lockToken);
    }
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
    if (amount < 0) throw new Error(`reserve: amount must be non-negative, got ${amount}`);
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
    if (amountSpent < 0) throw new Error(`settleSpend: amount must be non-negative, got ${amountSpent}`);
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
    if (amount < 0) throw new Error(`releaseReserve: amount must be non-negative, got ${amount}`);
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
