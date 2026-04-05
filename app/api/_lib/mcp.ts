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

let agent: LottoAgent | null = null;
let multiUser: MultiUserAgent | null = null;
let cachedStore: IStore | null = null;
let cachedClient: Client | null = null;

const AGENT_VERSION = '0.1.5';

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
 * Heavy objects are created once per warm Lambda instance.
 */
export async function getAgentContext(): Promise<AgentContext> {
  if (agent && multiUser && cachedStore && cachedClient) {
    return { agent, multiUser, store: cachedStore, client: cachedClient };
  }

  cachedStore = await getStore();
  cachedClient = getClient();

  const config = loadCustodialConfig();
  multiUser = new MultiUserAgent(config);
  // Inject the shared store and client — avoids double-instantiation
  // where MultiUserAgent.initialize() would create a separate store instance.
  await multiUser.initialize({ store: cachedStore, client: cachedClient });
  // Note: do NOT call multiUser.start() — no background deposit watcher in serverless.
  // Deposits are detected on-demand via multiUser.pollDepositsOnce().

  const strategyName = process.env.STRATEGY ?? 'balanced';
  const strategy = loadStrategy(strategyName);
  agent = new LottoAgent(strategy);

  return { agent, multiUser, store: cachedStore, client: cachedClient };
}

/**
 * Create a fresh McpServer with all tools registered.
 * Called per request — McpServer is lightweight, the heavy stuff is cached.
 */
export async function createMcpServer(): Promise<McpServer> {
  const { agent: a, multiUser: mu, store, client } = await getAgentContext();

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
    releaseUserLock: (userId: string) => releaseUserLock(userId),
  };

  // Multi-user mode only — single-user tools are not registered on the hosted version
  registerMultiUserTools(server, mu, ctx);
  registerOperatorTools(server, mu, ctx);

  return server;
}
