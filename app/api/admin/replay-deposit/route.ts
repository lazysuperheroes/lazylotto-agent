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
import { getStore } from '../../_lib/store';
import { getAgentContext } from '../../_lib/mcp';
import { withStore } from '../../_lib/withStore';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { replayDeposit, ReplayDepositMirrorError } from '~/services/userOps';
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
    // R4-FG-44 (round-4 medium): rate-limit AFTER requireTier with
    // identity bound to auth.accountId.
    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    if (!(await checkRateLimit({
      request,
      action: 'admin-replay-deposit',
      limit: 10,
      windowSec: 60,
      identity: auth.accountId,
    }))) {
      return rateLimitResponse(60);
    }

    const body = (await request.json().catch(() => ({}))) as { transactionId?: string };

    // R4-FG-43 (round-4 medium): require Idempotency-Key matching the
    // refund / withdraw-fees pattern (R3-FG-41). Pre-fix this route
    // relied solely on `replayDeposit`'s internal SET-NX-EX claim —
    // sufficient for the exact-same-txId race, but a Lambda timeout
    // post-SET-NX-release would let a second admin click re-process.
    // Belt + braces: route-level idempotency by header, function-level
    // by transactionId.
    const idempotencyKey = request.headers.get('Idempotency-Key');
    if (!idempotencyKey) {
      return NextResponse.json(
        { error: 'Missing required header: Idempotency-Key' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    // 0.3.4: delegate to userOps.replayDeposit. transactionId format
    // validation, mirror-fetch, idempotency-by-txId all live there.
    const store = await getStore();
    const { multiUser } = await getAgentContext();
    try {
      const idempotent = await withIdempotency(
        `admin-replay:${body.transactionId ?? ''}`,
        idempotencyKey,
        () =>
          replayDeposit(
            { store, multiUser },
            {
              transactionId: body.transactionId ?? '',
              performedBy: auth.accountId,
            },
          ),
      );
      if (idempotent.kind === 'in-flight') {
        return NextResponse.json(
          { error: 'Replay already in flight on another Lambda; retry shortly.' },
          { status: 409, headers: CORS_HEADERS },
        );
      }
      const opResult = idempotent.result;
      const replayedHeader = idempotent.kind === 'duplicate'
        ? { 'X-Idempotent-Replayed': 'true' }
        : {};
      switch (opResult.kind) {
        case 'invalid_input':
          return NextResponse.json(
            { error: opResult.reason },
            { status: 400, headers: CORS_HEADERS },
          );
        case 'in_flight':
          return NextResponse.json(
            { error: 'A replay for this transactionId is already in progress.' },
            { status: 409, headers: CORS_HEADERS },
          );
        case 'duplicate':
        case 'ok': {
          // R5-FG-54 (P12-312): surface flush_failed_paged with
          // HTTP 207 + a warning so the admin UI can banner the
          // paged condition. Pre-fix the switch fell through with
          // credited:true and no signal — operator saw "replayed
          // ok" with no indication that local state mutated, Redis
          // flush failed, and they had been paged.
          if (opResult.result.status === 'flush_failed_paged') {
            return NextResponse.json(
              {
                transactionId: opResult.result.transactionId,
                credited: opResult.result.credited,
                status: opResult.result.status,
                warning:
                  'Local state mutated; Redis flush failed; orphan row written; operator paged. Run reconcile to confirm topic-side anchor.',
                ...(opResult.kind === 'duplicate' ? { replayed: true } : {}),
              },
              { status: 207, headers: { ...CORS_HEADERS, ...replayedHeader } },
            );
          }
          return NextResponse.json(
            {
              transactionId: opResult.result.transactionId,
              credited: opResult.result.credited,
              status: opResult.result.status,
              ...(opResult.kind === 'duplicate' ? { replayed: true } : {}),
            },
            { headers: { ...CORS_HEADERS, ...replayedHeader } },
          );
        }
        // Replay-deposit doesn't currently use user lock; access checks
        // happen at requireTier level. These cases shouldn't fire.
        case 'lock_held':
        case 'access_denied':
        case 'not_found':
          return NextResponse.json(
            { error: 'reason' in opResult ? opResult.reason : 'Operation rejected' },
            { status: 409, headers: CORS_HEADERS },
          );
      }
    } catch (innerErr) {
      if (innerErr instanceof ReplayDepositMirrorError) {
        return NextResponse.json(
          { error: innerErr.message },
          { status: 404, headers: CORS_HEADERS },
        );
      }
      throw innerErr;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
});
