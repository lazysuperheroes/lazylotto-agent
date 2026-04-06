/**
 * POST /api/mcp
 *
 * Stateless MCP endpoint for the LazyLotto agent on Vercel.
 *
 * Uses WebStandardStreamableHTTPServerTransport in stateless mode
 * (no session tracking). Each request creates a fresh McpServer with
 * all tools registered, handles the JSON-RPC request, and returns
 * the response. The heavy objects (agent, store, Hedera client) are
 * cached per warm Lambda instance.
 *
 * Discoverable via HOL at:
 *   GET /api/discover → { endpoints: { mcp: "/api/mcp" } }
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '../_lib/mcp';
import { withStore } from '../_lib/withStore';
import { staticCorsHeaders } from '../_lib/cors';
import { getRedis, KEY_PREFIX } from '~/auth/redis';

// Play sessions involve MCP client → dApp reads + Hedera SDK writes.
// Default 10s timeout is too short. Vercel Hobby allows up to 60s.
export const maxDuration = 60;

const CORS_HEADERS = staticCorsHeaders('GET, POST, DELETE, OPTIONS');

/** 30 requests per minute, keyed by auth token or IP. */
const MCP_RATE_LIMIT = 30;
const MCP_RATE_WINDOW_SEC = 60;

async function checkMcpRateLimit(request: Request): Promise<boolean> {
  // Key by auth token if present, otherwise by IP
  const authHeader = request.headers.get('authorization');
  const identity = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7, 23) // first 16 chars of token (enough to distinguish)
    : request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  const redis = await getRedis();
  const key = `${KEY_PREFIX.rateLimit}mcp:${identity}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, MCP_RATE_WINDOW_SEC);
  }
  return count <= MCP_RATE_LIMIT;
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

export const POST = withStore(async (request: Request) => {
  try {
    // Rate limit before doing any heavy work
    if (!await checkMcpRateLimit(request)) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded. Try again shortly.' }),
        {
          status: 429,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
            'Retry-After': String(MCP_RATE_WINDOW_SEC),
          },
        },
      );
    }

    const server = await createMcpServer();

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode — no session tracking
      enableJsonResponse: true,      // JSON responses, no SSE streams
    });

    await server.connect(transport);
    const response = await transport.handleRequest(request);
    await transport.close();

    // withStore wrapper guarantees store.flush() after this returns.
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: message }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      },
    );
  }
});

export async function GET() {
  return new Response(
    JSON.stringify({
      error: 'MCP endpoint requires POST with JSON-RPC',
      message: 'Send a POST request with a JSON-RPC body to interact with this MCP server.',
      docs: 'https://modelcontextprotocol.io/docs',
      example: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { jsonrpc: '2.0', method: 'initialize', params: { capabilities: {} }, id: 1 },
      },
    }),
    {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    },
  );
}

export async function DELETE() {
  // Stateless mode — no sessions to delete
  return new Response(
    JSON.stringify({ error: 'No active session (stateless mode)' }),
    {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    },
  );
}
