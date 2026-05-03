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
 * ── Production vs local dev ──────────────────────────────────
 *
 * In production (Upstash Redis configured via UPSTASH_REDIS_REST_URL +
 * UPSTASH_REDIS_REST_TOKEN), counters are shared across ALL warm Lambda
 * instances. The limit you pass is the actual cluster-wide cap.
 *
 * In local dev with no Redis, getRedis() falls back to a per-process
 * in-memory Map (src/auth/redis.ts). That means:
 *   - CLI mode: a single counter in the one running process — fine.
 *   - `npm run dev:web` mode: a single counter in the Next.js dev
 *     server process — fine.
 *   - Multiple workers / multiple processes: each has its own counter.
 *     This only matters if you're load-testing locally.
 *
 * The fallback is intentional — local dev should not require Redis to
 * boot. Anyone deploying to Vercel without Upstash configured gets a
 * loud warning at boot from src/auth/redis.ts (`[Auth] No Upstash Redis
 * configured`) and the rate limits silently degrade to per-Lambda.
 * Don't deploy without Redis.
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
 *   2. x-forwarded-for[0] (Vercel edge IP — see security note below)
 *   3. 'unknown' fallback
 *
 * ── F7 — x-forwarded-for trust model ────────────────────────────
 *
 * On Vercel, the platform's edge network REWRITES `x-forwarded-for`
 * before the function sees it. The first entry is the client's
 * real source IP as observed by the edge — NOT a value the client
 * controls. Any client-supplied `x-forwarded-for` header is appended
 * after the edge-set value, so `split(',')[0]` always returns the
 * trustworthy value.
 *
 * Reference: Vercel docs — "Headers sent to functions" lists
 * `x-forwarded-for` with the edge-prepended client IP as the first
 * entry, followed by any upstream proxy chain. See also:
 *   https://vercel.com/docs/edge-network/headers
 *
 * Implications:
 *   - On Vercel: trustworthy. The body's `accountId` field never
 *     enters the rate-limit key, so an attacker cannot fan out by
 *     rotating accountIds.
 *   - Off Vercel (self-hosted CLI HTTP, local dev): the header is
 *     whatever upstream sets it to. For local dev this is usually
 *     unset or `127.0.0.1`. For self-hosted production behind an
 *     untrusted reverse proxy, this would be spoofable — but the
 *     CLI HTTP mode is documented as single-tenant and gated by
 *     `MCP_AUTH_TOKEN`, so rate limiting isn't the primary security
 *     boundary.
 *
 * Shared-NAT note: legitimate users behind the same corporate / NAT
 * gateway share rate-limit budget. The 10-challenge / 5-verify per
 * 5-minute caps are sized to absorb that without locking out a
 * large org. If we see legitimate-user 429s clustering, revisit.
 */
export function identityFor(request: Request): string {
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
