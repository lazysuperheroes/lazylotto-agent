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
import { withdrawForUser } from '~/services/userOps';
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

    // R5-FG-31 (P7-002): authenticate first, then rate-limit by
    // accountId so token rotation can't defeat the cap.
    const auth = await requireTier(request, 'user');
    if (isErrorResponse(auth)) return auth;

    // Withdrawal is sensitive — strict rate limit
    if (
      !(await checkRateLimit({
        request,
        action: 'user-withdraw',
        limit: 5,
        windowSec: 60,
        identity: auth.accountId,
      }))
    ) {
      return rateLimitResponse(60);
    }

    const body = (await request.json().catch(() => ({}))) as {
      amount?: number;
      token?: string;
    };

    // 0.3.4 hardening: explicit Number.isFinite + max bound. Pre-fix
    // the check `typeof body.amount !== 'number' || body.amount <= 0`
    // accepted NaN (typeof number, NaN <= 0 === false) and Infinity
    // (passes both). Both reached `transferHbar(client, ..., NaN)` /
    // `Hbar(NaN)` which throws inside the SDK — reliable DoS vector
    // that bypasses the velocity cap (cap math relies on isFinite).
    // Cap also at 1e9 to reject anything that smells like an
    // overflow / typo / scale-error.
    if (
      typeof body.amount !== 'number' ||
      !Number.isFinite(body.amount) ||
      body.amount <= 0 ||
      body.amount > 1e9
    ) {
      return NextResponse.json(
        { error: 'Invalid amount — must be a finite positive number under 1e9' },
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

    // 0.3.4: delegate to userOps.withdrawForUser. Single canonical
    // mutation entry point shared with multi_user_withdraw MCP tool.
    // userOps handles input validation (NaN/Infinity), withIdempotency
    // (Idempotency-Key header), withUserLock (refresh + drain + flush),
    // and the LockHeldError sentinel that prevents lockHeld from being
    // cached as an idempotency duplicate.
    const idempotencyKey = request.headers.get('Idempotency-Key');
    const { multiUser } = await getAgentContext();
    const opResult = await withdrawForUser(
      { store, multiUser },
      { userId: user.userId, amount, token, idempotencyKey },
    );
    switch (opResult.kind) {
      case 'lock_held':
        return NextResponse.json(
          { error: 'Operation in progress for this user. Try again shortly.' },
          { status: 409, headers: CORS_HEADERS },
        );
      case 'in_flight':
        return NextResponse.json(
          { error: 'A previous request with this Idempotency-Key is still in progress. Retry shortly.' },
          { status: 409, headers: CORS_HEADERS },
        );
      case 'invalid_input':
        return NextResponse.json(
          { error: opResult.reason },
          { status: 400, headers: CORS_HEADERS },
        );
      case 'not_found':
        return NextResponse.json(
          { error: opResult.reason ?? 'User not found' },
          { status: 404, headers: CORS_HEADERS },
        );
      case 'access_denied':
        return NextResponse.json(
          { error: opResult.reason },
          { status: 403, headers: CORS_HEADERS },
        );
      case 'duplicate':
      case 'ok': {
        await store.refreshUser(user.userId);
        const refreshed = store.getUser(user.userId);
        const responseHeaders: Record<string, string> = { ...CORS_HEADERS };
        if (opResult.kind === 'duplicate') {
          responseHeaders['X-Idempotent-Replayed'] = 'true';
        }
        return NextResponse.json(
          {
            record: opResult.result,
            balances: refreshed?.balances ?? user.balances,
          },
          { headers: responseHeaders },
        );
      }
    }
  } catch (err) {
    if (err instanceof RedisDegradedError) {
      return NextResponse.json(
        { error: err.message, reason: 'redis_degraded' },
        { status: 503, headers: CORS_HEADERS },
      );
    }
    // 0.3.3: velocity-check Redis failure surfaces as a sentinel
    // error message from MultiUserAgent.checkWithdrawalVelocity. Map
    // to 503 redis_degraded so the dashboard's "agent temporarily
    // unavailable" banner picks it up uniformly.
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('velocity_check_unavailable')) {
      return NextResponse.json(
        { error: message, reason: 'redis_degraded' },
        { status: 503, headers: CORS_HEADERS },
      );
    }
    return NextResponse.json(
      { error: message },
      { status: 400, headers: CORS_HEADERS },
    );
  }
});
