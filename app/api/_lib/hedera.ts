/**
 * Cached Hedera SDK client singleton for serverless API routes.
 *
 * Creates the client once per warm Lambda instance and reuses it.
 * Same pattern as store.ts — module-level variable survives across
 * requests within the same function invocation.
 */

import { createClient } from '~/hedera/wallet';
import type { Client } from '@hashgraph/sdk';

// Pinned to globalThis so Next.js dev HMR doesn't rebuild the client
// on every file save. The Hedera SDK client holds open connections —
// recreating it per HMR tick leaks resources and spams gRPC with
// fresh handshakes. See src/auth/redis.ts for the full rationale.

type HederaGlobals = { __lazylottoHederaClient__?: Client };
const globalForHedera = globalThis as unknown as HederaGlobals;

export function getClient(): Client {
  if (globalForHedera.__lazylottoHederaClient__) {
    return globalForHedera.__lazylottoHederaClient__;
  }
  const created = createClient();
  globalForHedera.__lazylottoHederaClient__ = created;
  return created;
}
