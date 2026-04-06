import { NextResponse } from 'next/server';
import { createChallenge } from '~/auth/challenge';
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
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 400, headers: CORS_HEADERS },
    );
  }
}
