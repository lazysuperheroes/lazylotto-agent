/**
 * Shared auth helper for Next.js API routes.
 *
 * Extracts the Bearer token from the Authorization header, resolves it
 * to an AuthContext, and enforces tier-based access control. Returns
 * either the resolved AuthContext or an error NextResponse that the
 * caller should return immediately.
 */

import { resolveAuth, satisfiesTier } from '~/auth/middleware';
import type { AuthContext, AuthTier } from '~/auth/types';
import { NextResponse } from 'next/server';
import { staticCorsHeaders } from './cors';

// Backward-compat: existing routes import { CORS_HEADERS } from auth.
// New routes should prefer corsHeadersFor(request) for per-request matching.
const CORS_HEADERS = staticCorsHeaders('GET, POST, DELETE, OPTIONS');

/**
 * Require a minimum auth tier for an API route.
 *
 * @returns The resolved AuthContext on success, or a NextResponse error
 *          (401/403) that the route handler should return as-is.
 */
export async function requireTier(
  request: Request,
  tier: AuthTier,
): Promise<AuthContext | NextResponse> {
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : undefined;

  if (!token) {
    return NextResponse.json(
      { error: 'Authorization required' },
      { status: 401, headers: CORS_HEADERS },
    );
  }

  const auth = await resolveAuth(token);
  if (!auth) {
    return NextResponse.json(
      { error: 'Invalid session' },
      { status: 401, headers: CORS_HEADERS },
    );
  }

  if (!satisfiesTier(auth, tier)) {
    return NextResponse.json(
      { error: 'Insufficient permissions' },
      { status: 403, headers: CORS_HEADERS },
    );
  }

  return auth;
}

/** Type guard: true when requireTier returned an error response. */
export function isErrorResponse(
  result: AuthContext | NextResponse,
): result is NextResponse {
  return result instanceof NextResponse;
}

export { CORS_HEADERS };
