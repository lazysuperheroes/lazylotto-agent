/**
 * RedisStore -- Upstash Redis-backed implementation of IStore.
 *
 * Design:
 *   - All reads are served from an in-memory cache (synchronous).
 *   - Mutations update the cache immediately, then write-through to Redis.
 *   - load() hydrates the full cache from Redis on startup / cold start.
 *   - flush() awaits all pending Redis writes.
 *
 * Redis key layout (prefix: lla:store:):
 *
 *   users:{userId}                   -> JSON UserAccount
 *   users:index:memo:{memo}          -> userId
 *   users:index:account:{accountId}  -> userId
 *   users:all                        -> SET of userIds
 *   operator                         -> JSON OperatorState
 *   deposits:{txId}                  -> JSON DepositRecord
 *   deposits:user:{userId}           -> LIST of deposit txIds
 *   deposits:processed               -> SET of processed txIds
 *   plays:{sessionId}                -> JSON PlaySessionResult
 *   plays:user:{userId}              -> LIST of session IDs
 *   withdrawals:{txId}               -> JSON WithdrawalRecord
 *   withdrawals:user:{userId}        -> LIST of withdrawal txIds
 *   deadletters                      -> LIST of JSON entries
 *   gas:{recordId}                   -> JSON GasRecord
 *   gas:user:{userId}                -> LIST of record IDs
 *   gas:all                          -> LIST of record IDs
 *   watermark                        -> string timestamp
 */

import { Redis } from '@upstash/redis';
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
import type { IStore, DeadLetterEntry } from './IStore.js';

// ── Constants ────────────────────────────────────────────────────

const NET = process.env.HEDERA_NETWORK ?? 'testnet';
const P = `lla:${NET}:store:`; // network-scoped key prefix
const MAX_RECORDS = 10_000;

// ── Helpers ──────────────────────────────────────────────────────

function k(...parts: string[]): string {
  return P + parts.join(':');
}

/** Generate a sortable unique id for records that lack one. */
function recordId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── RedisStore ───────────────────────────────────────────────────

export class RedisStore implements IStore {
  private redis: Redis;

  // In-memory cache (mirrors PersistentStore's fields exactly)
  private users = new Map<string, UserAccount>();
  private memoIndex = new Map<string, string>();
  private accountIdIndex = new Map<string, string>();
  private processedTxIds = new Set<string>();
  private operator: OperatorState = emptyOperatorState();
  private deposits: DepositRecord[] = [];
  private plays: PlaySessionResult[] = [];
  private withdrawals: WithdrawalRecord[] = [];
  private gasLog: GasRecord[] = [];
  private deadLetters: DeadLetterEntry[] = [];
  private watermarkTimestamp = '';

  // Pending write promises (for flush)
  private pending: Promise<unknown>[] = [];

  constructor(redis?: Redis) {
    this.redis = redis ?? new Redis({
      url: (process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL)!,
      token: (process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN)!,
    });
  }

  // ── Write-through helper ─────────────────────────────────────

  /** Fire a Redis write and track the promise so flush() can await it. */
  private fire(p: Promise<unknown>): void {
    this.pending.push(p);
    // Self-clean on completion to avoid unbounded growth
    p.then(
      () => { this.removePending(p); },
      (err) => { console.error('[RedisStore] background write error:', err); this.removePending(p); },
    );
  }

