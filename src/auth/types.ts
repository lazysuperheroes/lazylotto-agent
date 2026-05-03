/**
 * Auth system types for Hedera signature challenge-response authentication.
 *
 * Four authorization tiers (ordered by privilege, operator highest):
 *   - public:   rate-limited, no auth (registration, onboarding)
 *   - user:     session token proving Hedera account ownership
 *   - admin:    session token + account in ADMIN_ACCOUNTS env
 *   - operator: session token + account in OPERATOR_ACCOUNTS env
 *
 * In single-user CLI mode (MULTI_USER_ENABLED != 'true'), MCP_AUTH_TOKEN
 * also confers operator tier — see src/auth/middleware.ts. That path is
 * scoped to local stdio / Claude Desktop and does NOT apply on hosted
 * multi-user deployments.
 */

/** Authorization tiers, ordered by privilege. */
export type AuthTier = 'public' | 'user' | 'admin' | 'operator';

/** Hedera account key type from mirror node. */
export type HederaKeyType = 'ED25519' | 'ECDSA_SECP256K1';

// ── Challenge ────────────────────────────────────────────────

/** Stored in Redis during the 5-minute challenge window. */
export interface AuthChallenge {
  /** UUID identifier for this challenge. */
  id: string;
  /** Random nonce the user must sign. */
  nonce: string;
  /** The Hedera account claiming to authenticate. */
  accountId: string;
  /** Public key hex (DER-prefixed) fetched from mirror node at challenge time. */
  publicKeyHex: string;
  /** Key type for the public key. */
  keyType: HederaKeyType;
  /** The human-readable message the user sees in their wallet. */
  message: string;
  /** When this challenge expires (ISO-8601). */
  expiresAt: string;
}

// ── Session ──────────────────────────────────────────────────

/** Stored in Redis (keyed by sha256 of the session token). */
export interface AuthSession {
  /** The Hedera account ID that authenticated. */
  accountId: string;
  /** Internal user ID (resolved from accountId via store). */
  userId?: string;
  /** Authorization tier. */
  tier: AuthTier;
  /** Whether this is a locked (permanent) API key. */
  locked: boolean;
  /** When the session was created (ISO-8601). */
  createdAt: string;
  /** When the session expires (ISO-8601). Null if locked. */
  expiresAt: string | null;
}

// ── Resolved auth context (passed to tool handlers) ─────────

/** The resolved identity for an authenticated request. */
export interface AuthContext {
  /** The authorization tier. */
  tier: AuthTier;
  /** The authenticated Hedera account ID. */
  accountId: string;
  /** The internal user ID (for user/admin tiers). */
  userId?: string;
  /** The raw session token (for refresh/revoke). */
  token?: string;
}
