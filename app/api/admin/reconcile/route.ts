/**
 * POST /api/admin/reconcile
 *
 * Triggers on-chain balance reconciliation against the internal ledger.
 * Requires 'operator' tier auth.
 *
 * This operation requires a live Hedera Client with the agent's private
 * key, which is not available in the serverless Next.js environment.
 * Returns 501 until the full HTTP server mode is used.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';

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
    const auth = await requireTier(request, 'operator');
    if (isErrorResponse(auth)) return auth;

    return NextResponse.json(
      {
        error: 'Not implemented in serverless mode',
        message:
          'Reconciliation requires the agent CLI with a live Hedera client. ' +
          'Use: npm run dev:http and call POST /api/admin/reconcile on the HTTP server.',
      },
      { status: 501, headers: CORS_HEADERS },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
