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
import { withStore } from '../../_lib/withStore';
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

// withStore wrapper: any error escaping the inner try/catch (or thrown
// by a promise we forgot to await) gets logged to Vercel via
// console.error with a full stack and returned as JSON instead of
// Vercel's generic HTML /500 page. That's load-bearing for diagnosing
// the "a bunch of 500s on /api/user/history" report — without the
// wrapper, we only see the status code in the client network tab.
export const GET = withStore(async (request: Request) => {
  try {
    if (!(await checkRateLimit({ request, action: 'user-history', limit: 60, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

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
    // Wrapped in its own try so a transient Redis blip doesn't nuke
    // the whole response — we'd rather return stale-cached sessions
    // than fail the entire dashboard history load.
    try {
      await store.refreshPlaysForUser(user.userId);
    } catch (refreshErr) {
      console.warn(
        '[user/history] refreshPlaysForUser failed, serving cached sessions:',
        refreshErr instanceof Error ? refreshErr.stack ?? refreshErr.message : refreshErr,
      );
    }

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
    // Log the FULL stack so Vercel logs are diagnosable. The previous
    // version only returned `err.message` in the JSON body — fine for
    // known error types, useless for "what the hell is going wrong"
    // intermittent failures. console.error shows up in Vercel's
    // function log stream so operators can grep by route path.
    console.error('[user/history] GET failed:', err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
});
