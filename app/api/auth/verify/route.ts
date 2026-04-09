import { NextResponse } from 'next/server';
import { verifyChallenge } from '~/auth/verify';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { staticCorsHeaders } from '../../_lib/cors';
import { withStore } from '../../_lib/withStore';

const CORS_HEADERS = staticCorsHeaders('POST, OPTIONS');

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

// withStore: sibling of the challenge route. If verifyChallenge
// throws anything the inner catch doesn't cover, we get a JSON
// body with the stack instead of Vercel's generic HTML /500 page
// — critical for the auth flow since a broken /verify leaves the
// user staring at an opaque error wall.
export const POST = withStore(async (request: Request) => {
  try {
    // Rate limit: 5 verify attempts per IP per 5 minutes
    if (!(await checkRateLimit({ request, action: 'verify', limit: 5, windowSec: 300 }))) {
      return rateLimitResponse(300);
    }

    const body = await request.json();
    const { challengeId, accountId, signatureMapBase64 } = body as {
      challengeId?: string;
      accountId?: string;
      signatureMapBase64?: string;
    };

    if (!challengeId || !accountId || !signatureMapBase64) {
      return NextResponse.json(
        { error: 'Missing required fields: challengeId, accountId, signatureMapBase64' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const result = await verifyChallenge(challengeId, accountId, signatureMapBase64);

    const origin = new URL(request.url).origin;
    const mcpUrl = process.env.AGENT_MCP_URL ?? `${origin}/api/mcp`;

    return NextResponse.json(
      { ...result, mcpUrl },
      { headers: CORS_HEADERS },
    );
  } catch (err) {
    console.error('[auth/verify] POST failed:', err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 400, headers: CORS_HEADERS },
    );
  }
});
