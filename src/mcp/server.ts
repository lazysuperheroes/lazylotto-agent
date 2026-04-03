import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

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
import { resolveAuth, satisfiesTier, extractToken, type AuthContext } from '../auth/index.js';
import { handleAuthRoute } from '../auth/routes.js';

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

// ── Auth ─────────────────────────────────────────────────────

const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || null;

/**
 * Unified auth check supporting both legacy MCP_AUTH_TOKEN and new session tokens.
 * Used by all tool handlers via ctx.requireAuth.
 */
async function requireAuthCheck(providedToken?: string): Promise<ReturnType<typeof errorResult> | null> {
  // No auth configured (local dev without MCP_AUTH_TOKEN) — allow everything
  if (!MCP_AUTH_TOKEN && !(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL)) return null;

  if (!providedToken) {
    return errorResult('Authentication required. Provide auth_token parameter.');
  }

  const auth = await resolveAuth(providedToken);
  if (!auth) {
    return errorResult('Invalid or expired authentication token.');
  }

  return null; // Auth succeeded
}

// ══════════════════════════════════════════════════════════════
//  MCP Server
// ══════════════════════════════════════════════════════════════

export interface McpServerOptions {
  /** Use HTTP transport instead of stdio. */
  http?: boolean;
  /** HTTP port (default 3001). */
  port?: number;
}

export async function startMcpServer(
  agent: LottoAgent,
  multiUser?: import('../custodial/MultiUserAgent.js').MultiUserAgent,
  options?: McpServerOptions,
): Promise<void> {
  const client = createClient();

  // Validate auth config
  if (MCP_AUTH_TOKEN) {
    if (MCP_AUTH_TOKEN.length < 32) {
      if (multiUser) {
        console.error(
          '[MCP] FATAL: MCP_AUTH_TOKEN must be at least 32 characters. ' +
            `Current length: ${MCP_AUTH_TOKEN.length}. Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
        );
        process.exit(1);
      } else {
        console.warn(
          `[MCP] WARNING: MCP_AUTH_TOKEN is only ${MCP_AUTH_TOKEN.length} characters. ` +
            'Recommended minimum is 32 characters for security.'
        );
      }
    }
    console.log('MCP auth token configured. Sensitive tools require authentication.');
  } else if (multiUser && !(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL)) {
    console.error(
      '[MCP] FATAL: MCP_AUTH_TOKEN or Upstash Redis is required in multi-user mode. ' +
        `Set MCP_AUTH_TOKEN in .env or configure UPSTASH_REDIS_REST_URL for session-based auth.`
    );
    process.exit(1);
  } else if (!MCP_AUTH_TOKEN) {
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
    requireAuth: async (providedToken?: string) => {
      return requireAuthCheck(providedToken);
    },
  };

  // Register tool groups
  registerSingleUserTools(server, agent, ctx);

  if (multiUser) {
    registerMultiUserTools(server, multiUser, ctx);
    registerOperatorTools(server, multiUser, ctx);
  }

  // ── Start transport ──────────────────────────────────────

  if (options?.http) {
    await startHttpTransport(server, options.port ?? 3001);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

// ── HTTP Transport ──────────────────────────────────────────

async function startHttpTransport(
  mcpServer: McpServer,
  port: number,
): Promise<void> {
  // Track transports by MCP session ID
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', process.env.AUTH_PAGE_ORIGIN ?? '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth routes (/auth/*)
    if (url.pathname.startsWith('/auth/')) {
      const handled = await handleAuthRoute(req, res);
      if (handled) return;
    }

    // Health check
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', network: process.env.HEDERA_NETWORK ?? 'testnet' }));
      return;
    }

    // MCP endpoint (/mcp)
    if (url.pathname === '/mcp') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && transports.has(sessionId)) {
        // Existing session
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }

      if (req.method === 'POST' && !sessionId) {
        // New session — create transport
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
          }
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      // Invalid request
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid MCP request' }));
      return;
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  httpServer.listen(port, () => {
    console.log(`[MCP] HTTP server listening on port ${port}`);
    console.log(`[MCP] MCP endpoint: http://localhost:${port}/mcp`);
    console.log(`[MCP] Auth endpoints: http://localhost:${port}/auth/*`);
    console.log(`[MCP] Health check: http://localhost:${port}/health`);
  });
}
