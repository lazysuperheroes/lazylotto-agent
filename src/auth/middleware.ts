/**
 * Auth middleware for tier-based tool authorization.
 *
 * Extracts session tokens from:
 *   - Authorization: Bearer sk_... header
 *   - ?key=sk_... query parameter
 *   - auth_token tool parameter (legacy stdio compatibility)
 *
 * Resolves the token to an AuthContext with tier, accountId, and userId.
 *
 * MCP_AUTH_TOKEN handling — scoped intentionally:
 *   - Single-user CLI / local stdio (`MULTI_USER_ENABLED !== 'true'`):
 *     MCP_AUTH_TOKEN confers operator tier (`accountId: 'local-owner'`).
 *     This is the documented and intended primitive for gating Claude
 *     Desktop / other local processes against the agent's MCP server when
 *     the operator runs the agent on their own machine.
 *   - Multi-user hosted (`MULTI_USER_ENABLED === 'true'`):
 *     MCP_AUTH_TOKEN is IGNORED. Wallet auth is the only path to any
 *     tier. A leaked or misconfigured env var becomes a no-op rather
 *     than an escalation backdoor. Hosted operators land in
 *     OPERATOR_ACCOUNTS via src/auth/verify.ts.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { getSession } from './session.js';
import { deEscalateTier } from './tiers.js';
import type { AuthContext, AuthTier } from './types.js';

/**
 * True when the agent is running in multi-user (custodial) mode. Read at
 * call time so tests can flip the flag without re-importing the module.
 */
function isMultiUserMode(): boolean {
  return process.env.MULTI_USER_ENABLED === 'true';
}

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

    // F7 (2026-07-05 custodial audit): re-resolve the tier from the CURRENT
    // env on every request and take the LOWER of (baked, current). An
    // account removed from OPERATOR_ACCOUNTS / ADMIN_ACCOUNTS is
    // de-escalated immediately — even for a locked (no-TTL) session, and
    // without a re-auth. Never auto-escalates above the baked tier.
    return {
      tier: deEscalateTier(session.tier, session.accountId),
      accountId: session.accountId,
      userId: session.userId,
      token,
    };
  }

  // Single-user CLI: MCP_AUTH_TOKEN confers local-owner operator access.
  // Hosted multi-user mode IGNORES this branch — wallet auth is the only
  // path to any tier on a deployed agent. See module docstring for the
  // rationale; this is a deliberate scope, not a bypass.
  //
  // Read env at call time so tests can flip MULTI_USER_ENABLED dynamically.
  if (!isMultiUserMode()) {
    const mcpAuthToken = process.env.MCP_AUTH_TOKEN || null;
    if (mcpAuthToken) {
      const hash = (s: string) => createHash('sha256').update(s).digest();
      if (timingSafeEqual(hash(token), hash(mcpAuthToken))) {
        return {
          tier: 'operator',
          accountId: 'local-owner',
        };
      }
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
 * Priority: Authorization header > tool parameter (stdio-compat).
 *
 * The legacy `?key=sk_…` query-string fallback was REMOVED in 0.3.4
 * (commit fixing security-audit finding #3). Tokens in URLs leak via
 * browser history, OS clipboard managers, screenshare, server access
 * logs, and the Referer header — and a locked session token in the
 * URL becomes permanent attacker control once the URL leaks anywhere.
 * The dashboard's "Copy Connection URL" surface is updated to display
 * the token separately and use the standard `Authorization: Bearer`
 * header. MCP clients (Claude Desktop) consume the JSON config block
 * which already uses Bearer.
 *
 * `queryParams` is kept in the signature for backwards source
 * compatibility with callers but is now ignored.
 */
export function extractToken(
  headers?: Record<string, string | string[] | undefined>,
  _queryParams?: Record<string, string | undefined>,
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

  // 2. auth_token tool parameter (legacy stdio compat for MCP)
  if (toolAuthToken) {
    return toolAuthToken;
  }

  return undefined;
}
