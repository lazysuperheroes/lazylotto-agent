/**
 * Lazy-loaded store singleton for serverless API routes.
 *
 * Uses createStore() to pick the right backend:
 *   - RedisStore  when UPSTASH_REDIS_REST_URL is set (Vercel)
 *   - PersistentStore  otherwise (local dev, self-hosted)
 *
 * The store is created once per cold start, but re-hydrated from
 * Redis on every getStore() call to pick up changes made by other
 * Lambda invocations (e.g., MCP play sessions update balances that
 * the dashboard Lambda needs to see).
 */

import { createStore } from '~/custodial/createStore';
import type { IStore } from '~/custodial/IStore';

let store: IStore | null = null;

export async function getStore(): Promise<IStore> {
  if (store) {
    // Re-hydrate from backing store to pick up cross-Lambda changes.
    // For RedisStore this is a single pipeline read (~5-10ms).
    // For PersistentStore (local dev) this re-reads JSON files.
    await store.load();
    return store;
  }
  store = await createStore();
  return store;
}
