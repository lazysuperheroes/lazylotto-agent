/**
 * GET /.well-known/agent-card.json
 *
 * Standard A2A discovery endpoint. Clients fetch this to discover
 * the agent's capabilities, skills, auth requirements, and service URL.
 *
 * Identical payload to GET /api/a2a — two paths, one Agent Card.
 * Cached for 5 minutes (the card only changes on redeploy).
 */

import { NextResponse } from 'next/server';
import { buildAgentCard } from '~/a2a/agent-card';
import { staticCorsHeaders } from '../../api/_lib/cors';

const CORS_HEADERS = staticCorsHeaders('GET, OPTIONS');

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
  });
}

export async function GET() {
  return NextResponse.json(buildAgentCard(), {
    headers: {
      ...CORS_HEADERS,
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
    },
  });
}
