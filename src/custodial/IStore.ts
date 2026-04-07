/**
 * IStore -- abstract interface for the custodial persistent store.
 *
 * Two implementations:
 *   - PersistentStore  (JSON files on disk, original)
 *   - RedisStore        (Upstash Redis, for Vercel serverless)
 *
 * All read methods are synchronous (served from an in-memory cache).
 * Mutations update the cache immediately and persist asynchronously.
 */

import type {
  UserAccount,
  UserBalances,
  OperatorState,
  DepositRecord,
  PlaySessionResult,
  WithdrawalRecord,
  GasRecord,
} from './types.js';

export type DeadLetterEntry = {
  /**
   * Stable ID for this entry. For `deposit_failed` (the default,
   * legacy shape), this is the on-chain transaction ID of the failed
   * deposit. For `prize_transfer_failed`, this is the play session ID
   * — there's no tx ID for a transfer that never succeeded.
   */
  transactionId: string;
  timestamp: string;
  error: string;
  /** Sender account ID extracted from the transaction (if known). */
  sender?: string;
  /** Memo from the deposit (if any). Used for refund-by-sender filtering. */
  memo?: string;
  /**
   * Discriminant for the failure type. Defaults to `deposit_failed`
   * for legacy entries that don't carry the field. Used by the admin
   * dashboard to render the right action affordance (refund vs.
   * recover prizes) and by the recovery tool to find affected
   * sessions.
   */
  kind?: 'deposit_failed' | 'prize_transfer_failed';
  /**
   * Free-form details specific to the failure kind. For prize
   * transfer failures, this carries the userId, sessionId, prize
   * totals, and the retry attempts log so the operator can decide
   * whether to retry, escalate, or refund.
   */
  details?: {
    userId?: string;
    sessionId?: string;
    prizesByToken?: Record<string, number>;
    prizeCount?: number;
    attemptsLog?: { attempt: number; gas: number; error?: string }[];
    [key: string]: unknown;
  };
  /**
   * Resolution markers set by the recovery tool when an operator
   * processes the dead letter. Once `resolvedAt` is non-null the
   * admin badge skips this entry (still queryable for the audit
   * trail, just not "open").
   */
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionTxId?: string;
};

export interface IStore {
  // ── Lifecycle ──────────────────────────────────────────────────
  /** Hydrate in-memory cache from the backing store. */
  load(): Promise<void>;
  /** Persist all pending mutations to the backing store. */
  flush(): Promise<void>;
  /** Flush and release resources. */
  close(): Promise<void>;

  // ── Users ──────────────────────────────────────────────────────
  getUser(userId: string): UserAccount | undefined;
  getUserByMemo(memo: string): UserAccount | undefined;
  getUserByAccountId(accountId: string): UserAccount | undefined;
  getAllUsers(): UserAccount[];
  saveUser(user: UserAccount): void;

  // ── Balances ───────────────────────────────────────────────────
  updateBalance(userId: string, updater: (b: UserBalances) => UserBalances): UserBalances;

  // ── Operator ───────────────────────────────────────────────────
  getOperator(): OperatorState;
  updateOperator(updater: (s: OperatorState) => OperatorState): OperatorState;

  // ── Deposits ───────────────────────────────────────────────────
  isTransactionProcessed(txId: string): boolean;
  recordDeposit(record: DepositRecord): void;
  getDepositsForUser(userId: string): DepositRecord[];

  // ── Play sessions ──────────────────────────────────────────────
  recordPlaySession(record: PlaySessionResult): void;
  getPlaySessionsForUser(userId: string): PlaySessionResult[];

  // ── Withdrawals ────────────────────────────────────────────────
  recordWithdrawal(record: WithdrawalRecord): void;

  // ── Dead letters ───────────────────────────────────────────────
  recordDeadLetter(entry: DeadLetterEntry): void;
  getDeadLetters(): DeadLetterEntry[];

  // ── Gas ────────────────────────────────────────────────────────
  recordGas(record: GasRecord): void;
  getGasForUser(userId: string): GasRecord[];
  getAllGasRecords(): GasRecord[];

  // ── Watermark ──────────────────────────────────────────────────
  getWatermark(): string;
  setWatermark(timestamp: string): void;

  // ── Rotation ───────────────────────────────────────────────────
  rotateRecords(): Promise<void>;

  // ── Targeted refresh (serverless) ─────────────────────────────
  // Cheap refresh methods for API routes that only need part of the
  // store to be up-to-date. Avoids the full ~8-12 round trip load().
  // Default implementation can delegate to load() if a backend can't
  // refresh partially.

  /** Reload one user's record from the backing store. */
  refreshUser(userId: string): Promise<void>;

  /** Reload the plays list for one user. */
  refreshPlaysForUser(userId: string): Promise<void>;

  /** Reload the operator state. */
  refreshOperator(): Promise<void>;

  /** Reload the dead letter queue. */
  refreshDeadLetters(): Promise<void>;

  /** Reload the full user list (indexes only, not records). */
  refreshUserIndex(): Promise<void>;

  /** Reload the deposit list for one user. */
  refreshDepositsForUser(userId: string): Promise<void>;

  /** Reload the withdrawal list for one user. */
  refreshWithdrawalsForUser(userId: string): Promise<void>;

  /** Reload the gas log for one user (or 'system' for untagged entries). */
  refreshGasForUser(userId: string): Promise<void>;
}
