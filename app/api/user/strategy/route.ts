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
import { setStrategyForUser } from '~/services/userOps';
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
    // R5-FG-31 (P7-002): authenticate first, then rate-limit by
    // accountId so token rotation can't defeat the cap.
    const auth = await requireTier(request, 'user');
    if (isErrorResponse(auth)) return auth;

    // Tighter rate limit than play because changing strategy
    // shouldn't be a hot-loop operation. 10 per 5 minutes.
    if (
      !(await checkRateLimit({
        request,
        action: 'user-strategy',
        limit: 10,
        windowSec: 300,
        identity: auth.accountId,
      }))
    ) {
      return rateLimitResponse(300);
    }

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

    // 0.3.4: delegate to userOps.setStrategyForUser. The "unchanged"
    // fast-path moves INSIDE the lock so it runs against canonical
    // post-refresh state instead of stale local cache. Active-user
    // check stays here (route-level UX) — service layer handles the
    // wrapping.
    const { multiUser } = await getAgentContext();
    const opResult = await setStrategyForUser(
      { store, multiUser },
      { userId: user.userId, strategy, performedBy: 'user' },
    );
    switch (opResult.kind) {
      case 'lock_held':
        return NextResponse.json(
          { error: 'Operation in progress for this user. Try again shortly.' },
          { status: 409, headers: CORS_HEADERS },
        );
      case 'invalid_input':
        return NextResponse.json(
          { error: opResult.reason },
          { status: 400, headers: CORS_HEADERS },
        );
      case 'access_denied':
        return NextResponse.json(
          { error: opResult.reason },
          { status: 403, headers: CORS_HEADERS },
        );
      case 'not_found':
        return NextResponse.json(
          { error: opResult.reason ?? 'User not found' },
          { status: 404, headers: CORS_HEADERS },
        );
      case 'in_flight':
        return NextResponse.json(
          { error: 'A previous strategy update is still in progress.' },
          { status: 409, headers: CORS_HEADERS },
        );
      case 'duplicate':
      case 'ok':
        return NextResponse.json(opResult.result, { headers: CORS_HEADERS });
    }
  } catch (err) {
    if (err instanceof KillSwitchError) {
      // R5-FG-33: sanitize 503 — drop operator reason. See user/play.
      return NextResponse.json(
        { error: 'Agent operations temporarily paused by operator.', reason: null },
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
