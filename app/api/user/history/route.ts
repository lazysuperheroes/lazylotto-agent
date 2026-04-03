/**
 * GET /api/user/history
 *
 * Returns the authenticated user's play session history (most recent 20).
 * Requires 'user' tier auth.
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
    const auth = await requireTier(request, 'user');
    if (isErrorResponse(auth)) return auth;

    const store = await getStore();
    const accountId = auth.accountId;

    // Resolve userId from accountId
    let user = store.getUserByAccountId(accountId);

    if (!user) {
      const allUsers = store.getAllUsers();
      user = allUsers.find(
        (u) =>
          u.eoaAddress.toLowerCase() === accountId.toLowerCase(),
      );
    }

    if (!user) {
      return NextResponse.json(
        { error: 'User not found for this account' },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    // Get play sessions for this user, return the most recent 20
    const sessions = store.getPlaySessionsForUser(user.userId);
    const recent = sessions.slice(-20).reverse();

    return NextResponse.json(
      { userId: user.userId, sessions: recent },
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
