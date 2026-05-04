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
import { withUserLock } from '../../_lib/locks';
import { KillSwitchError } from '~/lib/killswitch';
import { assertRedisHealthy, RedisDegradedError } from '~/lib/redisHealth';

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
    // F6: fail closed if the Redis circuit-breaker is open. Plays touch
    // the user lock, kill switch, rate limiter, and HCS-20 audit trail —
    // ALL of which depend on Redis. Sustained Redis failure means our
    // safety guarantees are degraded; better to surface a clear 503 than
    // run with safety rails silently disabled.
    assertRedisHealthy();

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

    const { multiUser } = await getAgentContext();

    // Pick up any pending deposits BEFORE acquiring the user lock so
    // creditDeposit (which now acquires the same per-user lock for its
    // balance update) doesn't deadlock against our own play handler.
    // The fresh credit will be visible to the play via withUserLock's
    // mandatory `refreshUser` step. Non-critical: failure here just
    // means the play runs against whatever balance was already credited.
    try {
      await multiUser.pollDepositsOnce();
    } catch {
      /* proceed with whatever balance we have */
    }

    // withUserLock closes three exposures the raw acquire/release pair
    // had: stale local cache after lock acquire, pending-ledger debits
    // not applied before the body runs, and lock release before flush
    // completes. See `src/lib/locks.ts:withUserLock` JSDoc.
    const locked = await withUserLock(store, user.userId, async () => {
      const session = await multiUser.playForUser(user.userId);
      // Refresh after the play so the response carries the
      // post-session balance.
      await store.refreshUser(user.userId);
      const refreshed = store.getUser(user.userId);
      return {
        session,
        balances: refreshed?.balances ?? user.balances,
      };
    });

    if ('lockHeld' in locked) {
      return NextResponse.json(
        { error: 'Operation in progress for this user. Try again shortly.' },
        { status: 409, headers: CORS_HEADERS },
      );
    }

    return NextResponse.json(locked.result, { headers: CORS_HEADERS });
  } catch (err) {
    // Kill switch — translate to 503 + reason so the dashboard banner
    // can render the "Agent temporarily closed" state cleanly.
    if (err instanceof KillSwitchError) {
      return NextResponse.json(
        { error: err.message, reason: err.reason ?? null },
        { status: 503, headers: CORS_HEADERS },
      );
    }
    // F6: Redis breaker open → service-degraded 503. Same shape as
    // kill switch so the dashboard's "agent temporarily unavailable"
    // banner picks it up uniformly.
    if (err instanceof RedisDegradedError) {
      return NextResponse.json(
        { error: err.message, reason: 'redis_degraded' },
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
