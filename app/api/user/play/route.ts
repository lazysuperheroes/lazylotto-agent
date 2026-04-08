/**
 * POST /api/user/play
 *
 * Self-serve play session trigger from the web dashboard. The user can
 * only play for their own userId — resolved from the authenticated
 * session's accountId.
 *
 * Delegates to MultiUserAgent.playForUser() which:
 *   - Gates on the kill switch (domain-layer check)
 *   - Acquires the per-user mutex
 *   - Runs the strategy engine + six-phase play loop
 *   - Records the session + HCS-20 audit entry
 *
 * Rate limited at 3 per 60 seconds per identity to stop a user from
 * hammering the agent wallet with back-to-back sessions.
 *
 * Requires 'user' tier auth.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getStore } from '../../_lib/store';
import { withStore } from '../../_lib/withStore';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { getAgentContext } from '../../_lib/mcp';
import { acquireUserLock, releaseUserLock } from '../../_lib/locks';
import { KillSwitchError } from '~/lib/killswitch';

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

export const POST = withStore(async (request: Request) => {
  try {
    // Stricter than general user routes — plays cost HBAR and touch
    // the dApp contracts, so cap to 3 per minute per identity.
    if (!(await checkRateLimit({ request, action: 'user-play', limit: 3, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

    const auth = await requireTier(request, 'user');
    if (isErrorResponse(auth)) return auth;

    // Resolve userId from authenticated accountId (same pattern as withdraw)
    const store = await getStore();
    await store.refreshUserIndex();
    let user = store.getUserByAccountId(auth.accountId);
    if (!user) {
      const allUsers = store.getAllUsers();
      user = allUsers.find(
        (u) => u.eoaAddress.toLowerCase() === auth.accountId.toLowerCase(),
      );
    }
    if (!user) {
      return NextResponse.json(
        { error: 'User not found for this account. Register first.' },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    // Distributed lock so two concurrent /api/user/play calls (or a
    // play + withdraw) can't interleave on the same user. Acquired
    // BEFORE the deposit poll so two racing plays can't both poll
    // (and each see the deposit, leading to duplicate work) — only
    // the lock holder runs the critical section.
    const lockToken = await acquireUserLock(user.userId);
    if (!lockToken) {
      return NextResponse.json(
        { error: 'Operation in progress for this user. Try again shortly.' },
        { status: 409, headers: CORS_HEADERS },
      );
    }

    try {
      // Single getAgentContext() call for the whole critical section.
      // The previous version called it twice (once for the unlocked
      // poll, once for play) — same cached context, but sloppy and
      // forced ordering implications. One call, one binding.
      const { multiUser } = await getAgentContext();

      // Pick up any pending deposits before playing — the user might
      // have just funded and hit Play, and we want that balance to count.
      // Non-critical: failure here just means the play runs against
      // whatever balance was already credited.
      try {
        await multiUser.pollDepositsOnce();
      } catch {
        /* proceed with whatever balance we have */
      }

      const session = await multiUser.playForUser(user.userId);

      // Refresh user so the response carries the post-session balance
      await store.refreshUser(user.userId);
      const refreshed = store.getUser(user.userId);

      return NextResponse.json(
        {
          session,
          balances: refreshed?.balances ?? user.balances,
        },
        { headers: CORS_HEADERS },
      );
    } finally {
      await releaseUserLock(user.userId, lockToken);
    }
  } catch (err) {
    // Kill switch — translate to 503 + reason so the dashboard banner
    // can render the "Agent temporarily closed" state cleanly.
    if (err instanceof KillSwitchError) {
      return NextResponse.json(
        { error: err.message, reason: err.reason ?? null },
        { status: 503, headers: CORS_HEADERS },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 400, headers: CORS_HEADERS },
    );
  }
});
