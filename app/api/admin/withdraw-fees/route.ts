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

    if (typeof body.amount !== 'number' || body.amount <= 0) {
      return NextResponse.json(
        { error: 'Invalid amount — must be a positive number' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    // Resolve recipient — env var override takes precedence for safety
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
          error: `Recipient locked to OPERATOR_WITHDRAW_ADDRESS (${envWithdrawAddr}). ` +
            `Cannot override.`,
        },
        { status: 403, headers: CORS_HEADERS },
      );
    }

    const token = body.token ?? 'HBAR';

    const { multiUser, store } = await getAgentContext();

    // Refresh operator state so we use the freshest balance
    await store.refreshOperator();

    const txId = await multiUser.operatorWithdrawFees(body.amount, to, token);
    const op = multiUser.getOperatorBalance();

    return NextResponse.json(
      {
        withdrawn: body.amount,
        token,
        to,
        transactionId: txId,
        remainingBalances: op.balances,
      },
      { headers: CORS_HEADERS },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 400, headers: CORS_HEADERS },
    );
  }
});
