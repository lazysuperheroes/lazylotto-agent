/**
 * POST /api/user/register
 *
 * Self-serve user registration from the web dashboard. Creates a new
 * UserAccount keyed by the authenticated session's accountId, returns
 * the deposit memo + agent wallet address so the user can fund.
 *
 * If the account is already registered, returns the existing record
 * (idempotent — same as the multi_user_register MCP tool's dedup).
 *
 * Requires 'user' tier auth.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getStore } from '../../_lib/store';
import { withStore } from '../../_lib/withStore';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { registerUserOp } from '~/services/userOps';
import { getAgentContext } from '../../_lib/mcp';
import { getClient } from '../../_lib/hedera';
import { getOperatorAccountId } from '~/hedera/wallet';
import { withChecksum } from '~/utils/checksum';
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
    if (!(await checkRateLimit({ request, action: 'user-register', limit: 5, windowSec: 300 }))) {
      return rateLimitResponse(300);
    }

    const auth = await requireTier(request, 'user');
    if (isErrorResponse(auth)) return auth;

    const body = (await request.json().catch(() => ({}))) as {
      eoaAddress?: string;
      strategy?: 'conservative' | 'balanced' | 'aggressive';
    };

    // 0.3.4: delegate to userOps.registerUserOp. EOA-ownership check,
    // format validation, and dedup all live in the service layer.
    const store = await getStore();
    const { multiUser } = await getAgentContext();
    const agentWallet = withChecksum(getOperatorAccountId(getClient()));

    const opResult = await registerUserOp(
      { store, multiUser },
      {
        authAccountId: auth.accountId,
        authTier: 'user',
        eoaAddress: body.eoaAddress,
        strategy: body.strategy,
        agentWallet,
      },
    );
    switch (opResult.kind) {
      case 'access_denied':
        return NextResponse.json(
          { error: opResult.reason },
          { status: 403, headers: CORS_HEADERS },
        );
      case 'invalid_input':
        return NextResponse.json(
          { error: opResult.reason },
          { status: 400, headers: CORS_HEADERS },
        );
      case 'duplicate':
      case 'ok':
        return NextResponse.json(opResult.result, { headers: CORS_HEADERS });
      // register doesn't use locks/idempotency today; these aren't reachable
      case 'lock_held':
      case 'in_flight':
      case 'not_found':
        return NextResponse.json(
          { error: 'reason' in opResult ? opResult.reason : 'Unexpected state' },
          { status: 500, headers: CORS_HEADERS },
        );
    }
  } catch (err) {
    // Kill switch translates to 503 + reason so the frontend can show
    // the "Agent temporarily closed" banner cleanly instead of a 500.
    if (err instanceof KillSwitchError) {
      return NextResponse.json(
        { error: err.message, reason: (err as KillSwitchError).reason ?? null },
        { status: 503, headers: CORS_HEADERS },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
});
