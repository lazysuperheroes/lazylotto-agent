import { NextResponse } from 'next/server';
import { destroySession } from '~/auth/session';

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
}
