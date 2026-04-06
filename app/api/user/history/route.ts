/**
 * GET /api/user/history
 *
 * Returns the authenticated user's play session history (most recent 20).
 * Fast path: reads directly from the store, no NFT enrichment.
 *
 * Prize NFT enrichment (image, verification badge, niceName) is lazy —
 * the dashboard calls /api/user/enrich-nfts in the background after
 * rendering the raw history.
 *
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

    // Refresh only the user index so we can resolve accountId → userId.
    await store.refreshUserIndex();

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

    // Refresh just this user's plays from Redis so we see recent sessions.
    await store.refreshPlaysForUser(user.userId);

    // Get play sessions for this user, return the most recent 20.
    // Raw prizeDetails (including captured { token, hederaId, serial } refs)
    // are passed through untouched — the client lazily calls enrich-nfts.
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
