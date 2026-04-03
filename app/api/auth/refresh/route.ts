import { NextResponse } from 'next/server';
import { refreshSession } from '~/auth/session';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.AUTH_PAGE_ORIGIN ?? '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { sessionToken } = body as { sessionToken?: string };

    if (!sessionToken) {
      return NextResponse.json(
        { error: 'Missing sessionToken' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const result = await refreshSession(sessionToken);

    if (!result) {
      return NextResponse.json(
        { error: 'Invalid or expired session' },
        { status: 401, headers: CORS_HEADERS },
      );
    }

    return NextResponse.json(
      { sessionToken: result.token, expiresAt: result.expiresAt },
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
