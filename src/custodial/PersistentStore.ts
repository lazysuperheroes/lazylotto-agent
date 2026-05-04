import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
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
import { emptyOperatorState, UserNotFoundError, CURRENT_SCHEMA_VERSION } from './types.js';
import type { IStore, DeadLetterEntry } from './IStore.js';

// ── File names ───────────────────────────────────────────────────

const MAX_RECORDS = 10_000; // Rotate arrays when they exceed this size

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

async function atomicWriteAsync(filePath: string, data: unknown): Promise<void> {
  const tmp = filePath + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmp, filePath);
}

function readJsonSync<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  const raw = readFileSync(filePath, 'utf-8');
  if (!raw.trim()) return fallback; // empty file treated as new
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(
      `Corrupted data file: ${filePath}. ` +
        `Parse error: ${e instanceof Error ? e.message : e}. ` +
        `Investigate and fix the file, or delete it to reset (data will be lost).`
    );
  }
}

// ── PersistentStore ──────────────────────────────────────────────

export class PersistentStore implements IStore {
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
  private deadLetters: DeadLetterEntry[] = [];
  private watermarkTimestamp = '';

  // Dirty tracking
  private dirtyUsers = false;
  private dirtyOperator = false;
  private dirtyDeposits = false;
  private dirtyPlays = false;
  private dirtyWithdrawals = false;
  private dirtyGas = false;
  private dirtyDeadLetters = false;
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

    // Migrate old flat OperatorState to per-token format
    const opAny = this.operator as any;
    if (typeof opAny.platformBalance === 'number') {
      this.operator = {
        balances: { hbar: opAny.platformBalance },
        totalRakeCollected: { hbar: opAny.totalRakeCollected ?? 0 },
        totalGasSpent: opAny.totalGasSpent ?? 0,
        totalWithdrawnByOperator: { hbar: opAny.totalWithdrawnByOperator ?? 0 },
      };
      this.dirtyOperator = true;
    }

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

    // Dead letters
    this.deadLetters = readJsonSync<typeof this.deadLetters>(
      this.path('dead-letters.json'),
      [],
    );

    // Watermark
    const wm = readJsonSync<{ lastTimestamp: string }>(
      this.path(FILE_WATERMARK),
      { lastTimestamp: '' },
    );
    this.watermarkTimestamp = wm.lastTimestamp;

