/**
 * Factory that returns the appropriate IStore implementation:
 *   - RedisStore  when UPSTASH_REDIS_REST_URL is set (Vercel serverless)
 *   - PersistentStore  otherwise (local dev, self-hosted)
 *
 * The returned store is already loaded (cache hydrated).
 */

import { PersistentStore } from './PersistentStore.js';
import { RedisStore } from './RedisStore.js';
import type { IStore } from './IStore.js';

export type { IStore } from './IStore.js';

export async function createStore(): Promise<IStore> {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    const store = new RedisStore();
    await store.load();
    return store;
  }

  // Fallback to JSON file store
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dataDir =
    process.env.CUSTODIAL_DATA_DIR ??
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.custodial-data');
  const store = new PersistentStore(dataDir);
  await store.load();
  return store;
}
