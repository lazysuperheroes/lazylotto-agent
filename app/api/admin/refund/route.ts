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

export async function POST(request: Request) {
  try {
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
    const result = await processRefund(getClient(), body.transactionId, { store });

    return NextResponse.json(result, { headers: CORS_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
