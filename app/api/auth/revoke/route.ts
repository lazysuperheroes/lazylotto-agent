import { NextResponse } from 'next/server';
import { destroySession } from '~/auth/session';
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

// withStore: F3 production-Redis preflight + uniform diagnostic shape.
export const POST = withStore(async (request: Request) => {
  try {
    // Rate limit: 10 revokes per identity per minute
    if (!(await checkRateLimit({ request, action: 'revoke', limit: 10, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

    const body = await request.json();
    const { sessionToken } = body as { sessionToken?: string };

    if (!sessionToken) {
      return NextResponse.json(
        { error: 'Missing sessionToken' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    await destroySession(sessionToken);

    return NextResponse.json(
      { revoked: true },
      { headers: CORS_HEADERS },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
});
