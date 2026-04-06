/**
 * POST /api/user/withdraw
 *
 * Self-serve withdrawal from the web dashboard. The user can only
 * withdraw their own funds — userId is auto-resolved from the
 * authenticated session's accountId.
 *
 * Reuses MultiUserAgent.processWithdrawal() which handles:
 *   - Reserve-before-spend
 *   - Velocity cap (per-user daily HBAR limit)
 *   - Per-user mutex (in-process) + Redis distributed lock (cross-Lambda)
 *   - On-chain transfer + ledger settlement
 *   - HCS-20 audit record
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
    // Withdrawal is sensitive — strict rate limit
    if (!(await checkRateLimit({ request, action: 'user-withdraw', limit: 5, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

    const auth = await requireTier(request, 'user');
    if (isErrorResponse(auth)) return auth;

    const body = (await request.json().catch(() => ({}))) as {
      amount?: number;
      token?: string;
    };

    if (typeof body.amount !== 'number' || body.amount <= 0) {
      return NextResponse.json(
        { error: 'Invalid amount — must be a positive number' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const token = body.token ?? 'hbar';

    // Resolve userId from authenticated accountId
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

    // Distributed lock with fence token (same pattern as multi_user_withdraw MCP tool)
    const lockToken = await acquireUserLock(user.userId);
    if (!lockToken) {
      return NextResponse.json(
        { error: 'Operation in progress for this user. Try again shortly.' },
        { status: 409, headers: CORS_HEADERS },
      );
    }

    try {
      const { multiUser } = await getAgentContext();
      const record = await multiUser.processWithdrawal(user.userId, body.amount, token);

      // Refresh user so the response carries the post-withdrawal balance
      await store.refreshUser(user.userId);
      const refreshed = store.getUser(user.userId);

      return NextResponse.json(
        {
          record,
          balances: refreshed?.balances ?? user.balances,
        },
        { headers: CORS_HEADERS },
      );
    } finally {
      await releaseUserLock(user.userId, lockToken);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 400, headers: CORS_HEADERS },
    );
  }
});
