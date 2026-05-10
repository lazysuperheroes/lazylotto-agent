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
  // R2-FG-2 (2026-05-06 round-2 audit S-04): permanent SADD set of
  // original-tx-ids that have ever been refunded. The per-tx claim
  // under `refunded:<txId>` has a 30-day TTL; this set has no TTL.
  // `processRefund` checks BOTH so a TTL'd claim cannot allow a
  // duplicate on-chain refund.
  refundedOriginals: `lla:${NET}:refunded-originals`,
  // Pending ledger adjustments when a refund can't grab the user lock
  pendingLedger: `lla:${NET}:pending-ledger`,
  // R5-FG-4 (round-5 critical): per-(userId, sourceTx) atomic claim
  // for `applyPendingLedgerForUser` / `drainPendingLedgerAdjustments`.
  // Two concurrent drains both LRANGE the queue; without this claim,
  // each pass acquires the per-user lock, applies the debit, and
  // LREMs — but the LRANGE snapshot pre-dates the sibling's LREM, so
  // both apply twice. SET-NX before mutate makes the apply atomic;
  // LREM remains belt-and-braces. 7-day TTL matches deposit dedup.
  pendingLedgerClaim: `lla:${NET}:pending-ledger-claim:`,
  /**
   * R9-FG-6 / Phase-7 Cluster E: idempotency anchor for pending-ledger
   * row applications. SADD-membership keyed by `<userId>:<sourceTx>`.
   * Set members survive forever (no TTL) — once a row is applied,
   * the body's SISMEMBER check skips re-application even after a
   * Lambda crash mid-mutation + 7-day claim TTL elapse + sibling
   * re-acquisition. Closes the double-debit window R8-FG-7's busy-
   * branch fix relied on (incorrectly) being closed by body
   * idempotency.
   */
  pendingLedgerAppliedSet: `lla:${NET}:pending-ledger-applied`,
  pendingLedgerApplied: `lla:${NET}:pending-ledger-applied:`,
  // Withdrawal velocity counters, keyed per token + user
  velocity: `lla:${NET}:velocity:withdrawal:`,
  // Per-txId verifier locks for *_uncertain dead-letters — prevents
  // concurrent reconcile passes from double-mutating ledger / operator
  // state for the same uncertain entry. SET NX EX with 60s TTL.
  verifying: `lla:${NET}:verifying:`,
  // R3-FG-18: idempotency-key namespace, network-scoped. Pre-fix
  // `withIdempotency` keyed by `idem:${scope}:${key}` with NO network
  // prefix — testnet+mainnet sharing one Upstash collided.
  idempotency: `lla:${NET}:idem:`,
  // R3-FG-48: per-tx escalation dedup. Reconcile retries on a stuck
  // dead-letter would otherwise re-page every hour for the same
  // incident → operator alert fatigue. 6h TTL.
  escalated: `lla:${NET}:escalated:`,
  // R3-FG-28 (round-2 G-16): per-user dead-letter rate cap counter.
  // Hoisted out of DepositWatcher.ts:57 where the env was read at
  // runtime, splitting counters across env mutations.
  dlRate: `lla:${NET}:dl-rate:`,
} as const;

// ── Token hashing ────────────────────────────────────────────

/** Hash a session token with SHA-256 for Redis key storage. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ── Refund claim-key prefix guard (F2 / 2026-05-06 audit I-07) ─

/**
 * Validates that a refund-uncertain dead-letter's `details.claimKey`
 * is actually a refund claim key (lives under `KEY_PREFIX.refunded`)
 * before any caller does `redis.del`/`redis.set` against it.
 *
 * Without this guard, a hand-edited or migration-corrupted entry
 * with `claimKey: 'lla:testnet:session:victim'` would let
 * operator-tier (force-release) or the verifier delete arbitrary
 * `lla:` keys — sessions, user locks, killswitch flag, agentSeq
 * counter (rewinding HCS-20 sequence numbers). The verifier and
 * the force-release route MUST gate every claimKey op behind this.
 */
