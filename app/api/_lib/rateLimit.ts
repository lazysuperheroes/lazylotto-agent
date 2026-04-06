/**
 * Shared rate limiting for Next.js API routes.
 *
 * Uses Redis INCR + EXPIRE (via the existing auth Redis client) keyed by
 * action + identity. Identity is the bearer token (preferred, stable) or
 * the caller IP (fallback for unauthenticated routes).
 *
 * Keys live in the auth Redis namespace under KEY_PREFIX.rateLimit so
 * they're network-scoped (lla:testnet:ratelimit:...) and cleaned up
 * automatically by Upstash's TTL.
 *
 * Usage inside a route:
 *   const ok = await checkRateLimit({
 *     request, action: 'refund', limit: 10, windowSec: 60,
 *   });
 *   if (!ok) return rateLimitResponse(60);
 */

import { NextResponse } from 'next/server';
import { getRedis, KEY_PREFIX } from '~/auth/redis';
import { CORS_HEADERS } from './auth';

export interface RateLimitOptions {
  request: Request;
  /** Short stable identifier for the action (e.g. 'challenge', 'refund'). */
  action: string;
  /** Max requests per window. */
  limit: number;
  /** Window duration in seconds. */
  windowSec: number;
}

/**
 * Extract a stable rate-limit key from the request:
 *   1. First 16 chars of Bearer token (dedupe per session)
 *   2. x-forwarded-for header (Vercel sets this to the client IP)
 *   3. 'unknown' fallback
 */
function identityFor(request: Request): string {
  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7, 23);
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() ?? 'unknown';
  return 'unknown';
}

/**
 * Check and increment the rate limit counter.
 * Returns true if the request is within the limit, false if exceeded.
 */
export async function checkRateLimit(options: RateLimitOptions): Promise<boolean> {
  const { request, action, limit, windowSec } = options;
  const identity = identityFor(request);
  const redis = await getRedis();
  const key = `${KEY_PREFIX.rateLimit}${action}:${identity}`;

  const count = await redis.incr(key);
  if (count === 1) {
    // First hit in this window — set TTL
    await redis.expire(key, windowSec);
  }
  return count <= limit;
}

/**
 * Standard 429 response for a rate-limited request.
 * Includes Retry-After header + CORS for consistency.
 */
export function rateLimitResponse(retryAfterSec: number): NextResponse {
  return NextResponse.json(
    { error: 'Rate limit exceeded. Try again shortly.' },
    {
      status: 429,
      headers: {
        ...CORS_HEADERS,
        'Retry-After': String(retryAfterSec),
      },
    },
  );
}
