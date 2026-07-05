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
import { CURRENT_SCHEMA_VERSION } from './types.js';
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
  // R5-FG-109 (P11-015): per-user index Maps so getDepositsForUser /
  // getPlaySessionsForUser are O(records-for-user) instead of
  // O(all-records). Pre-fix the .filter() walked every record on
  // every call; at 10K records × 100 calls/sec that's 1M comparisons.
  // The Maps are populated lazily on first lookup and kept in sync
  // with `recordDeposit` / `recordPlay` writes. Stale entries
  // (records dropped via rotateRecords) are tolerated since the
  // backing array is the source of truth.
  private depositsByUser: Map<string, DepositRecord[]> | null = null;
  private playsByUser: Map<string, PlaySessionResult[]> | null = null;

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

    // 0.3.3 hardening: defense-in-depth try/catch. Today's call path
    // through `createStore()` discards the instance on a rejected
    // load() so a partial hydrate state isn't reachable, but if a
    // future code path ever calls `load()` on an existing instance
    // (e.g. a manual reload after a Redis flap), a partial failure
    // mid-fetch would leave a half-populated cache that returns
    // inconsistent answers (`getOperator()` empty while users[X]
    // is hydrated, etc). Re-clear on failure so the instance state
    // is post-failure DEFINITELY empty rather than half-populated.
    try {
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
    // R5-FG-42 (P11-006): paginate to avoid Upstash 4MB body cap
    // when the topic has accumulated tens of thousands of orphan
    // rows. Pre-fix `lrange(0, -1)` returned the entire list in one
    // call → 413 cold-start failure at 5K × 800B. Read only the
    // most recent MAX_RECORDS entries (LIST is RPUSH-ordered so the
    // tail is newest); paginate in pages of 1000 to stay under the
    // 4MB cap. Older rows beyond the cap remain in Redis but are
    // not held in memory; verify-audit's `--store-snapshot` mode
    // (R5-FG-44) reads orphan history from a separate path.
    const PAGE_SIZE = 1000;
    const totalLen = await this.redis.llen(k('deadletters')).catch(() => 0);
    const startIdx = Math.max(0, totalLen - MAX_RECORDS);
    this.deadLetters = [];
    for (let pageStart = startIdx; pageStart < totalLen; pageStart += PAGE_SIZE) {
      const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, totalLen - 1);
      const rawDL = await this.redis.lrange(k('deadletters'), pageStart, pageEnd);
      for (const raw of rawDL) {
        try {
          this.deadLetters.push(
            (typeof raw === 'string' ? JSON.parse(raw) : raw) as DeadLetterEntry,
          );
        } catch {
          /* skip malformed row */
        }
      }
    }

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
    } catch (err) {
      // Re-clear caches on partial failure so the post-failure state
      // is definitely empty rather than half-populated. Caller's load()
      // promise rejects; createStore() discards the instance; next
      // getStore() will retry from scratch.
      this.users.clear();
      this.memoIndex.clear();
      this.accountIdIndex.clear();
      this.deposits.length = 0;
      this.plays.length = 0;
      this.withdrawals.length = 0;
      this.gasLog.length = 0;
      this.deadLetters.length = 0;
      this.processedTxIds.clear();
      this.operator = emptyOperatorState();
      this.watermarkTimestamp = '';
      throw err;
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

  // ── Targeted refresh (serverless) ────────────────────────────
  // Only re-fetch what an API route actually needs. Much cheaper than
  // full load() on every getStore() call — typically 1-2 Redis round
  // trips instead of 8-12.

  async refreshUser(userId: string): Promise<void> {
    const raw = await this.redis.get<UserAccount>(k('users', userId));
    if (!raw) return;
    const account = (typeof raw === 'string' ? JSON.parse(raw) : raw) as UserAccount;
    // Update all three indexes
    this.users.set(account.userId, account);
    this.memoIndex.set(account.depositMemo, account.userId);
    if (account.hederaAccountId) {
      this.accountIdIndex.set(account.hederaAccountId, account.userId);
    }
  }

  async refreshPlaysForUser(userId: string): Promise<void> {
    await this.refreshListForUser(
      'plays',
      this.plays,
      userId,
      (r) => r.userId,
    );
  }

  async refreshOperator(): Promise<void> {
    const raw = await this.redis.get<OperatorState>(k('operator'));
    if (raw) {
      this.operator = (typeof raw === 'string' ? JSON.parse(raw) : raw) as OperatorState;
    }
  }

  async refreshDeadLetters(): Promise<void> {
    // R5-FG-42 (P11-006): paginate so a 50K-row deadletters list
    // doesn't exceed the Upstash 4MB body cap. See `load()` for the
    // same pattern.
    const PAGE_SIZE = 1000;
    const totalLen = await this.redis.llen(k('deadletters')).catch(() => 0);
    const startIdx = Math.max(0, totalLen - MAX_RECORDS);
    this.deadLetters = [];
    for (let pageStart = startIdx; pageStart < totalLen; pageStart += PAGE_SIZE) {
      const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, totalLen - 1);
      const rawDL = await this.redis.lrange(k('deadletters'), pageStart, pageEnd);
      for (const raw of rawDL) {
        try {
          this.deadLetters.push(
            (typeof raw === 'string' ? JSON.parse(raw) : raw) as DeadLetterEntry,
          );
        } catch {
          /* skip malformed row */
        }
      }
    }
  }

  async refreshUserIndex(): Promise<void> {
    const userIds = await this.redis.smembers(k('users', 'all'));
    if (userIds.length === 0) return;

    const pipeline = this.redis.pipeline();
    for (const id of userIds) pipeline.get(k('users', id));
    const results = await pipeline.exec<(UserAccount | null)[]>();

    this.users.clear();
    this.memoIndex.clear();
    this.accountIdIndex.clear();

    for (let i = 0; i < userIds.length; i++) {
      const user = results[i];
      if (!user) continue;
      const account = (typeof user === 'string' ? JSON.parse(user) : user) as UserAccount;
      this.users.set(account.userId, account);
      this.memoIndex.set(account.depositMemo, account.userId);
      if (account.hederaAccountId) {
        this.accountIdIndex.set(account.hederaAccountId, account.userId);
      }
    }
  }

  /**
   * Generic helper: refresh an array of records for one user.
   * Drops stale entries for the user, re-fetches from Redis.
   */
  private async refreshListForUser<T>(
    prefix: string,
    target: T[],
    userId: string,
    filterUserId: (rec: T) => string,
  ): Promise<void> {
    const ids = await this.redis.lrange(k(prefix, 'user', userId), 0, -1);
    if (ids.length === 0) {
      // Drop cached records for this user
      for (let i = target.length - 1; i >= 0; i--) {
        if (filterUserId(target[i]!) === userId) target.splice(i, 1);
      }
      return;
    }

    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.get(k(prefix, id));
    const results = await pipeline.exec<(T | null)[]>();

    // Drop stale, then add fresh
    for (let i = target.length - 1; i >= 0; i--) {
      if (filterUserId(target[i]!) === userId) target.splice(i, 1);
    }
    for (const r of results) {
      if (!r) continue;
      const rec = (typeof r === 'string' ? JSON.parse(r) : r) as T;
      target.push(rec);
    }
  }

  async refreshDepositsForUser(userId: string): Promise<void> {
    await this.refreshListForUser(
      'deposits',
      this.deposits,
      userId,
      (r) => r.userId,
    );
  }

  async refreshWithdrawalsForUser(userId: string): Promise<void> {
    await this.refreshListForUser(
      'withdrawals',
      this.withdrawals,
      userId,
      (r) => r.userId,
    );
  }

  async refreshGasForUser(userId: string): Promise<void> {
    await this.refreshListForUser(
      'gas',
      this.gasLog,
      userId,
      (r) => r.userId,
    );
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
    // Stamp the schema version on every write so future reads know how to
    // interpret the record. Legacy (unversioned) records remain readable.
    user.schemaVersion = CURRENT_SCHEMA_VERSION;
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
    this.operator.schemaVersion = CURRENT_SCHEMA_VERSION;
    this.fire(this.redis.set(k('operator'), JSON.stringify(this.operator)));
    return this.operator;
  }

  // ── Deposits ─────────────────────────────────────────────────

  isTransactionProcessed(txId: string): boolean {
    return this.processedTxIds.has(txId);
  }

  /**
   * Atomic claim via Redis `SADD`. Returns `true` iff the txId was
   * newly added — i.e. this caller is the first to claim it across all
   * Lambdas. Local fast-path: if our in-memory set already has it, we
   * know SADD would return 0, so skip the round-trip.
   */
  async tryClaimTransaction(txId: string): Promise<boolean> {
    if (this.processedTxIds.has(txId)) return false;
    const added = await this.redis.sadd(k('deposits', 'processed'), txId);
    if (added === 1) this.processedTxIds.add(txId);
    return added === 1;
  }

  async releaseTransactionClaim(txId: string): Promise<void> {
    this.processedTxIds.delete(txId);
    await this.redis.srem(k('deposits', 'processed'), txId);
  }

  /**
   * Hard cross-Lambda check via Redis `SISMEMBER`. Local fast-path: if
   * we already know it locally, return true without hitting Redis. On
   * a local miss we MUST consult Redis — another Lambda may have
   * claimed/recorded the deposit and our cache is stale.
   */
  async isDepositCredited(txId: string): Promise<boolean> {
    if (this.processedTxIds.has(txId)) return true;
    const present = await this.redis.sismember(k('deposits', 'processed'), txId);
    if (present === 1) {
      this.processedTxIds.add(txId); // backfill local cache
      return true;
    }
    return false;
  }

  recordDeposit(record: DepositRecord): void {
    record.schemaVersion = CURRENT_SCHEMA_VERSION;
    this.processedTxIds.add(record.transactionId);
    this.deposits.push(record);
    // R5-FG-109: invalidate the per-user index so the next call
    // rebuilds with the new record. Cheap — Map.set is O(1).
    if (this.depositsByUser) {
      const arr = this.depositsByUser.get(record.userId);
      if (arr) arr.push(record);
      else this.depositsByUser.set(record.userId, [record]);
    }
    // R4-FG-21 (round-4 high): enforce in-memory MAX_RECORDS so warm
    // Lambdas don't accumulate 6+ months of writes (~120MB+ for plays
    // alone) and trip Upstash 4MB request-body limit on cold-start
    // pipelined GETs. Pre-fix the constant was declared and never
    // read; arrays grew unbounded. Drop oldest from the front when
    // over the cap.
    if (this.deposits.length > MAX_RECORDS) {
      this.deposits.splice(0, this.deposits.length - MAX_RECORDS);
      // Map can drift slightly past MAX_RECORDS (we don't proactively
      // remove the oldest from the per-user index), but `getAll` is
      // the source of truth and the slack is bounded by call frequency.
      this.depositsByUser = null; // trigger rebuild on next access
    }

    const pipeline = this.redis.pipeline();
    pipeline.set(k('deposits', record.transactionId), JSON.stringify(record));
    pipeline.sadd(k('deposits', 'processed'), record.transactionId);
    pipeline.rpush(k('deposits', 'user', record.userId), record.transactionId);
    this.fire(pipeline.exec());
  }

  getDepositsForUser(userId: string): DepositRecord[] {
    // R5-FG-109: lazy-build the per-user index on first access.
    if (!this.depositsByUser) {
      this.depositsByUser = new Map();
      for (const d of this.deposits) {
        const arr = this.depositsByUser.get(d.userId);
        if (arr) arr.push(d);
        else this.depositsByUser.set(d.userId, [d]);
      }
    }
    return this.depositsByUser.get(userId) ?? [];
  }

  /**
   * Cross-Lambda deposit lookup. Returns the local-cache entry first
   * (warm path); on miss, hits Redis directly so a Lambda whose local
   * cache hasn't yet seen another Lambda's recent `recordDeposit`
   * still gets the right answer.
   */
  async getDepositByTxId(txId: string): Promise<DepositRecord | undefined> {
    const local = this.deposits.find((d) => d.transactionId === txId);
    if (local) return local;
    const raw = await this.redis.get<string | object>(k('deposits', txId));
    if (raw == null) return undefined;
    const parsed: DepositRecord =
      typeof raw === 'string' ? JSON.parse(raw) : (raw as DepositRecord);
    // Backfill the local cache so subsequent lookups stay warm.
    if (!this.deposits.some((d) => d.transactionId === txId)) {
      this.deposits.push(parsed);
    }
    return parsed;
  }

  // ── Play sessions ────────────────────────────────────────────

  recordPlaySession(record: PlaySessionResult): void {
    record.schemaVersion = CURRENT_SCHEMA_VERSION;
    this.plays.push(record);
    // R5-FG-109: keep per-user index in sync.
    if (this.playsByUser) {
      const arr = this.playsByUser.get(record.userId);
      if (arr) arr.push(record);
      else this.playsByUser.set(record.userId, [record]);
    }
    if (this.plays.length > MAX_RECORDS) {
      this.plays.splice(0, this.plays.length - MAX_RECORDS);
      this.playsByUser = null; // trigger rebuild on next access
    }

    const pipeline = this.redis.pipeline();
    pipeline.set(k('plays', record.sessionId), JSON.stringify(record));
    pipeline.rpush(k('plays', 'user', record.userId), record.sessionId);
    this.fire(pipeline.exec());
  }

  getPlaySessionsForUser(userId: string): PlaySessionResult[] {
    // R5-FG-109: lazy-build the per-user index on first access.
    if (!this.playsByUser) {
      this.playsByUser = new Map();
      for (const p of this.plays) {
        const arr = this.playsByUser.get(p.userId);
        if (arr) arr.push(p);
        else this.playsByUser.set(p.userId, [p]);
      }
    }
    return this.playsByUser.get(userId) ?? [];
  }

  // ── Withdrawals ──────────────────────────────────────────────

  recordWithdrawal(record: WithdrawalRecord): void {
    record.schemaVersion = CURRENT_SCHEMA_VERSION;
    this.withdrawals.push(record);
    if (this.withdrawals.length > MAX_RECORDS) {
      this.withdrawals.splice(0, this.withdrawals.length - MAX_RECORDS);
    }

    const pipeline = this.redis.pipeline();
    pipeline.set(k('withdrawals', record.transactionId), JSON.stringify(record));
    pipeline.rpush(k('withdrawals', 'user', record.userId), record.transactionId);
    this.fire(pipeline.exec());
  }

  // ── Dead Letters ─────────────────────────────────────────────

  /**
   * Upsert a dead-letter entry keyed by `transactionId`. Replaces an
   * existing entry with the same id (so the resolution path can write
   * `{...original, resolvedAt, resolvedBy, resolutionTxId}` and have
   * the unresolved row vanish).
   *
   * Storage:
   *   - `deadletters` LIST holds JSON entries in insertion order
   *     (unchanged on-the-wire from the previous shape, so `load()`
   *     keeps working).
   *   - `deadletters:by_id:{txId}` per-id key holds the latest JSON
   *     for fast LREM-by-content on subsequent upserts.
   *
   * Concurrency: cross-Lambda concurrent upserts for the SAME txId
   * are NOT atomic without an external lock — both could race the
   * GET-then-LREM-then-RPUSH and produce a duplicated entry. The
   * resolution call site (`recoverStuckPrizesForUser`) is gated by a
   * per-user Redis lock, which is the architectural answer. New-entry
   * writes (deposit watcher failure paths) don't conflict on txId
   * because deposit dedup via `tryClaimTransaction` upstream
   * guarantees only one Lambda writes a given dead-letter.
   */
  async upsertDeadLetter(entry: DeadLetterEntry): Promise<void> {
    // In-memory: replace by transactionId, otherwise append
    const idx = this.deadLetters.findIndex(
      (e) => e.transactionId === entry.transactionId,
    );
    if (idx >= 0) {
      this.deadLetters[idx] = entry;
    } else {
      this.deadLetters.push(entry);
    }
    // R5-FG-42 (P11-006): trim past MAX_RECORDS so audit-orphan +
    // uncertainTx + prize-transfer DLs can't accumulate unbounded.
    // Pre-fix worst-case cold-start LRANGE 0 -1 against 50K × 800B
    // exceeded the Upstash 4MB body cap → 413 cold-start failure.
    // The other record types already trimmed in-memory; deadLetters
    // was the asymmetric miss.
    if (this.deadLetters.length > MAX_RECORDS) {
      this.deadLetters.splice(0, this.deadLetters.length - MAX_RECORDS);
    }

    const newJson = JSON.stringify(entry);
    const byIdKey = k('deadletters', 'by_id', entry.transactionId);

    // Lookup the previous JSON via the by_id pointer, falling back to a
    // LIST scan for the migration window (entries written before
    // upsertDeadLetter shipped have no by_id key yet).
    let oldJson: string | null = await this.redis.get<string>(byIdKey);
    if (!oldJson) {
      const all = await this.redis.lrange(k('deadletters'), 0, -1);
      for (const raw of all) {
        try {
          const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as DeadLetterEntry;
          if (parsed.transactionId === entry.transactionId) {
            oldJson = typeof raw === 'string' ? raw : JSON.stringify(raw);
            break;
          }
        } catch {
          /* skip malformed row */
        }
      }
    }

    const pipeline = this.redis.pipeline();
    if (oldJson) {
      // LREM count=1 removes the first matching element
      pipeline.lrem(k('deadletters'), 1, oldJson);
    }
    pipeline.rpush(k('deadletters'), newJson);
    pipeline.set(byIdKey, newJson);
    await pipeline.exec();
  }

  getDeadLetters(): DeadLetterEntry[] {
    return this.deadLetters;
  }

  // ── Gas ──────────────────────────────────────────────────────

  recordGas(record: GasRecord): void {
    record.schemaVersion = CURRENT_SCHEMA_VERSION;
    this.gasLog.push(record);
    if (this.gasLog.length > MAX_RECORDS) {
      this.gasLog.splice(0, this.gasLog.length - MAX_RECORDS);
    }

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

  // ── HCS-20 v2 agentSeq counter ───────────────────────────────

  /**
   * Idempotent SETNX seed. Two cold Lambdas can both run the mirror
   * scan and call this concurrently with their respective values; the
   * first SETNX wins, the loser's value is discarded. Both Lambdas
   * then INCR against the shared canonical counter.
   */
  async seedAgentSeq(agentAccountId: string, value: number): Promise<void> {
    // @upstash/redis exposes setnx as `set` with the `nx: true` option.
    await this.redis.set(k('agentSeq', agentAccountId), value, { nx: true });
  }

  /**
   * Atomic INCR on the per-agent counter. Returns the new
   * (post-increment) value. Each call returns a unique number across
   * all Lambdas sharing this Redis cluster — closes the cross-Lambda
   * duplicate-agentSeq race that the previous in-process counter had.
   */
  async nextAgentSeq(agentAccountId: string): Promise<number> {
    return await this.redis.incr(k('agentSeq', agentAccountId));
  }

  /**
   * Peek the cluster counter without INCR. `null` when the key is unset
   * (never seeded). See IStore.peekAgentSeq — used to skip the redundant
   * (and, post-F8, fail-closed) cold-start mirror scan (F-R2).
   */
  async peekAgentSeq(agentAccountId: string): Promise<number | null> {
    const v = await this.redis.get<number | string>(k('agentSeq', agentAccountId));
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
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
