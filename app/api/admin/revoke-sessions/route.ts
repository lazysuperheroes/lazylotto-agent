/**
 * /api/admin/revoke-sessions
 *
 * F7 (2026-07-05 custodial audit): admin force-revoke of ALL live sessions
 * for a Hedera account. `resolveAuth` de-escalates tier on every request
 * once an account leaves the env lists, but that only DROPS tier — a
 * LEAKED token (of any tier) stays usable until it expires. This endpoint
 * hard-kills every session for an account (offboarding / suspected token
 * compromise). Pre-fix, `revokeAllForAccount` was only reachable via the
 * account's OWN re-auth, so there was no operator-driven cutoff.
 *
 * POST { accountId } — requires admin tier.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { revokeAllForAccount } from '~/auth/session';
import { withStore } from '../../_lib/withStore';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
  });
}

export const POST = withStore(async (request: Request) => {
  try {
    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    if (
      !(await checkRateLimit({
        request,
        action: 'admin-revoke-sessions',
        limit: 10,
        windowSec: 60,
        identity: auth.accountId,
      }))
    ) {
      return rateLimitResponse(60);
    }

    const body = (await request.json().catch(() => ({}))) as { accountId?: string };
    const accountId = (body.accountId ?? '').trim();
    if (!accountId || !/^\d+\.\d+\.\d+$/.test(accountId)) {
      return NextResponse.json(
        { error: 'Missing or malformed accountId (expected 0.0.XXXXX).' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const revoked = await revokeAllForAccount(accountId);
    return NextResponse.json({ accountId, revoked }, { headers: CORS_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: CORS_HEADERS },
    );
  }
});
