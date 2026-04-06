/**
 * Lazy-loaded store singleton for serverless API routes.
 *
 * Uses createStore() to pick the right backend:
 *   - RedisStore  when UPSTASH_REDIS_REST_URL is set (Vercel)
 *   - PersistentStore  otherwise (local dev, self-hosted)
 *
 * The store is created once per cold start and cached. Unlike the earlier
 * version, this no longer calls store.load() on every invocation — that
 * was costing ~8-12 Redis round trips per API request. Instead, each
 * route uses targeted refresh methods (store.refreshUser, refreshPlaysForUser,
 * refreshOperator, etc.) to re-sync only what it needs.
 */

import { createStore } from '~/custodial/createStore';
import type { IStore } from '~/custodial/IStore';

// Pinned to globalThis so Next.js dev HMR doesn't re-create the store
// on every file save — see src/auth/redis.ts for the full rationale.
// Re-creating the store mid-session loses the in-memory cache and
// forces a slow reload from disk/Redis on every request.

type StoreGlobals = { __lazylottoStore__?: IStore };
const globalForStore = globalThis as unknown as StoreGlobals;

export async function getStore(): Promise<IStore> {
  if (globalForStore.__lazylottoStore__) return globalForStore.__lazylottoStore__;
  const created = await createStore();
  globalForStore.__lazylottoStore__ = created;
  return created;
}
