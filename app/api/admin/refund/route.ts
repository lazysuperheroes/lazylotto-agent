/**
 * POST /api/admin/refund
 *
 * Processes a refund for a specific Hedera transaction: looks up the
 * transaction on the mirror node, identifies the sender, and transfers
 * the same amount back.
 *
 * Requires 'operator' tier auth.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getClient } from '../../_lib/hedera';
import { getStore } from '../../_lib/store';
import { getAgentContext } from '../../_lib/mcp';
import { withStore } from '../../_lib/withStore';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { processRefund } from '~/hedera/refund';

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
    // Refund moves real money — strict rate limit
    if (!(await checkRateLimit({ request, action: 'admin-refund', limit: 10, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    const body = (await request.json()) as { transactionId?: string };
    if (!body.transactionId) {
      return NextResponse.json(
        { error: 'Missing required field: transactionId' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const store = await getStore();
    // Refresh user index so the memo→user lookup inside processRefund works
    // against fresh data (user could have been registered since last load).
    await store.refreshUserIndex();
    // Pull the AccountingService from the cached agent context so the
    // refund writes a v2 HCS-20 audit entry. Without this, refunds
    // happen on chain but don't appear in the audit trail, leaving
    // deposits as unpaired credits and breaking reconciliation math
    // for any third party reading the topic.
    const { multiUser } = await getAgentContext();
    const accounting = multiUser.getAccountingService();
    const result = await processRefund(getClient(), body.transactionId, {
      store,
      ...(accounting ? { accounting } : {}),
      reason: 'admin',
      performedBy: auth.accountId,
    });

    return NextResponse.json(result, { headers: CORS_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
});
