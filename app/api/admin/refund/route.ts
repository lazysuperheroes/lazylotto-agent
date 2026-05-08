/**
 * POST /api/admin/refund
 *
 * Processes a refund for a specific Hedera transaction: looks up the
 * transaction on the mirror node, identifies the sender, and transfers
 * the same amount back.
 *
 * Requires 'admin' tier auth (closes R3-FG-40 — runtime check below
 * uses `requireTier(request, 'admin')`; doc was 'operator' pre-fix).
 * R4-FG-61 doc fix.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getClient } from '../../_lib/hedera';
import { getStore } from '../../_lib/store';
import { getAgentContext } from '../../_lib/mcp';
import { withStore } from '../../_lib/withStore';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { processRefund } from '~/hedera/refund';
import { withIdempotency } from '~/lib/idempotency';

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
    // R4-FG-44 (round-4 medium): rate-limit AFTER requireTier so the
    // bucket is keyed on the authenticated `auth.accountId`, not the
    // raw bearer-prefix fallback. Pre-fix an admin who rotated session
    // tokens got a fresh bucket per rotation, blowing past the
    // documented per-account cap. Refund moves real money so this
    // gate must actually bound per-operator request volume.
    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    if (!(await checkRateLimit({
      request,
      action: 'admin-refund',
      limit: 10,
      windowSec: 60,
      identity: auth.accountId,
    }))) {
      return rateLimitResponse(60);
    }

    const body = (await request.json()) as { transactionId?: string };
    if (!body.transactionId) {
      return NextResponse.json(
        { error: 'Missing required field: transactionId' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    // R3-FG-41 (round-3 P7-009): require Idempotency-Key (matches
    // /api/admin/withdraw-fees). Pre-fix the route relied solely on
    // processRefund's internal SET-NX-EX claim — sufficient for the
    // exact-same-txId race but allowed any non-receipt-uncertain
    // throw to release the claim and re-process on a retry. Belt +
    // braces: route-level idempotency by header, function-level by
    // transactionId.
    const idempotencyKey = request.headers.get('Idempotency-Key');
    if (!idempotencyKey) {
      return NextResponse.json(
        { error: 'Missing required header: Idempotency-Key' },
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

    const idempotent = await withIdempotency(
      `admin-refund:${body.transactionId}`,
      idempotencyKey,
      () =>
        processRefund(getClient(), body.transactionId!, {
          store,
          ...(accounting ? { accounting } : {}),
          reason: 'admin',
          performedBy: auth.accountId,
        }),
    );
    if (idempotent.kind === 'in-flight') {
      return NextResponse.json(
        { error: 'Refund already in flight on another Lambda; retry shortly.' },
        { status: 409, headers: CORS_HEADERS },
      );
    }
    const headers = {
      ...CORS_HEADERS,
      ...(idempotent.kind === 'duplicate'
        ? { 'X-Idempotent-Replayed': 'true' }
        : {}),
    };
    return NextResponse.json(idempotent.result, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
});
