/**
 * Upstash Redis client for auth sessions and challenges.
 *
 * Falls back to an in-memory Map when Redis is not configured (local dev).
 * All session tokens are stored as sha256(token) → session data,
 * so a Redis compromise does not leak usable tokens.
 */

import { createHash } from 'node:crypto';

// ── Key prefixes (network-scoped to allow shared Redis) ──────

const NET = process.env.HEDERA_NETWORK ?? 'testnet';

export const KEY_PREFIX = {
  challenge: `lla:${NET}:challenge:`,
  session: `lla:${NET}:session:`,
  accountSessions: `lla:${NET}:account-sessions:`,
  rateLimit: `lla:${NET}:ratelimit:`,
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
  smembers(key: string): Promise<string[]>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  incr(key: string): Promise<number>;
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

let redisClient: RedisLike | null = null;

/** Get or create the Redis client. Returns null if not configured. */
export async function getRedis(): Promise<RedisLike> {
  if (redisClient) return redisClient;

  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token) {
    const { Redis } = await import('@upstash/redis');
    redisClient = new Redis({ url, token }) as unknown as RedisLike;
    return redisClient;
  }

  // Fallback: in-memory store for local dev
  console.warn('[Auth] No Upstash Redis configured — using in-memory store (not for production)');
  redisClient = createInMemoryStore();
  return redisClient;
}

// ── In-memory fallback ───────────────────────────────────────

function createInMemoryStore(): RedisLike {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  const sets = new Map<string, Set<string>>();

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
