/**
 * GET /api/admin/dead-letters
 *
 * Returns all dead-letter entries — deposit transactions that failed
 * processing and could not be credited to any user account.
 * Requires 'admin' tier auth.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getStore } from '../../_lib/store';

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function GET(request: Request) {
  try {
    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    const store = await getStore();
    const deadLetters = store.getDeadLetters();

    return NextResponse.json(
      { deadLetters, count: deadLetters.length },
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
