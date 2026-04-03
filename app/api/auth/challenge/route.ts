import { NextResponse } from 'next/server';
import { createChallenge } from '~/auth/challenge';

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
