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
  transactionId: string;
  timestamp: string;
  error: string;
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
}
