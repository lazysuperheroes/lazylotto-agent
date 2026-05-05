/**
 * POST /api/admin/replay-deposit
 *
 * Operator-driven recovery for a deposit that was dead-lettered —
 * typically because the underlying error is now resolved
 * (e.g. token was registered after the deposit landed, or a transient
 * mirror-node failure). Fetches the on-chain transaction by id and
 * re-runs it through `DepositWatcher.processTransaction`, BYPASSING
 * the watermark gate.
 *
 * 0.3.4: added per security-audit finding #13. Pre-fix the only path
 * to recover a dead-lettered deposit was direct Redis manipulation +
 * manual `creditDeposit` invocation by the operator.
 *
 * Requires 'admin' tier auth — re-credits funds, so it should require
 * the highest privilege.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getAgentContext } from '../../_lib/mcp';
import { withStore } from '../../_lib/withStore';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import type { MirrorTransaction } from '~/hedera/mirror';

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
    if (!(await checkRateLimit({ request, action: 'admin-replay-deposit', limit: 10, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    const body = (await request.json().catch(() => ({}))) as { transactionId?: string };
    if (!body.transactionId) {
      return NextResponse.json(
        { error: 'Missing required field: transactionId' },
        { status: 400, headers: CORS_HEADERS },
      );
    }
    const transactionId = body.transactionId;

    // Fetch the transaction by id from the mirror node. We use the same
    // base URL convention as `src/hedera/refund.ts` so an env override
    // (HEDERA_NETWORK) flips both paths together.
    const mirrorBase =
      process.env.HEDERA_NETWORK === 'mainnet'
        ? 'https://mainnet.mirrornode.hedera.com/api/v1'
        : 'https://testnet.mirrornode.hedera.com/api/v1';

    const txRes = await fetch(`${mirrorBase}/transactions/${transactionId}`);
    if (!txRes.ok) {
      return NextResponse.json(
        { error: `Transaction ${transactionId} not found on mirror node (${txRes.status})` },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    const txData = (await txRes.json()) as { transactions?: MirrorTransaction[] };
    const tx = txData.transactions?.[0];
    if (!tx) {
      return NextResponse.json(
        { error: 'Transaction not found in mirror response' },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    // Hand off to the same processTransaction the live poll uses.
    // creditDeposit's atomic SADD claim guarantees no double-credit:
    // if the deposit was already credited (via a successful prior run
    // or a parallel poll), `tryClaimTransaction` returns false and
    // `processTransaction` is a no-op aside from the dead-letter
    // skip-counter increment. If the underlying issue (e.g.
    // unregistered token) is still unresolved, the same dead-letter
    // path runs again — operator sees no change.
    const { multiUser } = await getAgentContext();
    const watcher = multiUser.getDepositWatcher();
    const credited = await watcher.processTransaction(tx);

    return NextResponse.json(
      {
        transactionId,
        credited,
        note: credited
          ? 'Deposit successfully credited.'
          : 'Transaction was skipped — either already credited (no-op), failed validation again, or wrote a fresh dead-letter. Inspect /api/admin/dead-letters.',
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
