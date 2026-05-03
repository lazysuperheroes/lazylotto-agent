/**
 * /api/admin/killswitch
 *
 * Emergency freeze for write-path operations. When engaged, new plays
 * and new registrations are refused; withdrawals and reads stay working.
 *
 * GET    — read current state (enabled/disabled + reason + metadata)
 * POST   — engage with { reason: string }
 * DELETE — disengage
 *
 * Requires 'admin' tier auth. (Was 'operator' originally — but the
 * 'operator' tier is only granted to MCP_AUTH_TOKEN bearers via the
 * shared-secret middleware path. WalletConnect users top out at
 * 'admin' tier (when their accountId is in ADMIN_ACCOUNTS), and the
 * admin page UI is the primary surface for engaging the kill switch
 * during an incident. Locking it to operator made the kill switch
 * unreachable from the web UI.)
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import {
  getKillSwitchState,
  enableKillSwitch,
  disableKillSwitch,
} from '~/lib/killswitch';
import { getAgentContext } from '../../_lib/mcp';
import { withStore } from '../../_lib/withStore';

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

// withStore wraps all three verbs so the F3 production-Redis preflight,
// store flush, and last-resort error catch fire uniformly. The kill
// switch is the most important admin tool — any operator hitting a
// misconfigured deploy must get the same `PRODUCTION_REDIS_REQUIRED`
// 503 they get on every other route, not a route-local 500.

export const GET = withStore(async (request: Request) => {
  const auth = await requireTier(request, 'admin');
  if (isErrorResponse(auth)) return auth;

  const state = await getKillSwitchState();
  return NextResponse.json(state, { headers: CORS_HEADERS });
});

export const POST = withStore(async (request: Request) => {
  try {
    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    const body = (await request.json().catch(() => ({}))) as {
      reason?: string;
    };
    const reason = (body.reason ?? '').trim();
    if (!reason) {
      return NextResponse.json(
        { error: 'Missing required field: reason' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    await enableKillSwitch(reason, auth.accountId);

    // Emit an on-chain audit anchor so the HCS-20 trail shows the
    // incident. Best-effort — if the accounting service is down we
    // still flip the flag (users safety > audit completeness).
    try {
      const { multiUser } = await getAgentContext();
      await multiUser.recordControlEvent('killswitch_enabled', {
        reason,
        by: auth.accountId,
      });
    } catch (auditErr) {
      console.warn('[killswitch] HCS-20 audit write failed:', auditErr);
    }

    const state = await getKillSwitchState();
    return NextResponse.json(state, { headers: CORS_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: CORS_HEADERS },
    );
  }
});

export const DELETE = withStore(async (request: Request) => {
  try {
    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    await disableKillSwitch(auth.accountId);

    // Mirror the enable event on HCS-20 so the audit trail shows
    // when the incident was resolved.
    try {
      const { multiUser } = await getAgentContext();
      await multiUser.recordControlEvent('killswitch_disabled', {
        by: auth.accountId,
      });
    } catch (auditErr) {
      console.warn('[killswitch] HCS-20 audit write failed:', auditErr);
    }

    return NextResponse.json({ enabled: false }, { headers: CORS_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: CORS_HEADERS },
    );
  }
});
