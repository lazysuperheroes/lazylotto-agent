import { NextResponse } from 'next/server';
import { createChallenge } from '~/auth/challenge';
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

// withStore wrapper: when something escapes the inner try/catch (e.g.
// createChallenge throws inside a code path the catch doesn't cover,
// or a module-level import blows up), we get a JSON error body with
// the stack instead of Vercel's generic HTML /500 page. The user saw
// the HTML wall when signing in from a new device — that's the exact
// scenario this guard exists for.
export const POST = withStore(async (request: Request) => {
  try {
    // Rate limit: 10 challenges per IP per 5 minutes
    if (!(await checkRateLimit({ request, action: 'challenge', limit: 10, windowSec: 300 }))) {
      return rateLimitResponse(300);
    }

    const body = await request.json();
    const { accountId } = body as { accountId?: string };

    if (!accountId || !/^\d+\.\d+\.\d+$/.test(accountId)) {
      return NextResponse.json(
        { error: 'Invalid accountId format. Expected 0.0.XXXXX' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const result = await createChallenge(accountId);
    return NextResponse.json(result, { headers: CORS_HEADERS });
  } catch (err) {
    // Log the full stack to Vercel logs so operators can diagnose.
    // Challenge failures in production are rare but critical — if
    // auth is broken, nothing else matters. A parseable error body
    // with the reason beats the generic "A server error occurred".
    console.error('[auth/challenge] POST failed:', err);
    const message = err instanceof Error ? err.message : String(err);
    // Surface mirror-node failures as 503 (upstream unavailable)
    // so the client can retry, and genuine bad inputs as 400.
    const isUpstream =
      message.includes('mirror') ||
      message.includes('fetch') ||
      message.includes('ECONN') ||
      message.includes('ETIMEDOUT');
    return NextResponse.json(
      {
        error: message,
        reason: isUpstream
          ? 'The Hedera mirror node timed out. Please try again in a moment.'
          : undefined,
      },
      { status: isUpstream ? 503 : 400, headers: CORS_HEADERS },
    );
  }
});
