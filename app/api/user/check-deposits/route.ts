/**
 * POST /api/user/check-deposits
 *
 * Fires a mirror-node deposit poll for new incoming transactions to the
 * agent wallet. Returns how many deposits were processed and (if the
 * caller resolves to a registered user) the user's refreshed balance.
 *
 * This is called as a background fire-and-forget from the dashboard
 * client AFTER the initial status + history responses render. It takes
 * ~500-1000ms on a cold lambda (mirror node query) so we keep it off
 * the critical path.
 *
 * Uses the singleton MultiUserAgent's DepositWatcher so we don't race
 * with MCP-triggered polls (which share the same watermark in Redis).
 *
 * Requires 'user' tier auth.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getAgentContext } from '../../_lib/mcp';
import { withStore } from '../../_lib/withStore';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { composeBalanceResponse } from '../../_lib/composeBalances';

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
    // Check-deposits hits the mirror node — limit to a reasonable
    // background refresh rate (don't let a misbehaving client hammer it)
    if (!(await checkRateLimit({ request, action: 'check-deposits', limit: 12, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

    const auth = await requireTier(request, 'user');
    if (isErrorResponse(auth)) return auth;

    const { multiUser, store } = await getAgentContext();

    // Poll via the shared singleton watcher — prevents racing with
    // MCP-tool-triggered polls on the same warm Lambda.
    const processed = await multiUser.pollDepositsOnce();

    // Refresh index so a freshly-registered user is resolvable
    await store.refreshUserIndex();

    let user = store.getUserByAccountId(auth.accountId);
    if (!user) {
      const allUsers = store.getAllUsers();
      user = allUsers.find(
        (u) => u.eoaAddress.toLowerCase() === auth.accountId.toLowerCase(),
      );
    }

    if (user) {
      await store.refreshUser(user.userId);
      user = store.getUser(user.userId) ?? user;
    }

    // R11-FG-3 / Phase-9 Cluster C: pre-subtract pending-ledger
    // adjustments via the shared helper. Pre-Phase-9 this route
    // returned RAW user.balances; the dashboard merges that into
    // `setStatus({...prev, balances: data.balances})` (page.tsx:415-423),
    // overwriting the pre-subtracted view from /api/user/status.
    // Result: phantom-funds view returned every time deposit-check
    // ran. Same archetype as R10-FG-2 across a sibling route.
    let responseBalances = user?.balances ?? null;
    let pendingAdjustments: Awaited<ReturnType<typeof composeBalanceResponse>>['pendingAdjustments'] = [];
    if (user) {
      const composed = await composeBalanceResponse(user);
      responseBalances = composed.responseBalances;
      pendingAdjustments = composed.pendingAdjustments;
    }

    // withStore guarantees flush() after this returns.
    return NextResponse.json(
      {
        processed,
        balances: responseBalances,
        pendingAdjustments,
        lastPlayedAt: user?.lastPlayedAt ?? null,
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
});
