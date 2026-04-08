/**
 * POST /api/user/strategy
 *
 * Self-serve strategy switcher. Lets a registered user change their
 * play strategy preset (conservative | balanced | aggressive)
 * without re-registering. The new strategy snapshot is loaded
 * server-side and persisted to the user's record. Takes effect on
 * the next play session.
 *
 * The user can ONLY update their own strategy — the userId is
 * resolved from the authenticated session's accountId, so the
 * request body doesn't need (and can't override) it.
 *
 * Requires 'user' tier auth.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getStore } from '../../_lib/store';
import { withStore } from '../../_lib/withStore';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { getAgentContext } from '../../_lib/mcp';
import { KillSwitchError } from '~/lib/killswitch';

const VALID_STRATEGIES = ['conservative', 'balanced', 'aggressive'] as const;
type ValidStrategy = (typeof VALID_STRATEGIES)[number];

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
    // Tighter rate limit than play because changing strategy
    // shouldn't be a hot-loop operation. 10 per 5 minutes.
    if (
      !(await checkRateLimit({ request, action: 'user-strategy', limit: 10, windowSec: 300 }))
    ) {
      return rateLimitResponse(300);
    }

    const auth = await requireTier(request, 'user');
    if (isErrorResponse(auth)) return auth;

    const body = (await request.json().catch(() => ({}))) as { strategy?: string };
    const strategy = body.strategy?.toLowerCase() as ValidStrategy | undefined;
    if (!strategy || !VALID_STRATEGIES.includes(strategy)) {
      return NextResponse.json(
        {
          error: `Invalid strategy. Must be one of: ${VALID_STRATEGIES.join(', ')}`,
        },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const store = await getStore();
    await store.refreshUserIndex();

    // Resolve userId from authenticated accountId — same pattern
    // as /api/user/play and /api/user/withdraw. Users can only
    // update their own strategy.
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
    if (!user.active) {
      return NextResponse.json(
        { error: 'User is deregistered. Strategy cannot be changed.' },
        { status: 403, headers: CORS_HEADERS },
      );
    }

    // No-op if already on this strategy — return the user record
    // unchanged. Idempotent.
    if (user.strategyName === strategy) {
      return NextResponse.json(
        {
          status: 'unchanged',
          userId: user.userId,
          strategyName: user.strategyName,
          strategyVersion: user.strategyVersion,
        },
        { headers: CORS_HEADERS },
      );
    }

    const { multiUser } = await getAgentContext();
    const updated = await multiUser.updateUserStrategy(user.userId, strategy);

    return NextResponse.json(
      {
        status: 'updated',
        userId: updated.userId,
        strategyName: updated.strategyName,
        strategyVersion: updated.strategyVersion,
        previousStrategy: user.strategyName,
      },
      { headers: CORS_HEADERS },
    );
  } catch (err) {
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
