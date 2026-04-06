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

let store: IStore | null = null;

export async function getStore(): Promise<IStore> {
  if (store) return store;
  store = await createStore();
  return store;
}