  private removePending(p: Promise<unknown>): void {
    const idx = this.pending.indexOf(p);
    if (idx !== -1) this.pending.splice(idx, 1);
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async load(): Promise<void> {
    // Clear in-memory caches before re-hydrating.
    // Without this, repeated load() calls (serverless getStore()) cause
    // duplicate records because loadListRecords appends to existing arrays.
    this.users.clear();
    this.memoIndex.clear();
    this.accountIdIndex.clear();
    this.deposits.length = 0;
    this.plays.length = 0;
    this.withdrawals.length = 0;
    this.gasLog.length = 0;
    this.deadLetters.length = 0;
    this.processedTxIds.clear();

    // 1. Load all user IDs from the set
    const userIds = await this.redis.smembers(k('users', 'all'));

    // 2. Bulk-load user objects
    if (userIds.length > 0) {
      const userKeys = userIds.map((id) => k('users', id));
      const pipeline = this.redis.pipeline();
      for (const key of userKeys) pipeline.get(key);
      const results = await pipeline.exec<(UserAccount | null)[]>();

      for (let i = 0; i < userIds.length; i++) {
        const user = results[i];
        if (!user) continue;
        // Upstash auto-deserializes JSON; ensure we have a proper object
        const account = (typeof user === 'string' ? JSON.parse(user) : user) as UserAccount;
        this.users.set(account.userId, account);
        this.memoIndex.set(account.depositMemo, account.userId);
        if (account.hederaAccountId) {
          this.accountIdIndex.set(account.hederaAccountId, account.userId);
        }
      }
    }

    // 3. Operator state
    const rawOp = await this.redis.get<OperatorState>(k('operator'));
    if (rawOp) {
      this.operator = (typeof rawOp === 'string' ? JSON.parse(rawOp) : rawOp) as OperatorState;

      // Migrate old flat format (same as PersistentStore)
      const opAny = this.operator as any;
      if (typeof opAny.platformBalance === 'number') {
        this.operator = {
          balances: { hbar: opAny.platformBalance },
          totalRakeCollected: { hbar: opAny.totalRakeCollected ?? 0 },
          totalGasSpent: opAny.totalGasSpent ?? 0,
          totalWithdrawnByOperator: { hbar: opAny.totalWithdrawnByOperator ?? 0 },
        };
        this.fire(this.redis.set(k('operator'), JSON.stringify(this.operator)));
      }
    }

    // 4. Processed tx IDs (set)
    const processed = await this.redis.smembers(k('deposits', 'processed'));
    this.processedTxIds = new Set(processed);

    // 5. Load deposits per user
    await this.loadListRecords<DepositRecord>(
      'deposits',
      this.deposits,
      userIds,
      (r) => r.transactionId,
    );

    // 6. Load play sessions per user
    await this.loadListRecords<PlaySessionResult>(
      'plays',
      this.plays,
      userIds,
      (r) => r.sessionId,
    );

    // 7. Load withdrawals per user
    await this.loadListRecords<WithdrawalRecord>(
      'withdrawals',
      this.withdrawals,
      userIds,
      (r) => r.transactionId,
    );

    // 8. Load gas records
    const allGasIds = await this.redis.lrange(k('gas', 'all'), 0, -1);
    if (allGasIds.length > 0) {
      const pipeline = this.redis.pipeline();
      for (const gid of allGasIds) pipeline.get(k('gas', gid));
      const results = await pipeline.exec<(GasRecord | null)[]>();
      for (const r of results) {
        if (!r) continue;
        const rec = (typeof r === 'string' ? JSON.parse(r) : r) as GasRecord;
        this.gasLog.push(rec);
      }
    }

    // 9. Dead letters
    const rawDL = await this.redis.lrange(k('deadletters'), 0, -1);
    this.deadLetters = rawDL.map((raw) =>
      (typeof raw === 'string' ? JSON.parse(raw) : raw) as DeadLetterEntry,
    );

    // 10. Watermark
    const wm = await this.redis.get<string>(k('watermark'));
    this.watermarkTimestamp = wm ?? '';

    // 11. Startup recovery: release orphaned reserved balances
    let recoveredAny = false;
    for (const user of this.users.values()) {
      if (!user.balances.tokens) {
        // Migrate old flat balances
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
      // Write recovered users back to Redis
      const pipeline = this.redis.pipeline();
      for (const user of this.users.values()) {
        pipeline.set(k('users', user.userId), JSON.stringify(user));
      }
      await pipeline.exec();
    }
  }

  /** Helper: load list-indexed records (deposits, plays, withdrawals) for all users. */
  private async loadListRecords<T>(
    prefix: string,
    target: T[],
    userIds: string[],
    getId: (r: T) => string,
  ): Promise<void> {
    // Also load records for 'system' userId (gas records use 'system')
    const allSources = [...userIds, 'system'];
    // Gather all record IDs across users
    const allRecordIds: string[] = [];

    // Batch fetch all user lists
    if (allSources.length > 0) {
      const pipeline = this.redis.pipeline();
      for (const uid of allSources) {
        pipeline.lrange(k(prefix, 'user', uid), 0, -1);
      }
      const listResults = await pipeline.exec<string[][]>();
      for (const ids of listResults) {
        if (ids && ids.length > 0) allRecordIds.push(...ids);
      }
    }

    // Deduplicate
    const uniqueIds = [...new Set(allRecordIds)];
    if (uniqueIds.length === 0) return;

    // Bulk fetch records
    const pipeline = this.redis.pipeline();
    for (const rid of uniqueIds) pipeline.get(k(prefix, rid));
    const results = await pipeline.exec<(T | null)[]>();

    for (const r of results) {
      if (!r) continue;
      const rec = (typeof r === 'string' ? JSON.parse(r) : r) as T;
      target.push(rec);
    }
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = [...this.pending];
    await Promise.allSettled(batch);
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

    // Write-through to Redis
    const pipeline = this.redis.pipeline();
    pipeline.set(k('users', user.userId), JSON.stringify(user));
    pipeline.sadd(k('users', 'all'), user.userId);
    pipeline.set(k('users', 'index', 'memo', user.depositMemo), user.userId);
    if (user.hederaAccountId) {
      pipeline.set(k('users', 'index', 'account', user.hederaAccountId), user.userId);
    }
    this.fire(pipeline.exec());
  }

  // ── Balances ─────────────────────────────────────────────────

  updateBalance(userId: string, updater: (b: UserBalances) => UserBalances): UserBalances {
    const user = this.users.get(userId);
    if (!user) throw new UserNotFoundError(userId);

    user.balances = updater(user.balances);

    // Write-through the user object
    this.fire(this.redis.set(k('users', user.userId), JSON.stringify(user)));
    return user.balances;
  }

  // ── Operator ─────────────────────────────────────────────────

  getOperator(): OperatorState {
    return this.operator;
  }

  updateOperator(updater: (s: OperatorState) => OperatorState): OperatorState {
    this.operator = updater(this.operator);
    this.fire(this.redis.set(k('operator'), JSON.stringify(this.operator)));
    return this.operator;
  }

  // ── Deposits ─────────────────────────────────────────────────

  isTransactionProcessed(txId: string): boolean {
    return this.processedTxIds.has(txId);
  }

  recordDeposit(record: DepositRecord): void {
    this.processedTxIds.add(record.transactionId);
    this.deposits.push(record);

    const pipeline = this.redis.pipeline();
    pipeline.set(k('deposits', record.transactionId), JSON.stringify(record));
    pipeline.sadd(k('deposits', 'processed'), record.transactionId);
    pipeline.rpush(k('deposits', 'user', record.userId), record.transactionId);
    this.fire(pipeline.exec());
  }

  getDepositsForUser(userId: string): DepositRecord[] {
    return this.deposits.filter((d) => d.userId === userId);
  }

  // ── Play sessions ────────────────────────────────────────────

  recordPlaySession(record: PlaySessionResult): void {
    this.plays.push(record);

    const pipeline = this.redis.pipeline();
    pipeline.set(k('plays', record.sessionId), JSON.stringify(record));
    pipeline.rpush(k('plays', 'user', record.userId), record.sessionId);
    this.fire(pipeline.exec());
  }

  getPlaySessionsForUser(userId: string): PlaySessionResult[] {
    return this.plays.filter((p) => p.userId === userId);
  }

  // ── Withdrawals ──────────────────────────────────────────────

  recordWithdrawal(record: WithdrawalRecord): void {
    this.withdrawals.push(record);

    const pipeline = this.redis.pipeline();
    pipeline.set(k('withdrawals', record.transactionId), JSON.stringify(record));
    pipeline.rpush(k('withdrawals', 'user', record.userId), record.transactionId);
    this.fire(pipeline.exec());
  }

  // ── Dead Letters ─────────────────────────────────────────────

  recordDeadLetter(entry: DeadLetterEntry): void {
    this.deadLetters.push(entry);
    this.fire(this.redis.rpush(k('deadletters'), JSON.stringify(entry)));
  }

  getDeadLetters(): DeadLetterEntry[] {
    return this.deadLetters;
  }

  // ── Gas ──────────────────────────────────────────────────────

  recordGas(record: GasRecord): void {
    this.gasLog.push(record);

    const rid = record.transactionId || recordId();
    const pipeline = this.redis.pipeline();
    pipeline.set(k('gas', rid), JSON.stringify(record));
    pipeline.rpush(k('gas', 'user', record.userId), rid);
    pipeline.rpush(k('gas', 'all'), rid);
    this.fire(pipeline.exec());
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
    this.fire(this.redis.set(k('watermark'), timestamp));
  }

  // ── Rotation ─────────────────────────────────────────────────

  /**
   * Trim in-memory arrays that exceed MAX_RECORDS.
   *
   * For Redis we only trim the in-memory cache; the Redis lists retain
   * the full history (Redis LIST LTRIM could be added later for cost
   * control, but the per-record keys are more important for lookups).
   */
  async rotateRecords(): Promise<void> {
    this.deposits = this.trimArray(this.deposits);
    this.plays = this.trimArray(this.plays);
    this.withdrawals = this.trimArray(this.withdrawals);
    this.gasLog = this.trimArray(this.gasLog);
    this.deadLetters = this.trimArray(this.deadLetters);
  }

  private trimArray<T>(arr: T[]): T[] {
    if (arr.length <= MAX_RECORDS) return arr;
    const keep = Math.floor(MAX_RECORDS / 2);
    return arr.slice(arr.length - keep);
  }
}
