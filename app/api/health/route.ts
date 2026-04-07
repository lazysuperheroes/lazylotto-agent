/**
 * GET /api/health
 *
 * Liveness check — no auth, no dependencies, cheap to call. Intended
 * for uptime monitors, load balancers, and the HOL discovery payload.
 *
 * Returns the minimum fields a monitor needs to distinguish "agent is
 * running" from "Vercel is serving a 500 page":
 *   - status:    always 'ok' when the route executes
 *   - network:   testnet | mainnet (from env)
 *   - version:   package version (from NEXT_PUBLIC_APP_VERSION,
 *                injected at build time by next.config.mjs from
 *                package.json — see notes below)
 *   - timestamp: ISO string, so stale-cache probes can see freshness
 *
 * Deliberately does NOT check Redis, Hedera SDK, or any downstream
 * service. A health endpoint that fans out is a health endpoint that
 * cascades failures — and the MCP / status routes already cover the
 * "is everything actually working" question.
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
  return NextResponse.json(
    {
      status: 'ok',
      network: process.env.HEDERA_NETWORK ?? 'testnet',
      version:
        process.env.NEXT_PUBLIC_APP_VERSION ??
        process.env.npm_package_version ??
        '0.1.0',
      timestamp: new Date().toISOString(),
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
