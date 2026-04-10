/**
 * A2A (Agent-to-Agent) Protocol Endpoint
 *
 * POST /api/a2a   — JSON-RPC 2.0 dispatcher (message/send, tasks/*, etc.)
 * GET  /api/a2a   — Returns the Agent Card (convenience alias for
 *                    /.well-known/agent-card.json)
 *
 * Mirrors the /api/mcp route pattern: rate-limited, auth-aware, wrapped
 * in withStore for last-resort error handling + Redis flush. The heavy
 * objects (agent, store, Hedera client) are cached per warm Lambda via
 * getAgentContext().
 *
 * The A2A adapter translates incoming A2A messages to MCP tool calls
 * and wraps the results as A2A Tasks. Zero new business logic — every
 * operation flows through the identical code path as an MCP tools/call.
 */

import { NextResponse } from 'next/server';
import { WebStandardStreamableHTTPServerTransport }
  from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildAgentCard } from '~/a2a/agent-card';
import { dispatch } from '~/a2a/dispatcher';
import type { ToolResult } from '~/a2a/adapter';
import { createMcpServer } from '../_lib/mcp';
import { withStore } from '../_lib/withStore';
import { staticCorsHeaders } from '../_lib/cors';
import { checkRateLimit, rateLimitResponse } from '../_lib/rateLimit';

// Play sessions can take 5-15s (deposit poll + Hedera consensus + prize
// transfer). Match the MCP route's timeout.
export const maxDuration = 60;

const CORS_HEADERS = staticCorsHeaders('GET, POST, OPTIONS');

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
  });
}

// ── GET: Agent Card ────────────────────────────────────────────

export async function GET() {
  return NextResponse.json(buildAgentCard(), {
    headers: {
      ...CORS_HEADERS,
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
    },
  });
}

// ── POST: JSON-RPC Dispatcher ──────────────────────────────────

export const POST = withStore(async (request: Request) => {
  try {
    // Rate limit: same budget as MCP (30/min per identity)
    if (!(await checkRateLimit({ request, action: 'a2a', limit: 30, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

    const rawBody = await request.text();

    // Extract auth token from Authorization header (same as MCP).
    // The A2A spec puts auth in the HTTP header, not in the JSON-RPC
    // params. We thread it through as an `auth_token` param on the
    // MCP tool call so the existing auth enforcement works unchanged.
    const authHeader = request.headers.get('authorization');
    const authToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : undefined;

    // The callTool function bridges A2A → MCP. It creates a fresh
    // McpServer per call (lightweight — tool registration is a hashmap
    // insert) and dispatches through the MCP transport so we get
    // EXACTLY the same code path as a real MCP tools/call request.
    //
    // This is intentionally NOT duplicated handler code — it goes
    // through the full MCP pipeline including auth, Zod validation,
    // distributed locks, and error formatting.
    const callTool = async (
      toolName: string,
      params: Record<string, unknown>,
    ): Promise<ToolResult> => {
      // Inject auth_token into params if the caller provided a Bearer token
      const paramsWithAuth = authToken
        ? { ...params, auth_token: authToken }
        : params;

      // Create a fresh MCP server with all tools registered
      const server = await createMcpServer();

      // Build a JSON-RPC tools/call request body
      const mcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: paramsWithAuth },
      };

      // Create a stateless transport and pipe the request through
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });

      await server.connect(transport);

      // Build a synthetic Request for the transport
      const syntheticRequest = new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mcpRequest),
      });

      const mcpResponse = await transport.handleRequest(syntheticRequest);
      await transport.close();

      // Parse the MCP response to extract the tool result
      const mcpBody = await mcpResponse.json() as {
        result?: { content?: { type: string; text: string }[]; isError?: boolean };
        error?: { message: string };
      };

      if (mcpBody.error) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: mcpBody.error.message }) }],
          isError: true,
        };
      }

      if (mcpBody.result?.content) {
        return {
          content: mcpBody.result.content.map((c) => ({
            type: 'text' as const,
            text: c.text,
          })),
          ...(mcpBody.result.isError ? { isError: true as const } : {}),
        };
      }

      // Unexpected response shape
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Unexpected MCP response' }) }],
        isError: true,
      };
    };

    // Dispatch the A2A JSON-RPC request
    const response = await dispatch(rawBody, callTool);

    return NextResponse.json(response, { headers: CORS_HEADERS });
  } catch (err) {
    console.error('[a2a] POST failed:', err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message },
      },
      { status: 500, headers: CORS_HEADERS },
    );
  }
});
