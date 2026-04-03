/**
 * POST|GET /api/mcp
 *
 * Stub endpoint for the MCP protocol on Vercel.
 *
 * The MCP protocol requires:
 *   - Persistent in-memory state (session tracking, cumulative stats)
 *   - Hedera SDK client with the agent's private key for signing transactions
 *   - Long-lived SSE connections for server-initiated notifications
 *
 * None of these are available in a stateless serverless environment.
 * The real MCP server runs on the operator's infrastructure via the CLI
 * (npm run dev:http or npm run dev:mcp).
 *
 * This route returns a helpful 501 explaining the situation and pointing
 * callers to the correct endpoint.
 */

import { NextResponse } from 'next/server';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.AUTH_PAGE_ORIGIN ?? '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
};

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function POST() {
  return NextResponse.json(
    {
      error: 'MCP endpoint not available on serverless deployment',
      message:
        'The MCP protocol requires a persistent connection and Hedera signing capability. ' +
        'Run the agent locally with: npm run dev:http (or npm run dev:multi-http for multi-user mode). ' +
        'Then connect Claude Desktop to http://localhost:3001/mcp',
      alternatives: {
        auth: '/api/auth/challenge — Authenticate via Hedera signature',
        dashboard: '/dashboard — View your balance and play history',
        admin: '/admin — Operator dashboard',
      },
    },
    { status: 501, headers: CORS_HEADERS },
  );
}

export async function GET() {
  return NextResponse.json(
    {
      error: 'MCP endpoint requires POST with JSON-RPC',
      message:
        'This serverless deployment does not support the MCP protocol. ' +
        'The MCP server must run on operator infrastructure with access to the Hedera wallet.',
      docs: 'https://modelcontextprotocol.io/docs',
      localEndpoint: 'http://localhost:3001/mcp',
    },
    { status: 405, headers: CORS_HEADERS },
  );
}
