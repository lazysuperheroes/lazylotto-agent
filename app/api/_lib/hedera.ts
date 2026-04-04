/**
 * Cached Hedera SDK client singleton for serverless API routes.
 *
 * Creates the client once per warm Lambda instance and reuses it.
 * Same pattern as store.ts — module-level variable survives across
 * requests within the same function invocation.
 */

import { createClient } from '~/hedera/wallet';
import type { Client } from '@hashgraph/sdk';

let client: Client | null = null;

export function getClient(): Client {
  if (client) return client;
  client = createClient();
  return client;
}
