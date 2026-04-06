/**
 * POST /api/admin/reconcile
 *
 * Triggers on-chain balance reconciliation against the internal ledger.
 * Processes any pending deposits first to ensure fresh data.
 *
 * Requires 'operator' tier auth.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getClient } from '../../_lib/hedera';
import { getStore } from '../../_lib/store';
import { getAgentContext } from '../../_lib/mcp';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { reconcile } from '~/custodial/Reconciliation';

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function POST(request: Request) {
  try {
    // Reconcile is expensive (mirror node + Redis pipeline) — modest limit
    if (!(await checkRateLimit({ request, action: 'admin-reconcile', limit: 6, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    // Process any pending deposits through the shared singleton watcher
    // before reconciling so the ledger reflects latest on-chain state.
    const { multiUser } = await getAgentContext();
    await multiUser.pollDepositsOnce();

    const client = getClient();
    const store = await getStore();

    // Refresh everything reconciliation reads: all user balances + operator.
    // Reconciliation is an explicit admin action so paying a few round trips
    // on click is fine.
    await Promise.all([store.refreshUserIndex(), store.refreshOperator()]);

    const result = await reconcile(client, store);

    return NextResponse.json(result, { headers: CORS_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
