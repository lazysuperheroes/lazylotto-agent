import { NextResponse } from 'next/server';
import { getSession, lockSession } from '~/auth/session';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { staticCorsHeaders } from '../../_lib/cors';
import { withStore } from '../../_lib/withStore';

const CORS_HEADERS = staticCorsHeaders('POST, OPTIONS');

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

// withStore: F3 production-Redis preflight + uniform last-resort catch.
// Without it, a missing Upstash deploy returns a route-local 500 here
// while every other route returns a structured 503 — that asymmetry is
// the diagnostic gap we're closing.
export const POST = withStore(async (request: Request) => {
  try {
    // Rate limit: 5 lock attempts per identity per minute
    if (!(await checkRateLimit({ request, action: 'lock', limit: 5, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

    const body = await request.json();
    const { sessionToken } = body as { sessionToken?: string };

    if (!sessionToken) {
      return NextResponse.json(
        { error: 'Missing sessionToken' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    // R3-FG-61 (round-3 P7-008): require the Bearer header to match
    // the body's sessionToken. Pre-fix the route accepted any
    // sessionToken in the body with no proof of ownership — a leaked
    // token (clipboard, log) could be locked permanently by anyone
    // who saw it.
    const authHeader = request.headers.get('authorization') ?? '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!bearer || bearer !== sessionToken) {
      return NextResponse.json(
        { error: 'Lock requires the Bearer token to match the body sessionToken (proof of ownership).' },
        { status: 401, headers: CORS_HEADERS },
      );
    }

    // F7 (2026-07-05 custodial audit): privileged (admin/operator) sessions
    // must NOT be made permanent. Locking strips the TTL, so a leaked or
    // offboarded operator credential would otherwise live forever. Keep the
    // 7-day expiry — combined with resolveAuth's per-request de-escalation,
    // a privileged token cannot outlive both its TTL and its env membership.
    const session = await getSession(sessionToken);
    if (session && (session.tier === 'admin' || session.tier === 'operator')) {
      return NextResponse.json(
        {
          error:
            'Admin/operator sessions cannot be locked — they retain the 7-day expiry so privileged credentials cannot become permanent. Re-authenticate to refresh.',
        },
        { status: 403, headers: CORS_HEADERS },
      );
    }

    const locked = await lockSession(sessionToken);

    if (!locked) {
      return NextResponse.json(
        { error: 'Invalid or expired session' },
        { status: 401, headers: CORS_HEADERS },
      );
    }

    return NextResponse.json(
      { locked: true },
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
