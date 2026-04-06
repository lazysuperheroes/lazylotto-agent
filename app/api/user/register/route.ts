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
import { getAgentContext } from '../../_lib/mcp';
import { getClient } from '../../_lib/hedera';
import { getOperatorAccountId } from '~/hedera/wallet';
import { withChecksum } from '~/utils/checksum';

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

    // Default the EOA to the authenticated account if not provided
    const eoaAddress = body.eoaAddress ?? auth.accountId;
    const strategy = body.strategy ?? 'balanced';

    if (!/^(0\.0\.\d+|0x[0-9a-fA-F]{40})$/.test(eoaAddress)) {
      return NextResponse.json(
        { error: 'Invalid eoaAddress format. Expected 0.0.X or 0x...' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const store = await getStore();
    await store.refreshUserIndex();

    // Dedup: if this account is already registered, return existing
    const existing = store.getUserByAccountId(auth.accountId);
    if (existing) {
      const agentWallet = withChecksum(getOperatorAccountId(getClient()));
      return NextResponse.json(
        {
          status: 'already_registered',
          userId: existing.userId,
          strategy: existing.strategyName,
          rakePercent: existing.rakePercent,
          agentWallet,
          depositMemo: existing.depositMemo,
        },
        { headers: CORS_HEADERS },
      );
    }

    // Create the user via the MultiUserAgent (it handles strategy snapshot,
    // memo generation, HCS-20 mint announcement, etc.)
    const { multiUser } = await getAgentContext();
    const user = await multiUser.registerUser(auth.accountId, eoaAddress, strategy);

    const agentWallet = withChecksum(getOperatorAccountId(getClient()));

    return NextResponse.json(
      {
        status: 'registered',
        userId: user.userId,
        strategy: user.strategyName,
        rakePercent: user.rakePercent,
        agentWallet,
        depositMemo: user.depositMemo,
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
