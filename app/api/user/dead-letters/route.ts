/**
 * GET /api/user/dead-letters
 *
 * Returns dead-letter entries (deposits that failed to process) where
 * the sender matches the authenticated user's accountId. Lets users
 * find their stuck deposits without operator intervention.
 *
 * Requires 'user' tier auth.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getStore } from '../../_lib/store';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';

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
    if (!(await checkRateLimit({ request, action: 'user-deadletters', limit: 30, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

    const auth = await requireTier(request, 'user');
    if (isErrorResponse(auth)) return auth;

    const store = await getStore();
    await store.refreshDeadLetters();

    const all = store.getDeadLetters();
    // Filter to entries where the sender matches this user.
    // Old entries without a sender field are not returned (operator-only).
    const mine = all.filter((dl) => dl.sender === auth.accountId);

    return NextResponse.json(
      {
        deadLetters: mine,
        count: mine.length,
      },
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
