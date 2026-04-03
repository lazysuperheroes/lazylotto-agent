/**
 * Auth middleware for tier-based tool authorization.
 *
 * Extracts session tokens from:
 *   - Authorization: Bearer sk_... header
 *   - ?key=sk_... query parameter
 *   - auth_token tool parameter (legacy stdio compatibility)
 *
 * Resolves the token to an AuthContext with tier, accountId, and userId.
 * Legacy MCP_AUTH_TOKEN is supported for operator-tier access.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { getSession } from './session.js';
import type { AuthContext, AuthTier } from './types.js';

/**
 * Resolve an auth token to an AuthContext.
 * Returns null for invalid/missing tokens (caller decides whether to allow public access).
 */
export async function resolveAuth(token?: string): Promise<AuthContext | null> {
  if (!token) return null;

  // Session tokens start with sk_
  if (token.startsWith('sk_')) {
    const session = await getSession(token);
    if (!session) return null;

    return {
      tier: session.tier,
      accountId: session.accountId,
      userId: session.userId,
      token,
    };
  }

  // Legacy: check against MCP_AUTH_TOKEN (operator tier)
  // Read at call time (not module load) so tests can set it dynamically
  const mcpAuthToken = process.env.MCP_AUTH_TOKEN || null;
  if (mcpAuthToken) {
    const hash = (s: string) => createHash('sha256').update(s).digest();
    if (timingSafeEqual(hash(token), hash(mcpAuthToken))) {
      return {
        tier: 'operator',
        accountId: 'operator',
      };
    }
  }

  return null;
}

/**
 * Check if a resolved auth context satisfies a required tier.
 *
 * Tier hierarchy: operator > admin > user > public
 */
export function satisfiesTier(auth: AuthContext | null, required: AuthTier): boolean {
  if (required === 'public') return true;

  if (!auth) return false;

  const tierLevel: Record<AuthTier, number> = {
    public: 0,
    user: 1,
    admin: 2,
    operator: 3,
  };

  return tierLevel[auth.tier] >= tierLevel[required];
}

/**
 * Extract the auth token from various sources.
 * Priority: Authorization header > query param > tool parameter
 */
export function extractToken(
  headers?: Record<string, string | string[] | undefined>,
  queryParams?: Record<string, string | undefined>,
  toolAuthToken?: string,
): string | undefined {
  // 1. Authorization: Bearer sk_...
  if (headers) {
    const authHeader = headers['authorization'] ?? headers['Authorization'];
    const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (headerValue?.startsWith('Bearer ')) {
      return headerValue.slice(7);
    }
  }

  // 2. ?key=sk_...
  if (queryParams?.key) {
    return queryParams.key;
  }

  // 3. auth_token tool parameter (legacy stdio compat)
  if (toolAuthToken) {
    return toolAuthToken;
  }

  return undefined;
}
