/**
 * Upstash Redis client for auth sessions and challenges.
 *
 * Falls back to an in-memory Map when Redis is not configured (local dev).
 * All session tokens are stored as sha256(token) → session data,
 * so a Redis compromise does not leak usable tokens.
 */

import { createHash } from 'node:crypto';

// ── Key prefixes (network-scoped to allow shared Redis) ──────
//
// Every cross-module Redis key lives here. When adding a new prefix:
//   1. Add it below with a trailing colon or sub-namespace
//   2. Import KEY_PREFIX in the consuming module
//   3. NEVER do `KEY_PREFIX.session.replace(...)` — that's a silent
//      namespace-collision footgun. Add a first-class entry instead.

const NET = process.env.HEDERA_NETWORK ?? 'testnet';

export const KEY_PREFIX = {
  // Auth
  challenge: `lla:${NET}:challenge:`,
  session: `lla:${NET}:session:`,
  accountSessions: `lla:${NET}:account-sessions:`,
  rateLimit: `lla:${NET}:ratelimit:`,
  // Distributed locks (src/lib/locks.ts)
  lockUser: `lla:${NET}:lock:user:`,
  lockOperator: `lla:${NET}:lock:operator:`,
  // Operational flags
  killswitch: `lla:${NET}:killswitch`,
  // Refund replay protection (src/hedera/refund.ts)
  refunded: `lla:${NET}:refunded:`,
  // Pending ledger adjustments when a refund can't grab the user lock
  pendingLedger: `lla:${NET}:pending-ledger`,
  // Withdrawal velocity counters, keyed per token + user
  velocity: `lla:${NET}:velocity:withdrawal:`,
} as const;

// ── Token hashing ────────────────────────────────────────────

/** Hash a session token with SHA-256 for Redis key storage. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ── Redis client ─────────────────────────────────────────────

interface RedisLike {
  get<T = string>(key: string): Promise<T | null>;
  /**
   * Set a key with optional TTL (ex) and set-if-not-exists (nx).
   * Returns 'OK' (or similar truthy) on success, null on NX conflict.
   */
  set(
    key: string,
    value: string,
    options?: { ex?: number; nx?: boolean },
  ): Promise<string | null | unknown>;
  del(...keys: string[]): Promise<number>;
  getdel<T = string>(key: string): Promise<T | null>;
  expire(key: string, seconds: number): Promise<number>;
  persist(key: string): Promise<number>;
  /** Time-to-live for a key in seconds. -2 = missing, -1 = no expiry. */
  ttl(key: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  // ── List ops (used by pending ledger queue) ────────────────
  rpush(key: string, value: string): Promise<number>;
  /**
   * LRANGE key start stop. Inclusive bounds, -1 = last element.
   * Returned rows may be strings or already-parsed objects depending
   * on the backend. Callers must handle both.
   */
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
  llen(key: string): Promise<number>;
  /**
   * LREM key count value — removes up to `count` occurrences of value.
   * count=1 removes the first match (what we want for queue-drain).
   */
  lrem(key: string, count: number, value: string): Promise<number>;
  /**
   * Evaluate a Lua script server-side. Required for atomic
   * compare-and-delete patterns (distributed lock release).
   * The in-memory fallback emulates a whitelist of known scripts.
   */
  eval<T = unknown>(
    script: string,
    keys: string[],
    args: string[],
  ): Promise<T>;
}

// ── Singleton pinned to globalThis ──────────────────────────
//
// Next.js dev mode (webpack HMR) invalidates and re-evaluates modules
// when files change. A plain module-level `let redisClient` gets reset
// to null on every HMR tick, wiping the in-memory fallback store and
// taking all live sessions, challenges, rate-limit counters, locks,
// and kill-switch flags with it. The session from /api/auth/verify
// then can't be found by /api/user/register because they're talking
// to different Map instances.
//
// Pinning to `globalThis` makes the singleton survive HMR because the
// global object persists across module re-evaluation. This is the
// exact pattern Prisma and the Upstash SDK use for the same reason.
// In production (Upstash Redis configured), this has no effect — the
// Redis client is stateless and the global pin just caches a handle.
// In CLI mode (node --import tsx) there's no HMR so the global pin
// is also a no-op improvement.

type RedisGlobals = {
  __lazylottoRedisClient__?: RedisLike | null;
};

const globalForRedis = globalThis as unknown as RedisGlobals;

/**
 * Synchronously check if Upstash Redis is configured in the environment.
 *
 * Used by route handlers to surface "memory" vs "upstash" mode in
 * response headers for diagnostics — when rate limiting silently
 * degrades to per-Lambda counters because Upstash isn't wired up,
 * the only signal previously was a single warning at cold-start in
 * Vercel function logs. This lets us check from the client side via
 * a response header instead of poking Vercel env vars.
 */
export function isUpstashConfigured(): boolean {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return Boolean(url && token);
}

/** Get or create the Redis client. Survives Next.js dev HMR. */
export async function getRedis(): Promise<RedisLike> {
  if (globalForRedis.__lazylottoRedisClient__) {
    return globalForRedis.__lazylottoRedisClient__;
  }

  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token) {
    const { Redis } = await import('@upstash/redis');
    const client = new Redis({ url, token }) as unknown as RedisLike;
    globalForRedis.__lazylottoRedisClient__ = client;
    return client;
  }

  // Fallback: in-memory store for local dev. Pinned to globalThis so
  // sessions persist across Next.js HMR — otherwise every file save
  // would wipe the in-memory auth state and 401 every request after.
  console.warn('[Auth] No Upstash Redis configured — using in-memory store (not for production)');
  const client = createInMemoryStore();
  globalForRedis.__lazylottoRedisClient__ = client;
  return client;
}

