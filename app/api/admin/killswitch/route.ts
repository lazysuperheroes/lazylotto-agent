/**
 * /api/admin/killswitch
 *
 * Emergency freeze for write-path operations. When engaged, new plays
 * and new registrations are refused; withdrawals and reads stay working.
 *
 * GET    — read current state (enabled/disabled + reason + metadata)
 * POST   — engage with { reason: string }
 * DELETE — disengage
 *
 * Requires 'operator' tier auth.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import {
  getKillSwitchState,
  enableKillSwitch,
  disableKillSwitch,
} from '~/lib/killswitch';

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function GET(request: Request) {
  const auth = await requireTier(request, 'operator');
  if (isErrorResponse(auth)) return auth;

  const state = await getKillSwitchState();
  return NextResponse.json(state, { headers: CORS_HEADERS });
}

export async function POST(request: Request) {
  try {
    const auth = await requireTier(request, 'operator');
    if (isErrorResponse(auth)) return auth;

    const body = (await request.json().catch(() => ({}))) as {
      reason?: string;
    };
    const reason = (body.reason ?? '').trim();
    if (!reason) {
      return NextResponse.json(
        { error: 'Missing required field: reason' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    await enableKillSwitch(reason, auth.accountId);
    const state = await getKillSwitchState();
    return NextResponse.json(state, { headers: CORS_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await requireTier(request, 'operator');
    if (isErrorResponse(auth)) return auth;

    await disableKillSwitch(auth.accountId);
    return NextResponse.json({ enabled: false }, { headers: CORS_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
