/**
 * Lazy-loaded PersistentStore singleton for serverless API routes.
 *
 * In the Next.js serverless model we cannot access the running
 * MultiUserAgent instance. Instead, we load the PersistentStore
 * directly from the .custodial-data/ JSON files. This is safe for
 * read-only dashboard queries — the store is loaded fresh on each
 * cold start and cached for the lifetime of the serverless function.
 *
 * The data directory is resolved in order of precedence:
 *   1. CUSTODIAL_DATA_DIR environment variable (explicit override)
 *   2. Relative to this module: ../../.. from app/api/_lib/ -> project root + .custodial-data
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PersistentStore } from '~/custodial/PersistentStore';

const __dirname = dirname(fileURLToPath(import.meta.url));

let store: PersistentStore | null = null;

export async function getStore(): Promise<PersistentStore> {
  if (store) return store;

  const dataDir =
    process.env.CUSTODIAL_DATA_DIR ??
    join(__dirname, '..', '..', '..', '.custodial-data');

  store = new PersistentStore(dataDir);
  await store.load();
  return store;
}