export function isRefundClaimKey(key: unknown): boolean {
  return typeof key === 'string' && key.startsWith(KEY_PREFIX.refunded);
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
  /** SISMEMBER — returns 1 if `member` is in the set at `key`, 0 otherwise. */
  sismember(key: string, member: string): Promise<number>;
  incr(key: string): Promise<number>;
  /**
   * R9-P3-002 / Phase-7: atomic INCRBY for the velocity-counter
   * race fix in MultiUserAgent.applyWithdrawalVelocityCap. Adds
   * `delta` to the integer at `key` (creates with value 0 if absent),
   * returns the new value. Atomicity prevents the pre-fix
   * `get → compute → set` last-write-wins race.
   */
  incrby(key: string, delta: number): Promise<number>;
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
  /**
   * R8-FG-9 / Phase-6 Cluster F + R9-FG-8 / Phase-7 Cluster G:
   * cursor-based key scan. The orphan reconciler walks every
   * registered claim namespace via SCAN.
   *
   * R9-FG-8 closure: cursor accepted and returned as `string |
   * number`. Upstash production returns the cursor as a STRING
   * (e.g. "42" or "0"); the in-memory mock returns numeric. The
   * pre-Phase-7 interface declared `Promise<[number, string[]]>`
   * and only worked because the reconciler defended with a local
   * cast + dual `cursor === 0 || cursor === '0'` exit check. Future
   * callers that trusted the type would silently loop forever on
   * production. Now both flavours are first-class.
   *
   * Cursor `0` (or `"0"`) means "start"; iterate until the returned
   * cursor is `0` again. Match is a glob with `*` wildcard.
   */
  scan(
    cursor: string | number,
    options: { match: string; count: number },
  ): Promise<[string | number, string[]]>;
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

/**
 * Synchronous backend mode for the auth/state Redis client.
 *
 * Returns `'upstash'` when Upstash credentials are configured, `'memory'`
 * otherwise. Used by `/api/health` (and any operator-facing diagnostic)
 * to surface backend mode without instantiating the client. Independent
 * of `getRedis()` so callers don't pay the lazy-init cost.
 */
export function getRedisBackendMode(): 'upstash' | 'memory' {
  return isUpstashConfigured() ? 'upstash' : 'memory';
}

/**
 * Hard-fail when running in production without Upstash configured.
 *
 * Why: without Upstash, every Redis-backed guarantee silently degrades
 * to per-Lambda state — distributed locks become per-process mutexes,
 * rate limits become per-Lambda counters, sessions don't persist across
 * cold starts, the kill switch doesn't propagate, withdrawal velocity
 * caps don't share state. The previous behavior was a one-line cold-
 * start warning that scrolled past in Vercel logs. This function turns
 * that into an obvious deploy failure (5xx on first request rather than
 * a slow-burn correctness incident).
 *
 * Local development (`NODE_ENV` unset or `'development'`) keeps the
 * in-memory fallback. Tests run under `NODE_ENV=test` (or undefined)
 * and are unaffected.
 *
 * Called from `withStore` so every API route gets the check. Also
 * called inside `getRedis()` before the in-memory fallback as a
 * belt-and-braces guard for any code path that might bypass `withStore`.
 *
 * Throws an Error whose `message` starts with `PRODUCTION_REDIS_REQUIRED:`
 * for grep-ability in Vercel function logs.
 */
export function assertProductionRedis(): void {
  if (process.env.NODE_ENV === 'production' && !isUpstashConfigured()) {
    throw new Error(
      'PRODUCTION_REDIS_REQUIRED: Upstash Redis credentials missing in production. ' +
      'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or the legacy ' +
      'KV_REST_API_URL / KV_REST_API_TOKEN aliases). Refusing to start with the ' +
      'in-memory fallback because distributed locks, rate limiting, session ' +
      'storage, and kill-switch state would silently degrade to per-Lambda scope.',
    );
  }
  // 0.3.4 hardening: refuse to boot a production deployment without an
  // explicit HEDERA_NETWORK. Both `src/auth/redis.ts` and
  // `src/custodial/RedisStore.ts` capture `NET = process.env.HEDERA_NETWORK ?? 'testnet'`
  // at module-load time and bake it into EVERY Redis key prefix. A
  // mainnet deploy that forgets the env reads/writes the testnet
  // namespace silently — sessions, locks, deposit-claim sets, agentSeq
  // counters all collide with testnet state. Hard-fail at boot.
  if (process.env.NODE_ENV === 'production') {
    const network = process.env.HEDERA_NETWORK;
    if (network !== 'mainnet' && network !== 'testnet') {
      throw new Error(
        `PRODUCTION_NETWORK_REQUIRED: HEDERA_NETWORK must be set to ` +
        `'mainnet' or 'testnet' in production (got: ${JSON.stringify(network)}). ` +
        `Without it, Redis key prefixes silently default to testnet — ` +
        `mainnet deployments would collide with testnet state.`,
      );
    }
  }

  // F22 (2026-05-06 audit MO-6 / SM-11): a production deployment
  // without RECONCILE_FAILURE_WEBHOOK_URL silently swallows every
  // operator page from `escalateUncertainDlFailure`. The whole
  // uncertain-tx escalation path becomes a logger.warn that nobody
  // sees. Boot-fail rather than ship that. (Local dev / testnet are
  // exempt because the webhook is operationally optional there.)
  if (process.env.NODE_ENV === 'production') {
    const webhook = process.env.RECONCILE_FAILURE_WEBHOOK_URL;
    if (!webhook || webhook.trim() === '') {
      throw new Error(
        `PRODUCTION_ESCALATION_REQUIRED: RECONCILE_FAILURE_WEBHOOK_URL must ` +
        `be set in production. Without it, every uncertain-tx escalation ` +
        `(refund_uncertain DL write failed, malformed-DL retry-storm, ` +
        `play_uncertain SUCCESS that needs manual settlement reconstruction) ` +
        `degrades to logger.warn — operators never see the page. Set the ` +
        `Slack/Discord webhook URL or accept the boot failure.`,
      );
    }
    // R4-FG-25 (round-4 high): validate URL parseability + scheme.
    // Pre-fix the boot check accepted typos (`https//hooks…`, missing
    // colon) and accidental http:// or file:// URLs — the cron
    // payload (reconcile delta info, escalation messages) could leak
    // operational signals to a misconfigured/malicious URL, and the
    // webhook fire-and-forget would silently fail forever.
    let parsedWebhook: URL;
    try {
      parsedWebhook = new URL(webhook);
    } catch {
      throw new Error(
        `PRODUCTION_ESCALATION_REQUIRED: RECONCILE_FAILURE_WEBHOOK_URL is not ` +
        `a valid URL (got "${webhook}"). Common typo: missing colon after https. ` +
        `Set a parseable https:// URL.`,
      );
    }
    if (parsedWebhook.protocol !== 'https:') {
      throw new Error(
        `PRODUCTION_ESCALATION_REQUIRED: RECONCILE_FAILURE_WEBHOOK_URL must use ` +
        `https:// scheme (got "${parsedWebhook.protocol}"). Operational signals ` +
        `(escalation cause messages, user IDs) would otherwise traverse the ` +
        `internet in plaintext.`,
      );
    }

    // R3-FG-43 (round-3 P10-AUTH-002 / P10-PROD-001): validate
    // AUTH_PAGE_ORIGIN. The default fallback in `getAudience()` is
    // testnet's URL — a mainnet deploy missing this env silently
    // accepts captured testnet signatures as valid against mainnet
    // (cross-network signature replay). Plus R3-FG-80: validate
    // LAZYLOTTO_MCP_URL boot-time.
    const audience = process.env.AUTH_PAGE_ORIGIN;
    if (!audience || audience.trim() === '') {
      throw new Error(
        `PRODUCTION_AUDIENCE_REQUIRED: AUTH_PAGE_ORIGIN must be set in ` +
        `production. Without it, getAudience() falls back to testnet's URL ` +
        `and a mainnet deploy accepts captured testnet signatures as valid.`,
      );
    }
    if (!audience.startsWith('https://')) {
      throw new Error(
        `PRODUCTION_AUDIENCE_INSECURE: AUTH_PAGE_ORIGIN must start with https:// ` +
        `(got "${audience}"). Plain-http audiences are rejected to prevent ` +
        `MITM-rewriting of the signed-message audience.`,
      );
    }
    const network = process.env.HEDERA_NETWORK;
    if (network === 'mainnet' && /testnet/.test(audience)) {
      throw new Error(
        `PRODUCTION_AUDIENCE_NETWORK_MISMATCH: HEDERA_NETWORK=mainnet but ` +
        `AUTH_PAGE_ORIGIN="${audience}" looks like a testnet origin. Update ` +
        `the env to the mainnet origin or accept the boot failure.`,
      );
    }
    const mcpUrl = process.env.LAZYLOTTO_MCP_URL;
    if (!mcpUrl || mcpUrl.trim() === '') {
      throw new Error(
        `PRODUCTION_MCP_URL_REQUIRED: LAZYLOTTO_MCP_URL must be set in ` +
        `production. Pre-fix this only failed at first tool call (not at ` +
        `boot), so an operator deploying with a typo'd env saw a cryptic ` +
        `error in function logs only after the first user request.`,
      );
    }
  }
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

  // Belt-and-braces: hard-fail in production rather than silently
  // returning the in-memory fallback. This complements the same check
  // in withStore — covers any code path that calls getRedis() outside
  // a wrapped HTTP route (CLI scripts, cron handlers, tests run with
  // NODE_ENV=production by mistake).
  assertProductionRedis();

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
    async sismember(key: string, member: string) {
      const s = sets.get(key);
      return s?.has(member) ? 1 : 0;
    },
    async incr(key: string) {
      const entry = store.get(key);
      const current = entry && !isExpired(entry) ? Number(entry.value) || 0 : 0;
      const next = current + 1;
      if (entry) entry.value = String(next);
      else store.set(key, { value: String(next) });
      return next;
    },
    async incrby(key: string, delta: number) {
      const entry = store.get(key);
      const current = entry && !isExpired(entry) ? Number(entry.value) || 0 : 0;
      const next = current + delta;
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
      // is single-threaded JS, so the compare-and-mutate is trivially atomic.
      //
      // R5-FG-86 (P4-002 + P4-003): the mock used to match any
      // script containing 'get' AND 'del', regardless of token-arg
      // shape — too permissive (matched the heartbeat script's
      // expire form, succeeded as a DEL, broke heartbeat tests).
      // Now: parse the canonical compare-and-X verb and dispatch
      // exactly. Unknown scripts throw so a writer regression is
      // visible at test time.
      const usesExpire = /redis\.call\(\s*['"]expire['"]/i.test(script);
      const usesDel =
        /redis\.call\(\s*['"]del['"]/i.test(script) && !usesExpire;
      const guardedByGet = /redis\.call\(\s*['"]get['"]/i.test(script);

      // Canonical compare-and-DEL (locks.ts RELEASE_SCRIPT):
      //   if redis.call("get", KEYS[1]) == ARGV[1] then
      //     return redis.call("del", KEYS[1])
      //   else
      //     return 0
      //   end
      if (guardedByGet && usesDel && keys.length === 1 && args.length === 1) {
        const key = keys[0]!;
        const expected = args[0]!;
        const entry = store.get(key);
        if (!entry || isExpired(entry)) return 0 as unknown as T;
        if (entry.value !== expected) return 0 as unknown as T;
        store.delete(key);
        return 1 as unknown as T;
      }

      // R5-FG-86 / R4-FG-66: HEARTBEAT_RELEASE_OR_EXTEND_SCRIPT.
      //   if redis.call('get', KEYS[1]) == ARGV[1] then
      //     return redis.call('expire', KEYS[1], ARGV[2])
      //   else
      //     return 0
      //   end
      if (guardedByGet && usesExpire && keys.length === 1 && args.length === 2) {
        const key = keys[0]!;
        const expected = args[0]!;
        const ttlSec = Number(args[1]);
        const entry = store.get(key);
        if (!entry || isExpired(entry)) return 0 as unknown as T;
        if (entry.value !== expected) return 0 as unknown as T;
        if (Number.isFinite(ttlSec) && ttlSec > 0) {
          entry.expiresAt = Date.now() + ttlSec * 1000;
        } else {
          delete entry.expiresAt;
        }
        return 1 as unknown as T;
      }

      throw new Error('In-memory eval: unsupported script pattern');
    },
    /**
     * R8-FG-9 / Phase-6 Cluster F: cursor-based scan implementation.
     * The orphan reconciler walks every registered claim namespace
     * via this entrypoint. Cursor semantics: linear pass over the
     * keyspace; cursor IS the index into the sorted key array.
     * Match supports trailing-`*` glob (the only form the reconciler
     * uses).
     */
    async scan(
      cursor: number,
      options: { match: string; count: number },
    ): Promise<[number, string[]]> {
      // Materialize the live, non-expired keyset.
      const allKeys: string[] = [];
      for (const [k, v] of store.entries()) {
        if (isExpired(v)) continue;
        allKeys.push(k);
      }
      allKeys.sort();
      // Filter by glob (only `*` wildcards supported).
      const pattern = options.match;
      const wildcardIdx = pattern.indexOf('*');
      const prefix = wildcardIdx >= 0 ? pattern.slice(0, wildcardIdx) : pattern;
      const matches = allKeys.filter(
        wildcardIdx >= 0 ? (k) => k.startsWith(prefix) : (k) => k === pattern,
      );
      const start = Math.max(0, Math.floor(cursor));
      const end = Math.min(matches.length, start + Math.max(1, options.count));
      const batch = matches.slice(start, end);
      const next = end >= matches.length ? 0 : end;
      return [next, batch];
    },
  };
}
