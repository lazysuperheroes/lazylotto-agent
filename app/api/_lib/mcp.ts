/**
 * MCP agent context singleton for serverless API routes.
 *
 * Caches the heavy objects (LottoAgent, MultiUserAgent, store, client)
 * per warm Lambda instance. A new McpServer is created per request
 * since McpServer.connect() binds to a single transport.
 *
 * Tool registration is lightweight (~1ms synchronous hashmap insertion).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LottoAgent } from '~/agent/LottoAgent';
import { MultiUserAgent } from '~/custodial/MultiUserAgent';
import { loadCustodialConfig } from '~/custodial/types';
import { loadStrategy } from '~/config/loader';
import {
  registerMultiUserTools,
  registerOperatorTools,
} from '~/mcp/tools/index';
import type { ServerContext, SessionRecord, CumulativeStats, AuthResult } from '~/mcp/tools/types';
import { errorMsg, tokenBalanceToNumber, toEvmAddress } from '~/utils/format';
import { resolveAuth } from '~/auth/middleware';
import { getStore } from './store';
import { getClient } from './hedera';
import { acquireUserLock, releaseUserLock } from './locks';
import type { IStore } from '~/custodial/IStore';
import type { Client } from '@hashgraph/sdk';

// ── Cached singletons ───────────────────────────────────────────
//
// We cache the `Promise<AgentContext>`, not the resolved fields. Two
// concurrent cold-start requests both hit `getAgentContext()` before
// init finishes; sharing the in-flight promise makes them wait on one
// init instead of racing and doing two parallel Hedera-client creations
// and two DepositWatcher wire-ups. If init rejects, we clear the cache
// so the next request retries cleanly rather than sticking the error.
//
// Also pinned to globalThis so Next.js dev HMR doesn't rebuild the
// entire agent context (LottoAgent + MultiUserAgent + store wiring)
// on every file save — that's several hundred ms of cold-start work
// per tick and throws off any in-progress test session.

type McpGlobals = { __lazylottoContextPromise__?: Promise<AgentContext> | null };
const globalForMcp = globalThis as unknown as McpGlobals;

// Single source of truth for the agent version surfaced in MCP
// serverInfo. Reads NEXT_PUBLIC_APP_VERSION which next.config.mjs
// injects from package.json at build time (npm_package_version is
// only present when launched via `npm run`, so it's the wrong
// source in production).
const AGENT_VERSION =
  process.env.NEXT_PUBLIC_APP_VERSION ??
  process.env.npm_package_version ??
  '0.1.0';

// ── Helpers ─────────────────────────────────────────────────────

function json(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}

function getOwnerEoa(): string {
  const owner = process.env.OWNER_EOA;
  if (!owner) throw new Error('OWNER_EOA not set in environment');
  return owner;
}

// ── In-memory session state (best-effort per warm instance) ─────

const sessionHistory: SessionRecord[] = [];
const cumulativeStats: CumulativeStats = {
  sessionsPlayed: 0,
  totalEntries: 0,
  spentByToken: {},
  winsByToken: {},
};
let isSessionActive = false;

// ── Auth ────────────────────────────────────────────────────────

async function requireAuthCheck(providedToken?: string): Promise<AuthResult> {
  const hasAuthConfig =
    process.env.MCP_AUTH_TOKEN ||
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL;

  if (!hasAuthConfig) {
    return { auth: { tier: 'operator', accountId: 'local' } };
  }

  if (!providedToken) {
    return { error: errorResult('Authentication required. Provide auth_token parameter.') };
  }

  const auth = await resolveAuth(providedToken);
  if (!auth) {
    return { error: errorResult('Invalid or expired authentication token.') };
  }

  return { auth };
}

// ── Public API ──────────────────────────────────────────────────

export interface AgentContext {
  agent: LottoAgent;
  multiUser: MultiUserAgent;
  store: IStore;
  client: Client;
}

/**
 * Get or initialize the cached agent context.
 *
 * We cache the in-flight Promise so concurrent cold-start callers all
 * await the same init and don't race. On error, we clear the cache so
 * the NEXT request gets a fresh attempt (otherwise one transient
 * failure poisons the Lambda for its whole warm lifetime).
 */
export async function getAgentContext(): Promise<AgentContext> {
  if (globalForMcp.__lazylottoContextPromise__) {
    return globalForMcp.__lazylottoContextPromise__;
  }

  const promise = (async (): Promise<AgentContext> => {
    const store = await getStore();
    const client = getClient();

    const config = loadCustodialConfig();
    const multiUser = new MultiUserAgent(config);
    // Inject the shared store and client — avoids double-instantiation
    // where MultiUserAgent.initialize() would create a separate store instance.
    await multiUser.initialize({ store, client });
    // Note: do NOT call multiUser.start() — no background deposit watcher in serverless.
    // Deposits are detected on-demand via multiUser.pollDepositsOnce().

    const strategyName = process.env.STRATEGY ?? 'balanced';
    const strategy = loadStrategy(strategyName);
    const agent = new LottoAgent(strategy);

    return { agent, multiUser, store, client };
  })();

  globalForMcp.__lazylottoContextPromise__ = promise;

  // If init fails, clear the cache so the next call retries cleanly.
  // We still rethrow so this call's caller sees the error.
  promise.catch(() => {
    globalForMcp.__lazylottoContextPromise__ = null;
  });

  return promise;
}

/**
 * Create a fresh McpServer with all tools registered.
 * Called per request — McpServer is lightweight, the heavy stuff is cached.
 */
export async function createMcpServer(): Promise<McpServer> {
  // `agent` is currently unused in the context's tool registration, but
  // keep it in the destructure so any future single-user tool register
  // sees a ready LottoAgent without a second init call.
  const { multiUser: mu, store, client } = await getAgentContext();

  const server = new McpServer({
    name: 'lazylotto-agent',
    version: AGENT_VERSION,
  });

  const ctx: ServerContext = {
    client,
    json,
    errorResult,
    errorMsg,
    tokenBalance: tokenBalanceToNumber,
    getOwnerEoa,
    toEvmAddress,
    sessionHistory,
    cumulativeStats,
    getIsSessionActive: () => isSessionActive,
    setIsSessionActive: (v: boolean) => { isSessionActive = v; },
    authToken: process.env.MCP_AUTH_TOKEN || null,
    requireAuth: (providedToken?: string) => requireAuthCheck(providedToken),
    resolveUserId: (accountId: string) => {
      const user = store.getUserByAccountId(accountId);
      return user?.userId ?? null;
    },
    checkDeposits: () => mu.pollDepositsOnce(),
    acquireUserLock: (userId: string) => acquireUserLock(userId),
    releaseUserLock: (userId: string, token: string) => releaseUserLock(userId, token),
  };

  // Multi-user mode only — single-user tools are not registered on the hosted version
  registerMultiUserTools(server, mu, ctx);
  registerOperatorTools(server, mu, ctx);

  return server;
}