    // Startup recovery: move orphaned reserved balances back to available (per-token)
    let recoveredAny = false;
    for (const user of this.users.values()) {
      // Handle both old flat format and new per-token format
      if (!user.balances.tokens) {
        // Migrate old flat balances to per-token format
        const old = user.balances as unknown as {
          available?: number; reserved?: number;
          totalDeposited?: number; totalWithdrawn?: number; totalRake?: number;
        };
        user.balances = {
          tokens: {
            hbar: {
              available: (old.available ?? 0) + (old.reserved ?? 0),
              reserved: 0,
              totalDeposited: old.totalDeposited ?? 0,
              totalWithdrawn: old.totalWithdrawn ?? 0,
              totalRake: old.totalRake ?? 0,
            },
          },
        };
        recoveredAny = true;
      } else {
        for (const entry of Object.values(user.balances.tokens)) {
          if (entry.reserved > 0) {
            entry.available += entry.reserved;
            entry.reserved = 0;
            recoveredAny = true;
          }
        }
      }
    }
    if (recoveredAny) {
      this.dirtyUsers = true;
      await this.flush();
    }
  }

  private flushing = false;
  private flushPromise: Promise<void> | null = null;

  private anyDirty(): boolean {
    return this.dirtyUsers || this.dirtyOperator || this.dirtyDeposits ||
      this.dirtyPlays || this.dirtyWithdrawals || this.dirtyGas ||
      this.dirtyDeadLetters || this.dirtyWatermark;
  }

  async flush(): Promise<void> {
    // If a flush is in progress, wait for it then re-check for new dirty data
    if (this.flushing && this.flushPromise) {
      await this.flushPromise;
      // Mutations may have occurred during the in-progress flush — flush again if dirty
      if (this.anyDirty()) return this.flush();
      return;
    }
    this.flushing = true;
    this.cancelDebounce();

    this.flushPromise = this.doFlush();
    await this.flushPromise;
  }

  private async doFlush(): Promise<void> {
    try {
      // Rotate BEFORE snapshotting dirty flags so rotated data is
      // included in this write cycle (avoids an extra flush round-trip)
      await this.rotateRecords();

      const writes: Promise<void>[] = [];
      // Snapshot dirty flags BEFORE building writes
      const snap = {
        users: this.dirtyUsers,
        operator: this.dirtyOperator,
        deposits: this.dirtyDeposits,
        plays: this.dirtyPlays,
        deadLetters: this.dirtyDeadLetters,
        withdrawals: this.dirtyWithdrawals,
        gas: this.dirtyGas,
        watermark: this.dirtyWatermark,
      };

      if (snap.users) {
        const obj: Record<string, UserAccount> = {};
        for (const [id, user] of this.users) obj[id] = user;
        writes.push(atomicWriteAsync(this.path(FILE_USERS), obj));
      }
      if (snap.operator) writes.push(atomicWriteAsync(this.path(FILE_OPERATOR), this.operator));
      if (snap.deposits) writes.push(atomicWriteAsync(this.path(FILE_DEPOSITS), this.deposits));
      if (snap.plays) writes.push(atomicWriteAsync(this.path(FILE_PLAYS), this.plays));
      if (snap.deadLetters) writes.push(atomicWriteAsync(this.path('dead-letters.json'), this.deadLetters));
      if (snap.withdrawals) writes.push(atomicWriteAsync(this.path(FILE_WITHDRAWALS), this.withdrawals));
      if (snap.gas) writes.push(atomicWriteAsync(this.path(FILE_GAS_LOG), this.gasLog));
      if (snap.watermark) writes.push(atomicWriteAsync(this.path(FILE_WATERMARK), { lastTimestamp: this.watermarkTimestamp }));

      await Promise.all(writes);

      // Clear dirty flags AFTER writes complete — new mutations during write remain dirty
      if (snap.users) this.dirtyUsers = false;
      if (snap.operator) this.dirtyOperator = false;
      if (snap.deposits) this.dirtyDeposits = false;
      if (snap.plays) this.dirtyPlays = false;
      if (snap.deadLetters) this.dirtyDeadLetters = false;
      if (snap.withdrawals) this.dirtyWithdrawals = false;
      if (snap.gas) this.dirtyGas = false;
      if (snap.watermark) this.dirtyWatermark = false;
    } finally {
      this.flushing = false;
      this.flushPromise = null;
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  // ── Targeted refresh (no-ops for file store) ─────────────────
  // PersistentStore is single-process — once load() runs at startup,
  // the in-memory cache is authoritative. Mutations write through
  // immediately. So targeted refresh is a no-op.

  async refreshUser(_userId: string): Promise<void> {
    /* no-op */
  }

  async refreshPlaysForUser(_userId: string): Promise<void> {
    /* no-op */
  }

  async refreshOperator(): Promise<void> {
    /* no-op */
  }

  async refreshDeadLetters(): Promise<void> {
    /* no-op */
  }

  async refreshUserIndex(): Promise<void> {
    /* no-op */
  }

  async refreshDepositsForUser(_userId: string): Promise<void> {
    /* no-op */
  }

  async refreshWithdrawalsForUser(_userId: string): Promise<void> {
    /* no-op */
  }

  async refreshGasForUser(_userId: string): Promise<void> {
    /* no-op */
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
    // Stamp schema version so future readers know how to interpret the record
    user.schemaVersion = CURRENT_SCHEMA_VERSION;
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
    this.operator.schemaVersion = CURRENT_SCHEMA_VERSION;
    this.dirtyOperator = true;
    this.scheduleDirtyFlush();
    return this.operator;
  }

  // ── Deposits ─────────────────────────────────────────────────

  isTransactionProcessed(txId: string): boolean {
    return this.processedTxIds.has(txId);
  }

  /**
   * Single-process semantics: the in-memory set IS the source of truth.
   * Returns `true` iff this is the first call for this txId.
   */
  async tryClaimTransaction(txId: string): Promise<boolean> {
    if (this.processedTxIds.has(txId)) return false;
    this.processedTxIds.add(txId);
    return true;
  }

  async releaseTransactionClaim(txId: string): Promise<void> {
    this.processedTxIds.delete(txId);
  }

  /**
   * Single-process: in-memory Set IS the source of truth, so a hit is
   * the canonical answer. (RedisStore needs to consult Redis on a
   * local miss; we don't.)
   */
  async isDepositCredited(txId: string): Promise<boolean> {
    return this.processedTxIds.has(txId);
  }

  recordDeposit(record: DepositRecord): void {
    record.schemaVersion = CURRENT_SCHEMA_VERSION;
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
    record.schemaVersion = CURRENT_SCHEMA_VERSION;
    this.plays.push(record);
    this.dirtyPlays = true;
    this.scheduleDirtyFlush();
  }

  getPlaySessionsForUser(userId: string): PlaySessionResult[] {
    return this.plays.filter((p) => p.userId === userId);
  }

  // ── Withdrawals ──────────────────────────────────────────────

  recordWithdrawal(record: WithdrawalRecord): void {
    record.schemaVersion = CURRENT_SCHEMA_VERSION;
    this.withdrawals.push(record);
    this.dirtyWithdrawals = true;
    this.scheduleDirtyFlush();
  }

  // ── Dead Letters ─────────────────────────────────────────────

  /**
   * Genuine upsert keyed by `transactionId`. Single-process so the
   * in-memory array is the source of truth. Replaces an existing
   * entry with the same id (so resolution writes
   * `{...original, resolvedAt, ...}` and the unresolved row vanishes).
   */
  async upsertDeadLetter(entry: DeadLetterEntry): Promise<void> {
    if (!this.deadLetters) this.deadLetters = [];
    const idx = this.deadLetters.findIndex(
      (e) => e.transactionId === entry.transactionId,
    );
    if (idx >= 0) {
      this.deadLetters[idx] = entry;
    } else {
      this.deadLetters.push(entry);
    }
    this.dirtyDeadLetters = true;
    this.scheduleDirtyFlush();
  }

  getDeadLetters(): DeadLetterEntry[] {
    return this.deadLetters ?? [];
  }

  // ── Gas ──────────────────────────────────────────────────────

  recordGas(record: GasRecord): void {
    record.schemaVersion = CURRENT_SCHEMA_VERSION;
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

  // ── HCS-20 v2 agentSeq counter ───────────────────────────────
  //
  // Single-process: in-memory Map IS the source of truth. Not
  // persisted to disk — recomputed from mirror node on each process
  // boot via `AccountingService.initializeAgentSeq` (same behaviour
  // as the pre-fix in-process counter).

  private agentSeqs = new Map<string, number>();

  /** SETNX semantics: only seed if not already set. */
  async seedAgentSeq(agentAccountId: string, value: number): Promise<void> {
    if (!this.agentSeqs.has(agentAccountId)) {
      this.agentSeqs.set(agentAccountId, value);
    }
  }

  /** Atomic increment + return new value. Single-process is naturally atomic. */
  async nextAgentSeq(agentAccountId: string): Promise<number> {
    const next = (this.agentSeqs.get(agentAccountId) ?? -1) + 1;
    this.agentSeqs.set(agentAccountId, next);
    return next;
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

  /** Archive old records when an array exceeds MAX_RECORDS. Keeps the latest half. */
  private async rotateIfNeeded<T>(arr: T[], name: string): Promise<T[]> {
    if (arr.length <= MAX_RECORDS) return arr;
    const keep = Math.floor(MAX_RECORDS / 2);
    const archived = arr.slice(0, arr.length - keep);
    const archivePath = this.path(`${name}-archive-${Date.now()}.json`);
    try {
      await writeFile(archivePath, JSON.stringify(archived, null, 2), 'utf-8');
      console.log(`[PersistentStore] Archived ${archived.length} ${name} records to ${archivePath}`);
    } catch (e) {
      console.warn(`[PersistentStore] Failed to archive ${name}:`, e);
    }
    return arr.slice(arr.length - keep);
  }

  /** Run rotation check on all record arrays. Call periodically or on flush. */
  async rotateRecords(): Promise<void> {
    const dLen = this.deposits.length;
    this.deposits = await this.rotateIfNeeded(this.deposits, 'deposits');
    if (this.deposits.length !== dLen) this.dirtyDeposits = true;

    const pLen = this.plays.length;
    this.plays = await this.rotateIfNeeded(this.plays, 'plays');
    if (this.plays.length !== pLen) this.dirtyPlays = true;

    const wLen = this.withdrawals.length;
    this.withdrawals = await this.rotateIfNeeded(this.withdrawals, 'withdrawals');
    if (this.withdrawals.length !== wLen) this.dirtyWithdrawals = true;

    const gLen = this.gasLog.length;
    this.gasLog = await this.rotateIfNeeded(this.gasLog, 'gas-log');
    if (this.gasLog.length !== gLen) this.dirtyGas = true;

    const dlLen = this.deadLetters.length;
    this.deadLetters = await this.rotateIfNeeded(this.deadLetters, 'dead-letters');
    if (this.deadLetters.length !== dlLen) this.dirtyDeadLetters = true;
  }
}
