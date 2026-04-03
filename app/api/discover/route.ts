import { NextResponse } from 'next/server';
import { buildDiscoveryResponse } from '~/discover';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function GET() {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    'https://testnet-agent.lazysuperheroes.com';

  const discovery = buildDiscoveryResponse(baseUrl);

  return NextResponse.json(discovery, {
    headers: {
      ...CORS_HEADERS,
      'Cache-Control': 'public, max-age=300, s-maxage=600',
    },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}
