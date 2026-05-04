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
  /**
   * Soft check — reads the in-memory cache only. Used by the deposit
   * watcher's pre-loop short-circuit and by the refund flow to verify a
   * txId came in via the deposit path. NOT safe for cross-Lambda
   * dedup: warm Vercel functions hold independent caches.
   *
   * For first-claim semantics in the credit path, use
   * `tryClaimTransaction` instead.
   */
  isTransactionProcessed(txId: string): boolean;

  /**
   * Atomically claim a transaction id. Returns `true` iff this caller is
   * the first to claim it across ALL store instances (Lambdas, processes).
   * Subsequent calls for the same txId return `false` until either the
   * claim is released (`releaseTransactionClaim`) or the underlying set
   * is rebuilt by `load()`.
   *
   * Backed by Redis `SADD` (atomic) on `RedisStore`; by the in-process
   * `Set` on `PersistentStore` (which is single-process so the local set
   * IS the source of truth).
   */
  tryClaimTransaction(txId: string): Promise<boolean>;

  /**
   * Release a previously-acquired claim. Called from `creditDeposit`'s
   * catch path when a credit fails BEFORE the deposit record is written,
   * so the next poll can retry the same txId. After `recordDeposit` has
   * written the deposit row, do NOT release — the partial state is the
   * lesser evil compared to a possible double-credit on retry.
   */
  releaseTransactionClaim(txId: string): Promise<void>;

  /**
   * Hard cross-Lambda check: was this txId credited as a user deposit?
   * Unlike `isTransactionProcessed` (which reads only the in-process
   * cache), this consults Redis directly via `SISMEMBER` so a Lambda
   * with a stale local cache still gets the correct answer. Use this
   * in any path where correctness across Lambda instances matters
   * (e.g. refund eligibility check). The local-cache `isTransactionProcessed`
   * remains useful as a soft optimisation (the deposit watcher's
   * pre-loop short-circuit) where a false-negative just costs an extra
   * trip through the credit path that's then short-circuited by
   * `tryClaimTransaction`.
   */
  isDepositCredited(txId: string): Promise<boolean>;

  recordDeposit(record: DepositRecord): void;
  getDepositsForUser(userId: string): DepositRecord[];

  // ── Play sessions ──────────────────────────────────────────────
  recordPlaySession(record: PlaySessionResult): void;
  getPlaySessionsForUser(userId: string): PlaySessionResult[];

  // ── Withdrawals ────────────────────────────────────────────────
  recordWithdrawal(record: WithdrawalRecord): void;

  // ── Dead letters ───────────────────────────────────────────────
  /**
   * Upsert a dead-letter entry keyed by `transactionId`. If an entry
   * with the same `transactionId` already exists it is REPLACED, not
   * appended — so the resolution path can write `{ ...original,
   * resolvedAt, resolvedBy, resolutionTxId }` and have the original
   * unresolved row vanish atomically.
   *
   * Async because the Redis implementation needs an awaited
   * pipeline (per-id SET + index LREM-then-RPUSH) so the index list
   * stays consistent after replacement.
   */
  upsertDeadLetter(entry: DeadLetterEntry): Promise<void>;

  /**
   * @deprecated Use `upsertDeadLetter` instead. Retained as a
   * fire-and-forget shim during the migration window so callsites
   * that haven't been updated still compile. Removed in the same
   * commit that migrates the last caller.
   */
  recordDeadLetter(entry: DeadLetterEntry): void;

  getDeadLetters(): DeadLetterEntry[];

  // ── Gas ────────────────────────────────────────────────────────
  recordGas(record: GasRecord): void;
  getGasForUser(userId: string): GasRecord[];
  getAllGasRecords(): GasRecord[];

  // ── Watermark ──────────────────────────────────────────────────
  getWatermark(): string;
  setWatermark(timestamp: string): void;

  // ── HCS-20 v2 agentSeq counter ─────────────────────────────────
  /**
   * Seed the per-agent monotonic sequence counter, idempotently.
   * Backed by Redis `SETNX` on `RedisStore` so two cold Lambdas can
   * both run their mirror-node scans concurrently and call this with
   * (potentially different) seeded values; whichever Lambda wins SETNX
   * sets the canonical baseline, and both then `nextAgentSeq` against
   * the shared counter via INCR.
   *
   * `value` is the LAST-SEEN agentSeq from the mirror scan; the next
   * `nextAgentSeq` call returns `value + 1`. Pass `-1` for an empty
   * topic so the first emitted seq is `0`.
   */
  seedAgentSeq(agentAccountId: string, value: number): Promise<void>;

  /**
   * Atomically increment the per-agent counter and return the new
   * value (post-increment). Each call returns a unique sequence
   * number across ALL store instances. RedisStore implements via
   * `INCR`; PersistentStore via in-memory `Map` (single-process).
   *
   * Caller MUST have already invoked `seedAgentSeq` for this
   * `agentAccountId` (or relied on `AccountingService.initializeAgentSeq`
   * to do so), otherwise the counter starts at 1 instead of the
   * mirror-recovered baseline + 1.
   */
  nextAgentSeq(agentAccountId: string): Promise<number>;

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
