import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  UserAccount,
  UserBalances,
  OperatorState,
  DepositRecord,
  PlaySessionResult,
  WithdrawalRecord,
  GasRecord,
} from './types.js';
import { emptyOperatorState, UserNotFoundError } from './types.js';

// ── File names ───────────────────────────────────────────────────

const FILE_USERS = 'users.json';
const FILE_OPERATOR = 'operator.json';
const FILE_DEPOSITS = 'deposits.json';
const FILE_PLAYS = 'plays.json';
const FILE_WITHDRAWALS = 'withdrawals.json';
const FILE_GAS_LOG = 'gas-log.json';
const FILE_WATERMARK = 'watermark.json';

// ── Helpers ──────────────────────────────────────────────────────

function atomicWriteSync(filePath: string, data: unknown): void {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

function readJsonSync<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ── PersistentStore ──────────────────────────────────────────────

export class PersistentStore {
  private readonly dataDir: string;

  // In-memory collections
  private users: Map<string, UserAccount> = new Map();
  private memoIndex: Map<string, string> = new Map();
  private accountIdIndex: Map<string, string> = new Map();
  private processedTxIds: Set<string> = new Set();
  private operator: OperatorState = emptyOperatorState();
  private deposits: DepositRecord[] = [];
  private plays: PlaySessionResult[] = [];
  private withdrawals: WithdrawalRecord[] = [];
  private gasLog: GasRecord[] = [];
  private watermarkTimestamp = '';

  // Dirty tracking
  private dirtyUsers = false;
  private dirtyOperator = false;
  private dirtyDeposits = false;
  private dirtyPlays = false;
  private dirtyWithdrawals = false;
  private dirtyGas = false;
  private dirtyWatermark = false;

  // Debounce
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DEBOUNCE_MS = 500;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async load(): Promise<void> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    // Users
    const usersObj = readJsonSync<Record<string, UserAccount>>(
      this.path(FILE_USERS),
      {},
    );
    this.users = new Map(Object.entries(usersObj));

    // Rebuild indexes
    this.memoIndex.clear();
    this.accountIdIndex.clear();
    for (const user of this.users.values()) {
      this.memoIndex.set(user.depositMemo, user.userId);
      if (user.hederaAccountId) {
        this.accountIdIndex.set(user.hederaAccountId, user.userId);
      }
    }

    // Operator
    this.operator = readJsonSync<OperatorState>(
      this.path(FILE_OPERATOR),
      emptyOperatorState(),
    );

    // Deposits
    this.deposits = readJsonSync<DepositRecord[]>(this.path(FILE_DEPOSITS), []);
    this.processedTxIds = new Set(this.deposits.map((d) => d.transactionId));

    // Plays
    this.plays = readJsonSync<PlaySessionResult[]>(this.path(FILE_PLAYS), []);

    // Withdrawals
    this.withdrawals = readJsonSync<WithdrawalRecord[]>(
      this.path(FILE_WITHDRAWALS),
      [],
    );

    // Gas
    this.gasLog = readJsonSync<GasRecord[]>(this.path(FILE_GAS_LOG), []);

    // Watermark
    const wm = readJsonSync<{ lastTimestamp: string }>(
      this.path(FILE_WATERMARK),
      { lastTimestamp: '' },
    );
    this.watermarkTimestamp = wm.lastTimestamp;

    // Startup recovery: move orphaned reserved balances back to available
    let recoveredAny = false;
    for (const user of this.users.values()) {
      if (user.balances.reserved > 0) {
        user.balances.available += user.balances.reserved;
        user.balances.reserved = 0;
        recoveredAny = true;
      }
    }
    if (recoveredAny) {
      this.dirtyUsers = true;
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    this.cancelDebounce();

    if (this.dirtyUsers) {
      const obj: Record<string, UserAccount> = {};
      for (const [id, user] of this.users) {
        obj[id] = user;
      }
      atomicWriteSync(this.path(FILE_USERS), obj);
      this.dirtyUsers = false;
    }

    if (this.dirtyOperator) {
      atomicWriteSync(this.path(FILE_OPERATOR), this.operator);
      this.dirtyOperator = false;
    }

    if (this.dirtyDeposits) {
      atomicWriteSync(this.path(FILE_DEPOSITS), this.deposits);
      this.dirtyDeposits = false;
    }

    if (this.dirtyPlays) {
      atomicWriteSync(this.path(FILE_PLAYS), this.plays);
      this.dirtyPlays = false;
    }

    if (this.dirtyWithdrawals) {
      atomicWriteSync(this.path(FILE_WITHDRAWALS), this.withdrawals);
      this.dirtyWithdrawals = false;
    }

    if (this.dirtyGas) {
      atomicWriteSync(this.path(FILE_GAS_LOG), this.gasLog);
      this.dirtyGas = false;
    }

    if (this.dirtyWatermark) {
      atomicWriteSync(this.path(FILE_WATERMARK), {
        lastTimestamp: this.watermarkTimestamp,
      });
      this.dirtyWatermark = false;
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  // ── Users ────────────────────────────────────────────────────

  getUser(userId: string): UserAccount | undefined {
    return this.users.get(userId);
  }

  getUserByMemo(memo: string): UserAccount | undefined {
    const userId = this.memoIndex.get(memo);
    if (userId === undefined) return undefined;
    return this.users.get(userId);
  }

  getUserByAccountId(accountId: string): UserAccount | undefined {
    const userId = this.accountIdIndex.get(accountId);
    if (userId === undefined) return undefined;
    return this.users.get(userId);
  }

  getAllUsers(): UserAccount[] {
    return Array.from(this.users.values());
  }

  saveUser(user: UserAccount): void {
    this.users.set(user.userId, user);
    this.memoIndex.set(user.depositMemo, user.userId);
    if (user.hederaAccountId) {
      this.accountIdIndex.set(user.hederaAccountId, user.userId);
    }
    this.dirtyUsers = true;
    this.scheduleDirtyFlush();
  }

  // ── Balances ─────────────────────────────────────────────────

  updateBalance(
    userId: string,
    updater: (b: UserBalances) => UserBalances,
  ): UserBalances {
    const user = this.users.get(userId);
    if (!user) throw new UserNotFoundError(userId);

    user.balances = updater(user.balances);
    this.dirtyUsers = true;
    this.scheduleDirtyFlush();
    return user.balances;
  }

  // ── Operator ─────────────────────────────────────────────────

  getOperator(): OperatorState {
    return this.operator;
  }

  updateOperator(
    updater: (s: OperatorState) => OperatorState,
  ): OperatorState {
    this.operator = updater(this.operator);
    this.dirtyOperator = true;
    this.scheduleDirtyFlush();
    return this.operator;
  }

  // ── Deposits ─────────────────────────────────────────────────

  isTransactionProcessed(txId: string): boolean {
    return this.processedTxIds.has(txId);
  }

  recordDeposit(record: DepositRecord): void {
    this.processedTxIds.add(record.transactionId);
    this.deposits.push(record);
    this.dirtyDeposits = true;
    this.scheduleDirtyFlush();
  }

  getDepositsForUser(userId: string): DepositRecord[] {
    return this.deposits.filter((d) => d.userId === userId);
  }

  // ── Play sessions ────────────────────────────────────────────

  recordPlaySession(record: PlaySessionResult): void {
    this.plays.push(record);
    this.dirtyPlays = true;
    this.scheduleDirtyFlush();
  }

  getPlaySessionsForUser(userId: string): PlaySessionResult[] {
    return this.plays.filter((p) => p.userId === userId);
  }

  // ── Withdrawals ──────────────────────────────────────────────

  recordWithdrawal(record: WithdrawalRecord): void {
    this.withdrawals.push(record);
    this.dirtyWithdrawals = true;
    this.scheduleDirtyFlush();
  }

  // ── Gas ──────────────────────────────────────────────────────

  recordGas(record: GasRecord): void {
    this.gasLog.push(record);
    this.dirtyGas = true;
    this.scheduleDirtyFlush();
  }

  getGasForUser(userId: string): GasRecord[] {
    return this.gasLog.filter((g) => g.userId === userId);
  }

  getAllGasRecords(): GasRecord[] {
    return this.gasLog;
  }

  // ── Watermark ────────────────────────────────────────────────

  getWatermark(): string {
    return this.watermarkTimestamp;
  }

  setWatermark(timestamp: string): void {
    this.watermarkTimestamp = timestamp;
    this.dirtyWatermark = true;
    this.scheduleDirtyFlush();
  }

  // ── Private helpers ──────────────────────────────────────────

  private path(file: string): string {
    return join(this.dataDir, file);
  }

  private scheduleDirtyFlush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, PersistentStore.DEBOUNCE_MS);
  }

  private cancelDebounce(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
