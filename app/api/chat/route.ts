/**
 * AI Chat endpoint (opt-in, Hedera Agent Kit backed).
 *
 * POST /api/chat — streams an assistant response. Disabled by default:
 * when CHAT_ENABLED !== 'true' this returns 404 and the heavy Agent Kit /
 * AI SDK module graph is never imported (the handler is dynamic-imported
 * only on the enabled path).
 *
 * Auth + rate limiting mirror the A2A route: a Bearer session token is
 * required and threaded into every tool call; the rate-limit identity is a
 * hash of that token (R5-FG-72).
 */

import { NextResponse } from 'next/server';
import { withStore } from '../_lib/withStore';
import { staticCorsHeaders } from '../_lib/cors';
import { checkRateLimit, rateLimitResponse } from '../_lib/rateLimit';
import { loadFeatureConfig } from '~/config/features';

// Chat turns can fan out into several tool calls (each an HTTP round-trip to
// /api/mcp) plus model latency. Match the MCP/A2A timeout.
export const maxDuration = 60;
// The Agent Kit + Hedera SDK need Node APIs — never Edge.
export const runtime = 'nodejs';

const CORS_HEADERS = staticCorsHeaders('GET, POST, OPTIONS');

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
  });
}

export const POST = withStore(async (request: Request) => {
  const cfg = loadFeatureConfig();
  if (!cfg.chat.enabled) {
    return NextResponse.json(
      { error: 'Chat is not enabled.' },
      { status: 404, headers: CORS_HEADERS },
    );
  }

  const authHeader = request.headers.get('authorization');
  const authToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : undefined;
  if (!authToken) {
    return NextResponse.json(
      { error: 'Authorization required (Bearer session token).' },
      { status: 401, headers: CORS_HEADERS },
    );
  }

  const { createHash } = await import('node:crypto');
  const rlIdentity = `chat:${createHash('sha256')
    .update(authToken)
    .digest('hex')
    .slice(0, 16)}`;

  // Burst cap: 30 messages/min per identity.
  if (
    !(await checkRateLimit({
      request,
      action: 'chat',
      limit: 30,
      windowSec: 60,
      identity: rlIdentity,
    }))
  ) {
    return rateLimitResponse(60);
  }

  // Volume cap: bound total messages per identity per rolling 24h so nobody can
  // burn credits on a flood of (esp. off-topic) requests. Config-driven.
  if (
    !(await checkRateLimit({
      request,
      action: 'chat-daily',
      limit: cfg.chat.dailyMessageLimit,
      windowSec: 86_400,
      identity: rlIdentity,
    }))
  ) {
    return NextResponse.json(
      {
        error: `Daily chat limit reached (${cfg.chat.dailyMessageLimit} messages). Try again tomorrow.`,
      },
      { status: 429, headers: { ...CORS_HEADERS, 'Retry-After': '3600' } },
    );
  }

  // Dynamic import keeps the kit + AI SDK out of the cold path when chat is off.
  const { handleChat } = await import('./_handler');
  return handleChat(request, authToken);
});
