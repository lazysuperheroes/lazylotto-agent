/**
 * GET /api/health
 *
 * Liveness check — no auth, cheap to call. Intended for uptime monitors,
 * load balancers, and the HOL discovery payload.
 *
 * Returns the minimum fields a monitor needs to distinguish "agent is
 * running" from "Vercel is serving a 500 page", plus diagnostic fields
 * that surface backend misconfiguration without requiring operators to
 * peek at Vercel env vars:
 *
 *   - status:       always 'ok' when the route executes
 *   - network:      testnet | mainnet (from env)
 *   - version:      package version (from NEXT_PUBLIC_APP_VERSION,
 *                   injected at build time by next.config.mjs from
 *                   package.json — see notes below)
 *   - timestamp:    ISO string, so stale-cache probes can see freshness
 *   - redis:        'upstash' | 'memory' — backend mode for auth, locks,
 *                   rate limits, sessions, kill switch, velocity caps.
 *                   Synchronous env check; no Redis I/O. Monitors should
 *                   alert if this is 'memory' in production. (F3 + F4)
 *   - auth_backend: alias for `redis` (they share the same client).
 *   - kill_switch:  { state: 'enabled'|'disabled'|'unknown', reason? }.
 *                   `unknown` means the Redis read for the flag failed —
 *                   does NOT cause the route to 5xx, but is a signal a
 *                   monitor should pick up.
 *
 * The Redis-mode fields are deliberately synchronous. The kill switch
 * read is best-effort — if Redis is unreachable we report 'unknown' and
 * the health endpoint still returns 200. A health endpoint that
 * cascades failures from one downstream into a global outage is worse
 * than no health endpoint.
 *
 * Version sourcing: Vercel does NOT set `npm_package_version` at
 * function runtime — that var is only present when the process was
 * launched by an `npm run` script. So reading it directly always
 * returned the fallback ('0.1.0') in production. The fix is to use
 * `NEXT_PUBLIC_APP_VERSION` which `next.config.mjs` already injects
 * from `package.json` at build time. The `npm_package_version`
 * fallback is kept for local CLI runs.
 */

import { NextResponse } from 'next/server';
import { getRedisBackendMode } from '~/auth/redis';
import { getKillSwitchState } from '~/lib/killswitch';

// Public endpoint — wide-open CORS so any monitor can read.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function GET() {
  // Backend mode — synchronous env check, no I/O.
  const redisMode = getRedisBackendMode();

  // Kill switch — best-effort. If Redis is unreachable, getKillSwitchState
  // already swallows the error and returns { enabled: false }; we surface
  // a third 'unknown' state by re-running the lower-level check ourselves.
  let killSwitch: { state: 'enabled' | 'disabled' | 'unknown'; reason?: string };
  try {
    const ks = await getKillSwitchState();
    killSwitch = ks.enabled
      ? { state: 'enabled', ...(ks.reason ? { reason: ks.reason } : {}) }
      : { state: 'disabled' };
  } catch {
    killSwitch = { state: 'unknown' };
  }

  return NextResponse.json(
    {
      status: 'ok',
      network: process.env.HEDERA_NETWORK ?? 'testnet',
      version:
        process.env.NEXT_PUBLIC_APP_VERSION ??
        process.env.npm_package_version ??
        '0.1.0',
      timestamp: new Date().toISOString(),
      redis: redisMode,
      auth_backend: redisMode,
      kill_switch: killSwitch,
    },
    {
      headers: {
        ...CORS_HEADERS,
        // No caching — monitors need fresh responses, and the payload
        // is cheap enough that cache hit-rate doesn't matter.
        'Cache-Control': 'no-store',
      },
    },
  );
}
