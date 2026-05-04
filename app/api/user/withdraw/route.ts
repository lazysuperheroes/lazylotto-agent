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
import { withUserLock } from '../../_lib/locks';
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
    // F6: fail closed if the Redis circuit-breaker is open. Withdrawals
    // depend on the user lock, velocity cap, kill switch, and HCS-20
    // audit — every safety rail flows through Redis. Sustained Redis
    // failure means the velocity cap silently fails open (returns full
    // cap on every check), so the right move is to refuse the operation
    // until Redis recovers. Reads continue normally on other routes.
    assertRedisHealthy();

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

    // Capture narrowed const so the async closure inside withUserLock
    // sees a definitely-`number` rather than the original `number | undefined`.
    const amount = body.amount;
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

    // withUserLock: refresh local cache + apply pendingLedger debits
    // before the body, flush before releasing. Closes the
    // refund-then-withdraw double-spend window (refund queues debit,
    // next withdraw drains it before reading balance) and the lock-
    // released-before-flush double-spend window.
    const locked = await withUserLock(store, user.userId, async () => {
      const { multiUser } = await getAgentContext();
      const record = await multiUser.processWithdrawal(user.userId, amount, token);
      await store.refreshUser(user.userId);
      const refreshed = store.getUser(user.userId);
      return {
        record,
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
