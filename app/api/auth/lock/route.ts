import { NextResponse } from 'next/server';
import { lockSession } from '~/auth/session';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { staticCorsHeaders } from '../../_lib/cors';

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

export async function POST(request: Request) {
  try {
    // Rate limit: 5 lock attempts per identity per minute
    if (!(await checkRateLimit({ request, action: 'lock', limit: 5, windowSec: 60 }))) {
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

    const locked = await lockSession(sessionToken);

    if (!locked) {
      return NextResponse.json(
        { error: 'Invalid or expired session' },
        { status: 401, headers: CORS_HEADERS },
      );
    }

    return NextResponse.json(
      { locked: true },
      { headers: CORS_HEADERS },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
