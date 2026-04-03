/**
 * HTTP route handlers for auth endpoints.
 *
 * POST /auth/challenge — Request a signing challenge
 * POST /auth/verify    — Submit signed challenge, get session token
 * POST /auth/refresh   — Refresh a session token
 * POST /auth/lock      — Lock a session (make API key permanent)
 * POST /auth/revoke    — Revoke a session token
 */

import { createChallenge } from './challenge.js';
import { verifyChallenge } from './verify.js';
import { refreshSession, lockSession, destroySession } from './session.js';
import { getRedis, KEY_PREFIX } from './redis.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── Helpers ──────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.AUTH_PAGE_ORIGIN ?? '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function errorResponse(res: ServerResponse, status: number, message: string): void {
  jsonResponse(res, status, { error: message });
}

// ── Rate limiting ────────────────────────────────────────────

async function checkRateLimit(ip: string, action: string, limit: number, windowSeconds: number): Promise<boolean> {
  const redis = await getRedis();
  const key = `${KEY_PREFIX.rateLimit}${action}:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  return count <= limit;
}

// ── Route handler ────────────────────────────────────────────

/**
 * Handle an auth route request.
 * Returns true if the request was handled, false if not an auth route.
 */
export async function handleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS' && path.startsWith('/auth/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': process.env.AUTH_PAGE_ORIGIN ?? '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return true;
  }

  if (req.method !== 'POST') return false;

  const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    ?? req.socket.remoteAddress
    ?? 'unknown';

  try {
    switch (path) {
      case '/auth/challenge': {
        // Rate limit: 10 challenges per IP per 5 minutes
        if (!await checkRateLimit(clientIp, 'challenge', 10, 300)) {
          errorResponse(res, 429, 'Too many challenge requests. Try again later.');
          return true;
        }

        const body = await readBody(req);
        const accountId = body.accountId as string;
        if (!accountId || !/^\d+\.\d+\.\d+$/.test(accountId)) {
          errorResponse(res, 400, 'Invalid accountId format. Expected 0.0.XXXXX');
          return true;
        }

        const result = await createChallenge(accountId);
        jsonResponse(res, 200, result);
        return true;
      }

      case '/auth/verify': {
        // Rate limit: 5 verify attempts per IP per 5 minutes
        if (!await checkRateLimit(clientIp, 'verify', 5, 300)) {
          errorResponse(res, 429, 'Too many verification attempts. Try again later.');
          return true;
        }

        const body = await readBody(req);
        const { challengeId, accountId, signatureMapBase64 } = body as {
          challengeId?: string;
          accountId?: string;
          signatureMapBase64?: string;
        };

        if (!challengeId || !accountId || !signatureMapBase64) {
          errorResponse(res, 400, 'Missing required fields: challengeId, accountId, signatureMapBase64');
          return true;
        }

        const result = await verifyChallenge(
          challengeId as string,
          accountId as string,
          signatureMapBase64 as string,
        );

        const mcpUrl = process.env.AGENT_MCP_URL ?? `http://${req.headers.host}/mcp`;
        jsonResponse(res, 200, { ...result, mcpUrl });
        return true;
      }

      case '/auth/refresh': {
        const body = await readBody(req);
        const token = body.sessionToken as string;
        if (!token) {
          errorResponse(res, 400, 'Missing sessionToken');
          return true;
        }

        const result = await refreshSession(token);
        if (!result) {
          errorResponse(res, 401, 'Invalid or expired session');
          return true;
        }

        jsonResponse(res, 200, { sessionToken: result.token, expiresAt: result.expiresAt });
        return true;
      }

      case '/auth/lock': {
        const body = await readBody(req);
        const token = body.sessionToken as string;
        if (!token) {
          errorResponse(res, 400, 'Missing sessionToken');
          return true;
        }

        const locked = await lockSession(token);
        if (!locked) {
          errorResponse(res, 401, 'Invalid or expired session');
          return true;
        }

        jsonResponse(res, 200, { locked: true, message: 'API key is now permanent. Protect it carefully.' });
        return true;
      }

      case '/auth/revoke': {
        const body = await readBody(req);
        const token = body.sessionToken as string;
        if (!token) {
          errorResponse(res, 400, 'Missing sessionToken');
          return true;
        }

        const revoked = await destroySession(token);
        jsonResponse(res, 200, { revoked });
        return true;
      }

      default:
        return false;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorResponse(res, 400, message);
    return true;
  }
}
