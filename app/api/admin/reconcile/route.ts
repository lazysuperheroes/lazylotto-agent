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
import { checkDeposits } from '../../_lib/deposits';
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
    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    // Process any pending deposits before reconciling
    await checkDeposits();

    const client = getClient();
    const store = await getStore();
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
