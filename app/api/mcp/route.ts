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
import { getRedis, isUpstashConfigured, KEY_PREFIX } from '~/auth/redis';

// Process-level safety net for unhandled rejections from inside the
// MCP SDK's async dispatch chain. The SDK's transport.handleRequest
// loops through messages and calls onmessage WITHOUT awaiting, which
// means any async error in the dispatcher escapes to the runtime.
// On Vercel, an unhandled rejection terminates the function before
// our route's catch can return a response — Vercel then serves its
// generic /500 HTML page with no useful information.
//
// This handler logs the rejection with a tag we can find in Vercel
// function logs and then suppresses the default behavior so the
// function survives long enough to send our error response.
//
// Module-load idempotency: only register once per Lambda warm
// container. Subsequent route imports skip the duplicate handler.
declare global {
  // eslint-disable-next-line no-var
  var __lazylottoUnhandledRejectionHandlerInstalled__: boolean | undefined;
}
if (typeof process !== 'undefined' && !global.__lazylottoUnhandledRejectionHandlerInstalled__) {
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[mcp] UNHANDLED REJECTION', {
      reason:
        reason instanceof Error
          ? { message: reason.message, stack: reason.stack, name: reason.name }
          : reason,
      promise: String(promise),
    });
  });
  process.on('uncaughtException', (err) => {
    console.error('[mcp] UNCAUGHT EXCEPTION', {
      message: err.message,
      stack: err.stack,
      name: err.name,
    });
  });
  global.__lazylottoUnhandledRejectionHandlerInstalled__ = true;
}

// Play sessions involve MCP client → dApp reads + Hedera SDK writes.
// Default 10s timeout is too short. Vercel Hobby allows up to 60s.
export const maxDuration = 60;

const CORS_HEADERS = staticCorsHeaders('GET, POST, DELETE, OPTIONS');

/** 30 requests per minute, keyed by auth token or IP. */
const MCP_RATE_LIMIT = 30;
const MCP_RATE_WINDOW_SEC = 60;

interface RateLimitState {
  /** True if within the limit, false if exceeded. */
  allowed: boolean;
  /** Current count after the increment. */
  count: number;
  /** "upstash" (cluster-wide) or "memory" (per-Lambda only). */
  mode: 'upstash' | 'memory';
  /** The identity used for keying — first 16 chars of token, IP, or 'unknown'. */
  identity: string;
}

async function checkMcpRateLimit(request: Request): Promise<RateLimitState> {
  // Key by auth token if present, otherwise by IP
  const authHeader = request.headers.get('authorization');
  const identity = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7, 23) // first 16 chars of token (enough to distinguish)
    : request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  const mode: 'upstash' | 'memory' = isUpstashConfigured() ? 'upstash' : 'memory';
  const redis = await getRedis();
  const key = `${KEY_PREFIX.rateLimit}mcp:${identity}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, MCP_RATE_WINDOW_SEC);
  }
  return {
    allowed: count <= MCP_RATE_LIMIT,
    count,
    mode,
    identity,
  };
}

/**
 * Build standard rate-limit headers + diagnostic headers so callers can
 * see what mode the limiter is in. The mode header is critical for
 * verifying that Upstash is actually wired up on Vercel — without it,
 * limits silently degrade to per-Lambda counters and the test never
 * trips because each request hits a fresh container.
 */
function rateLimitHeaders(state: RateLimitState): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(MCP_RATE_LIMIT),
    'X-RateLimit-Remaining': String(Math.max(0, MCP_RATE_LIMIT - state.count)),
    'X-RateLimit-Mode': state.mode,
    'X-RateLimit-Identity': state.identity,
  };
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
  // Each step is wrapped so we can attribute the failure to the right
  // layer if anything goes wrong. The withStore wrapper has its own
  // top-level catch as a safety net for anything we miss here.
  let rateLimitState: RateLimitState | undefined;
  try {
    // Rate limit before doing any heavy work
    rateLimitState = await checkMcpRateLimit(request);
    if (!rateLimitState.allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded. Try again shortly.' }),
        {
          status: 429,
          headers: {
            ...CORS_HEADERS,
            ...rateLimitHeaders(rateLimitState),
            'Content-Type': 'application/json',
            'Retry-After': String(MCP_RATE_WINDOW_SEC),
          },
        },
      );
    }

    let server;
    try {
      server = await createMcpServer();
    } catch (err) {
      console.error('[mcp] createMcpServer failed:', err);
      throw new Error(
        `MCP init failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode — no session tracking
      enableJsonResponse: true,      // JSON responses, no SSE streams
    });

    try {
      await server.connect(transport);
    } catch (err) {
      console.error('[mcp] server.connect failed:', err);
      throw new Error(
        `MCP transport connect failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let response: Response;
    try {
      response = await transport.handleRequest(request);
    } catch (err) {
      console.error('[mcp] transport.handleRequest threw:', err);
      // Try to close cleanly even if handleRequest blew up
      try {
        await transport.close();
      } catch (closeErr) {
        console.warn('[mcp] transport.close after handleRequest failure:', closeErr);
      }
      throw new Error(
        `MCP request handling failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      await transport.close();
    } catch (closeErr) {
      // Closing after a successful handleRequest shouldn't matter
      // for the response — log but don't fail.
      console.warn('[mcp] transport.close failed (non-fatal):', closeErr);
    }

    // Attach rate limit diagnostic headers to the success response.
    // The SDK builds the Response with a ReadableStream body which
    // can't be re-attached to a new Response without consuming it
    // first (the stream gets locked). So we read the body as text,
    // then construct a new Response with the merged headers and the
    // text body. enableJsonResponse:true means the body is always
    // a JSON string, so .text() is safe.
    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (textErr) {
      console.error('[mcp] failed to read response body for header attach:', textErr);
      // Bail out and return the original response without diagnostic
      // headers — better to lose the headers than break the response.
      return response;
    }
    const headersWithRateLimit = new Headers(response.headers);
    if (rateLimitState) {
      const rl = rateLimitHeaders(rateLimitState);
      for (const [k, v] of Object.entries(rl)) headersWithRateLimit.set(k, v);
    }
    const finalResponse = new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers: headersWithRateLimit,
    });

    // withStore wrapper guarantees store.flush() after this returns.
    return finalResponse;
  } catch (err) {
    // Last in-route catch — log + return JSON. The withStore wrapper
    // has another safety net for anything that escapes even this.
    console.error('[mcp] route handler catch:', err);
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    return new Response(
      JSON.stringify({
        error: message,
        ...(process.env.NODE_ENV !== 'production' && stack ? { stack } : {}),
      }),
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
