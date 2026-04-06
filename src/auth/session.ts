/**
 * Session management for authenticated users.
 *
 * Sessions are stored in Upstash Redis (or in-memory fallback).
 * Session tokens are sha256-hashed before storage — a Redis compromise
 * does not leak usable tokens.
 *
 * Features:
 *   - 7-day expiry by default
 *   - Lock API key (remove expiry, permanent until revoked)
 *   - Auto-revoke on re-auth (prevents token accumulation)
 *   - Refresh (new token, old invalidated)
 */

import { randomBytes } from 'node:crypto';
import { getRedis, hashToken, KEY_PREFIX } from './redis.js';
import type { AuthSession, AuthTier } from './types.js';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const TOKEN_PREFIX = 'sk_';

/** Generate a new session token. */
function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('hex');
}

/**
 * Create a new session for an authenticated account.
 */
export async function createSession(
  accountId: string,
  tier: AuthTier,
): Promise<{ token: string; expiresAt: string }> {
  const redis = await getRedis();
  const token = generateToken();
  const hashedKey = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

  const session: AuthSession = {
    accountId,
    tier,
    locked: false,
    createdAt: new Date().toISOString(),
    expiresAt,
  };

  // Store session keyed by hash of token
  await redis.set(
    `${KEY_PREFIX.session}${hashedKey}`,
    JSON.stringify(session),
    { ex: SESSION_TTL_SECONDS },
  );

  // Track this token hash under the account for revoke-all
  await redis.sadd(`${KEY_PREFIX.accountSessions}${accountId}`, hashedKey);

  return { token, expiresAt };
}

/**
 * Look up a session by its token.
 * Returns null if the token is invalid, expired, or revoked.
 */
export async function getSession(token: string): Promise<AuthSession | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;

  const redis = await getRedis();
  const hashedKey = hashToken(token);
  const raw = await redis.get<string>(`${KEY_PREFIX.session}${hashedKey}`);
  if (!raw) return null;

  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/**
 * Lock a session (make it permanent — no expiry).
 */
export async function lockSession(token: string): Promise<boolean> {
  const redis = await getRedis();
  const hashedKey = hashToken(token);
  const key = `${KEY_PREFIX.session}${hashedKey}`;

  const raw = await redis.get<string>(key);
  if (!raw) return false;

  const session: AuthSession = typeof raw === 'string' ? JSON.parse(raw) : raw;
  session.locked = true;
  session.expiresAt = null;

  // Re-store without TTL (persist)
  await redis.set(key, JSON.stringify(session));
  await redis.persist(key);

  return true;
}

/**
 * Destroy a session (revoke the token).
 *
 * Reads the session BEFORE deletion so we can extract the accountId
 * and clean up the account-sessions set entry. Without this, stale
 * hashes accumulate in the set indefinitely and revokeAllForAccount
 * does extra work against keys that no longer exist.
 */
export async function destroySession(token: string): Promise<boolean> {
  const redis = await getRedis();
  const hashedKey = hashToken(token);
  const sessionKey = `${KEY_PREFIX.session}${hashedKey}`;

  // Read first to get accountId for set cleanup
  let accountId: string | null = null;
  try {
    const raw = await redis.get<string>(sessionKey);
    if (raw) {
      const session: AuthSession = typeof raw === 'string' ? JSON.parse(raw) : raw;
      accountId = session.accountId;
    }
  } catch (e) {
    console.warn('[session] destroy: failed to read session before delete:', e);
  }

  // Now delete the session entry
  const deleted = await redis.del(sessionKey);

  // Clean up the account-sessions set entry
  if (accountId) {
    try {
      await redis.srem(`${KEY_PREFIX.accountSessions}${accountId}`, hashedKey);
    } catch (e) {
      console.warn('[session] destroy: failed to clean account-sessions set:', e);
    }
  }

  return deleted > 0;
}

/**
 * Refresh a session: generate a new token, invalidate the old one.
 */
export async function refreshSession(token: string): Promise<{
  token: string;
  expiresAt: string;
} | null> {
  const session = await getSession(token);
  if (!session) return null;

  // Destroy old session
  await destroySession(token);

  // Create new session with same tier
  return createSession(session.accountId, session.tier);
}

/**
 * Revoke ALL sessions for an account (used on re-auth).
 */
export async function revokeAllForAccount(accountId: string): Promise<number> {
  const redis = await getRedis();
  const setKey = `${KEY_PREFIX.accountSessions}${accountId}`;
  const hashes = await redis.smembers(setKey);

  if (hashes.length === 0) return 0;

  // Delete all session entries
  const sessionKeys = hashes.map(h => `${KEY_PREFIX.session}${h}`);
  const deleted = await redis.del(...sessionKeys);

  // Clear the set
  await redis.del(setKey);

  return deleted;
}
