/**
 * POST /api/admin/withdraw-fees
 *
 * Withdraws accumulated rake fees from the operator platform balance to
 * the configured OPERATOR_WITHDRAW_ADDRESS (or a caller-specified address
 * if the env var is unset).
 *
 * Requires 'admin' tier auth.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getStore } from '../../_lib/store';
import { withStore } from '../../_lib/withStore';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { getAgentContext } from '../../_lib/mcp';
import { withdrawOperatorFees } from '~/services/userOps';

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
    if (!(await checkRateLimit({ request, action: 'admin-withdraw-fees', limit: 5, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    const body = (await request.json().catch(() => ({}))) as {
      amount?: number;
      to?: string;
      token?: 'HBAR' | 'LAZY';
    };

    // Resolve recipient — env var override takes precedence for safety.
    // (Service layer doesn't know about OPERATOR_WITHDRAW_ADDRESS — that's
    // a route-level safety check specific to admin endpoint.)
    const envWithdrawAddr = process.env.OPERATOR_WITHDRAW_ADDRESS;
    const to = envWithdrawAddr || body.to;
    if (!to) {
      return NextResponse.json(
        {
          error:
            'No recipient specified. Set OPERATOR_WITHDRAW_ADDRESS env var ' +
            'or pass `to` in the request body.',
        },
        { status: 400, headers: CORS_HEADERS },
      );
    }
    if (envWithdrawAddr && body.to && body.to !== envWithdrawAddr) {
      return NextResponse.json(
        {
          error: `Recipient locked to OPERATOR_WITHDRAW_ADDRESS (${envWithdrawAddr}). Cannot override.`,
        },
        { status: 403, headers: CORS_HEADERS },
      );
    }

    const token = body.token ?? 'HBAR';
    const { multiUser, store } = await getAgentContext();

    // 0.3.4: delegate to userOps.withdrawOperatorFees. Validation
    // (NaN/Infinity, recipient format) + idempotency + operator-lock
    // (already inside operatorWithdrawFees domain method).
    const idempotencyKey = request.headers.get('Idempotency-Key');
    const opResult = await withdrawOperatorFees(
      { store, multiUser },
      { amount: body.amount as number, to, token, idempotencyKey },
    );
    switch (opResult.kind) {
      case 'invalid_input':
        return NextResponse.json(
          { error: opResult.reason },
          { status: 400, headers: CORS_HEADERS },
        );
      case 'in_flight':
        return NextResponse.json(
          { error: 'A previous withdraw-fees with this Idempotency-Key is in progress.' },
          { status: 409, headers: CORS_HEADERS },
        );
      case 'lock_held':
      case 'access_denied':
      case 'not_found':
        return NextResponse.json(
          { error: 'reason' in opResult ? opResult.reason : 'Operation rejected' },
          { status: 409, headers: CORS_HEADERS },
        );
      case 'duplicate':
      case 'ok': {
        const responseHeaders: Record<string, string> = { ...CORS_HEADERS };
        if (opResult.kind === 'duplicate') {
          responseHeaders['X-Idempotent-Replayed'] = 'true';
        }
        return NextResponse.json(
          {
            withdrawn: opResult.result.withdrawn,
            token,
            to: opResult.result.to,
            transactionId: opResult.result.transactionId,
            remainingBalances: opResult.result.remainingBalances,
          },
          { headers: responseHeaders },
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 400, headers: CORS_HEADERS },
    );
  }
});