// ── In-memory fallback ───────────────────────────────────────

function createInMemoryStore(): RedisLike {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  const sets = new Map<string, Set<string>>();
  const lists = new Map<string, string[]>();

  const isExpired = (entry: { expiresAt?: number }) =>
    entry.expiresAt !== undefined && Date.now() > entry.expiresAt;

  return {
    async get<T = string>(key: string): Promise<T | null> {
      const entry = store.get(key);
      if (!entry || isExpired(entry)) { store.delete(key); return null; }
      return entry.value as unknown as T;
    },
    async set(key: string, value: string, options?: { ex?: number; nx?: boolean }) {
      // Honor set-if-not-exists: return null if the key is already present
      // and unexpired. Mirrors Redis SET NX semantics.
      if (options?.nx) {
        const existing = store.get(key);
        if (existing && !isExpired(existing)) return null;
      }
      store.set(key, {
        value,
        expiresAt: options?.ex ? Date.now() + options.ex * 1000 : undefined,
      });
      return 'OK';
    },
    async del(...keys: string[]) {
      let count = 0;
      for (const k of keys) { if (store.delete(k)) count++; }
      return count;
    },
    async getdel<T = string>(key: string): Promise<T | null> {
      const entry = store.get(key);
      if (!entry || isExpired(entry)) { store.delete(key); return null; }
      store.delete(key);
      return entry.value as unknown as T;
    },
    async expire(key: string, seconds: number) {
      const entry = store.get(key);
      if (!entry) return 0;
      entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    },
    async persist(key: string) {
      const entry = store.get(key);
      if (!entry) return 0;
      delete entry.expiresAt;
      return 1;
    },
    async ttl(key: string) {
      const entry = store.get(key);
      if (!entry) return -2;
      if (isExpired(entry)) { store.delete(key); return -2; }
      if (entry.expiresAt === undefined) return -1;
      return Math.floor((entry.expiresAt - Date.now()) / 1000);
    },
    async smembers(key: string) {
      return Array.from(sets.get(key) ?? []);
    },
    async sadd(key: string, ...members: string[]) {
      if (!sets.has(key)) sets.set(key, new Set());
      const s = sets.get(key)!;
      let added = 0;
      for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
      return added;
    },
    async srem(key: string, ...members: string[]) {
      const s = sets.get(key);
      if (!s) return 0;
      let removed = 0;
      for (const m of members) { if (s.delete(m)) removed++; }
      return removed;
    },
    async incr(key: string) {
      const entry = store.get(key);
      const current = entry && !isExpired(entry) ? Number(entry.value) || 0 : 0;
      const next = current + 1;
      if (entry) entry.value = String(next);
      else store.set(key, { value: String(next) });
      return next;
    },
    async rpush(key: string, value: string) {
      if (!lists.has(key)) lists.set(key, []);
      const list = lists.get(key)!;
      list.push(value);
      return list.length;
    },
    async lrange(key: string, start: number, stop: number) {
      const list = lists.get(key) ?? [];
      // Mirror Redis semantics: negative indices count from the end,
      // `stop` is inclusive.
      const len = list.length;
      const s = start < 0 ? Math.max(0, len + start) : Math.min(start, len);
      const e = stop < 0 ? len + stop + 1 : Math.min(stop + 1, len);
      return list.slice(s, e);
    },
    async llen(key: string) {
      return lists.get(key)?.length ?? 0;
    },
    async lrem(key: string, count: number, value: string) {
      const list = lists.get(key);
      if (!list) return 0;
      let removed = 0;
      if (count > 0) {
        // Remove first `count` matches from head
        let i = 0;
        while (i < list.length && removed < count) {
          if (list[i] === value) {
            list.splice(i, 1);
            removed++;
          } else {
            i++;
          }
        }
      } else if (count < 0) {
        // Remove last `|count|` matches from tail
        let i = list.length - 1;
        const target = Math.abs(count);
        while (i >= 0 && removed < target) {
          if (list[i] === value) {
            list.splice(i, 1);
            removed++;
          }
          i--;
        }
      } else {
        // count=0 → remove all matches
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i] === value) {
            list.splice(i, 1);
            removed++;
          }
        }
      }
      return removed;
    },
    async eval<T = unknown>(
      script: string,
      keys: string[],
      args: string[],
    ): Promise<T> {
      // Emulate the specific scripts used by the codebase. In-memory store
      // is single-threaded JS, so the compare-and-delete is trivially atomic.
      //
      // Known script: compare-and-delete (used by locks.ts)
      //   if redis.call("get", KEYS[1]) == ARGV[1] then
      //     return redis.call("del", KEYS[1])
      //   else
      //     return 0
      //   end
      if (script.includes('get') && script.includes('del') && keys.length === 1 && args.length === 1) {
        const key = keys[0]!;
        const expected = args[0]!;
        const entry = store.get(key);
        if (!entry || isExpired(entry)) return 0 as unknown as T;
        if (entry.value !== expected) return 0 as unknown as T;
        store.delete(key);
        return 1 as unknown as T;
      }
      throw new Error('In-memory eval: unsupported script pattern');
    },
  };
}
