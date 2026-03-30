import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { LottoAgent } from '../agent/LottoAgent.js';
import { createClient } from '../hedera/wallet.js';
import {
  registerSingleUserTools,
  registerMultiUserTools,
  registerOperatorTools,
} from './tools/index.js';
import type {
  ServerContext,
  SessionRecord,
  CumulativeStats,
} from './tools/types.js';
import { errorMsg, tokenBalanceToNumber, toEvmAddress } from '../utils/format.js';

// ── Helpers ───────────────────────────────────────────────────

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

// ── Session history (in-memory, resets on restart) ────────────

const sessionHistory: SessionRecord[] = [];
const cumulativeStats: CumulativeStats = {
  sessionsPlayed: 0,
  totalEntries: 0,
  spentByToken: {},
  winsByToken: {},
};

// ── Active session guard ──────────────────────────────────────

let isSessionActive = false;

// ── Auth helper ──────────────────────────────────────────────
// When MCP_AUTH_TOKEN is set, all tools that move funds require the token.
// For stdio transport (Claude Desktop), auth is implicit (local process).
// For future HTTP transport, this becomes the primary security layer.

const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || null;

// ══════════════════════════════════════════════════════════════
//  MCP Server
// ══════════════════════════════════════════════════════════════

export async function startMcpServer(
  agent: LottoAgent,
  multiUser?: import('../custodial/MultiUserAgent.js').MultiUserAgent
): Promise<void> {
  const client = createClient();

  if (MCP_AUTH_TOKEN) {
    console.log('MCP auth token configured. Sensitive tools require authentication.');
  } else {
    console.warn(
      '[MCP] No MCP_AUTH_TOKEN set. All tools are unrestricted. ' +
        'Set MCP_AUTH_TOKEN in .env for production deployments.'
    );
  }

  const { createRequire } = await import('node:module');
  const pkgRequire = createRequire(import.meta.url);
  const pkg = pkgRequire('../../package.json') as { version: string };

  const server = new McpServer({
    name: 'lazylotto-agent',
    version: pkg.version,
  });

  // Build the shared context that tool modules consume
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
    setIsSessionActive: (v: boolean) => {
      isSessionActive = v;
    },
    authToken: MCP_AUTH_TOKEN,
    requireAuth: (providedToken?: string) => {
      if (!MCP_AUTH_TOKEN) return null; // No auth configured — allow
      if (providedToken === MCP_AUTH_TOKEN) return null; // Valid token
      return errorResult('Authentication required. Provide auth_token parameter.');
    },
  };

  // Register tool groups
  registerSingleUserTools(server, agent, ctx);

  if (multiUser) {
    registerMultiUserTools(server, multiUser, ctx);
    registerOperatorTools(server, multiUser, ctx);
  }

  // ── Start server ──────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
