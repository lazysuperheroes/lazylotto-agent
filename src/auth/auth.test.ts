/**
 * Comprehensive tests for the auth module.
 *
 * Uses the in-memory Redis fallback (no real Redis needed).
 * Environment is configured before auth module imports so that:
 *   - UPSTASH_REDIS_REST_URL is unset (triggers in-memory fallback)
 *   - MCP_AUTH_TOKEN is set for operator-tier tests
 */

// ── Environment setup (must run before auth module loads) ────
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.MCP_AUTH_TOKEN = 'test-operator-token';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { hashToken, assertProductionRedis, getRedisBackendMode, isUpstashConfigured } from './redis.js';
import { buildChallengeMessage } from './challenge.js';
import {
  createSession,
  getSession,
  lockSession,
  destroySession,
  refreshSession,
  revokeAllForAccount,
} from './session.js';
import { resolveAuth, satisfiesTier, extractToken } from './middleware.js';
import type { AuthContext, AuthTier } from './types.js';

// ═════════════════════════════════════════════════════════════
// hashToken
// ═════════════════════════════════════════════════════════════

describe('hashToken', () => {
  it('produces consistent sha256 hex output', () => {
    const input = 'sk_abc123';
    const hash1 = hashToken(input);
    const hash2 = hashToken(input);
    assert.equal(hash1, hash2);
  });

  it('different inputs produce different hashes', () => {
    const hash1 = hashToken('sk_token_a');
    const hash2 = hashToken('sk_token_b');
    assert.notEqual(hash1, hash2);
  });

  it('returns 64-char hex string', () => {
    const hash = hashToken('sk_anything');
    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });
});

// ═════════════════════════════════════════════════════════════
// Session management
// ═════════════════════════════════════════════════════════════

describe('Session management', () => {
  const testAccount = '0.0.12345';

  beforeEach(async () => {
    // Clean up any sessions from previous tests
    await revokeAllForAccount(testAccount);
    await revokeAllForAccount('0.0.99999');
  });

  it('createSession returns token starting with sk_', async () => {
    const { token } = await createSession(testAccount, 'user');
    assert.ok(token.startsWith('sk_'), `Expected token to start with sk_, got: ${token}`);
  });

  it('createSession stores session retrievable by getSession', async () => {
    const { token } = await createSession(testAccount, 'user');
    const session = await getSession(token);
    assert.ok(session, 'Expected session to be non-null');
    assert.equal(session.accountId, testAccount);
    assert.equal(session.tier, 'user');
    assert.equal(session.locked, false);
    assert.ok(session.createdAt, 'Expected createdAt to be set');
    assert.ok(session.expiresAt, 'Expected expiresAt to be set');
  });

  it('getSession returns null for invalid token', async () => {
    const session = await getSession('sk_nonexistent_token_value');
    assert.equal(session, null);
  });

  it('getSession returns null for non-sk_ prefixed token', async () => {
    const session = await getSession('not_a_valid_prefix_token');
    assert.equal(session, null);
  });

  it('lockSession makes session permanent (getSession still works)', async () => {
    const { token } = await createSession(testAccount, 'user');

    const locked = await lockSession(token);
    assert.equal(locked, true);

    const session = await getSession(token);
    assert.ok(session, 'Expected locked session to still be retrievable');
    assert.equal(session.locked, true);
    assert.equal(session.expiresAt, null);
  });

  it('destroySession revokes token (getSession returns null)', async () => {
    const { token } = await createSession(testAccount, 'user');

    // Verify it exists first
    const before = await getSession(token);
    assert.ok(before, 'Session should exist before destroy');

    const destroyed = await destroySession(token);
    assert.equal(destroyed, true);

    const after = await getSession(token);
    assert.equal(after, null, 'Session should be null after destroy');
  });

  it('refreshSession returns new token, invalidates old', async () => {
    const { token: oldToken } = await createSession(testAccount, 'user');

    const result = await refreshSession(oldToken);
    assert.ok(result, 'Expected refreshSession to return a new session');
    assert.ok(result.token.startsWith('sk_'), 'New token should start with sk_');
    assert.notEqual(result.token, oldToken, 'New token should differ from old');
    assert.ok(result.expiresAt, 'New session should have expiresAt');

    // Old token should be invalid
    const oldSession = await getSession(oldToken);
    assert.equal(oldSession, null, 'Old token should be revoked after refresh');

    // New token should work
    const newSession = await getSession(result.token);
    assert.ok(newSession, 'New token should resolve to a valid session');
    assert.equal(newSession.accountId, testAccount);
  });

  it('refreshSession returns null for invalid token', async () => {
    const result = await refreshSession('sk_does_not_exist');
    assert.equal(result, null);
  });

  it('revokeAllForAccount removes all sessions for an account', async () => {
    const { token: token1 } = await createSession(testAccount, 'user');
    const { token: token2 } = await createSession(testAccount, 'user');
    const { token: otherToken } = await createSession('0.0.99999', 'user');

    // Verify all exist
    assert.ok(await getSession(token1), 'token1 should exist');
    assert.ok(await getSession(token2), 'token2 should exist');
    assert.ok(await getSession(otherToken), 'otherToken should exist');

    const deleted = await revokeAllForAccount(testAccount);
    assert.ok(deleted >= 2, `Expected at least 2 deleted, got ${deleted}`);

    // Both sessions for testAccount should be gone
    assert.equal(await getSession(token1), null, 'token1 should be revoked');
    assert.equal(await getSession(token2), null, 'token2 should be revoked');

    // Other account's session should survive
    assert.ok(await getSession(otherToken), 'otherToken should still be valid');
  });

  it('session stores correct tier (user, admin)', async () => {
    const { token: userToken } = await createSession(testAccount, 'user');
    const { token: adminToken } = await createSession('0.0.99999', 'admin');

    const userSession = await getSession(userToken);
    assert.ok(userSession);
    assert.equal(userSession.tier, 'user');

    const adminSession = await getSession(adminToken);
    assert.ok(adminSession);
    assert.equal(adminSession.tier, 'admin');
  });
});

// ═════════════════════════════════════════════════════════════
// buildChallengeMessage
// ═════════════════════════════════════════════════════════════

describe('buildChallengeMessage', () => {
  it('is deterministic (same inputs produce same output)', () => {
    const msg1 = buildChallengeMessage('0.0.1234', 'nonce-abc', 'testnet');
    const msg2 = buildChallengeMessage('0.0.1234', 'nonce-abc', 'testnet');
    assert.equal(msg1, msg2);
  });

  it('includes account ID in message', () => {
    const msg = buildChallengeMessage('0.0.5678', 'nonce-xyz', 'testnet');
    assert.ok(msg.includes('0.0.5678'), 'Message should contain the account ID');
  });

  it('includes network name (capitalized)', () => {
    const msg = buildChallengeMessage('0.0.1234', 'nonce-1', 'testnet');
    assert.ok(msg.includes('Testnet'), 'Message should contain capitalized network name');

    const mainnetMsg = buildChallengeMessage('0.0.1234', 'nonce-1', 'mainnet');
    assert.ok(mainnetMsg.includes('Mainnet'), 'Message should contain capitalized Mainnet');
  });

  it('includes nonce in message', () => {
    const nonce = 'unique-nonce-value-42';
    const msg = buildChallengeMessage('0.0.1234', nonce, 'testnet');
    assert.ok(msg.includes(nonce), 'Message should contain the nonce');
  });
});

// ═════════════════════════════════════════════════════════════
// resolveAuth
// ═════════════════════════════════════════════════════════════

describe('resolveAuth', () => {
  beforeEach(async () => {
    await revokeAllForAccount('0.0.77777');
  });

  it('returns null for undefined token', async () => {
    const auth = await resolveAuth(undefined);
    assert.equal(auth, null);
  });

  it('returns null for empty string', async () => {
    const auth = await resolveAuth('');
    assert.equal(auth, null);
  });

  it('returns null for invalid sk_ token (not in store)', async () => {
    const auth = await resolveAuth('sk_bogus_token_not_in_store');
    assert.equal(auth, null);
  });

  it('returns session data for valid sk_ token', async () => {
    const { token } = await createSession('0.0.77777', 'user');
    const auth = await resolveAuth(token);
    assert.ok(auth, 'Expected auth context for valid token');
    assert.equal(auth.tier, 'user');
    assert.equal(auth.accountId, '0.0.77777');
    assert.equal(auth.token, token);
  });

  it('returns operator tier for valid MCP_AUTH_TOKEN in single-user mode', async () => {
    // process.env.MCP_AUTH_TOKEN was set to 'test-operator-token' before module load.
    // MULTI_USER_ENABLED is not set, so this is the single-user CLI path.
    delete process.env.MULTI_USER_ENABLED;
    const auth = await resolveAuth('test-operator-token');
    assert.ok(auth, 'Expected auth context for operator token');
    assert.equal(auth.tier, 'operator');
    assert.equal(auth.accountId, 'local-owner');
  });

  it('returns null for wrong MCP_AUTH_TOKEN', async () => {
    delete process.env.MULTI_USER_ENABLED;
    const auth = await resolveAuth('wrong-operator-token');
    assert.equal(auth, null);
  });

  // F1b: MCP_AUTH_TOKEN must NOT grant any tier in multi-user hosted mode.
  // A leaked or misconfigured env var becomes a no-op, not an escalation.
  it('IGNORES MCP_AUTH_TOKEN in multi-user mode (no escalation backdoor)', async () => {
    process.env.MULTI_USER_ENABLED = 'true';
    try {
      const auth = await resolveAuth('test-operator-token');
      assert.equal(auth, null, 'Expected null — MCP_AUTH_TOKEN must not work in multi-user mode');
    } finally {
      delete process.env.MULTI_USER_ENABLED;
    }
  });

  it('still resolves valid sk_ session tokens in multi-user mode', async () => {
    process.env.MULTI_USER_ENABLED = 'true';
    try {
      const { token } = await createSession('0.0.77777', 'user');
      const auth = await resolveAuth(token);
      assert.ok(auth, 'Expected sk_ session to resolve in multi-user mode');
      assert.equal(auth.tier, 'user');
    } finally {
      delete process.env.MULTI_USER_ENABLED;
    }
  });
});

// ═════════════════════════════════════════════════════════════
// assertProductionRedis — F3 invariant
// ═════════════════════════════════════════════════════════════

describe('assertProductionRedis', () => {
  // Tests run with UPSTASH_* unset and NODE_ENV unset (or 'test').

  it("does not throw when NODE_ENV is unset and Upstash is missing (local dev)", () => {
    delete process.env.NODE_ENV;
    assertProductionRedis();
  });

  it("does not throw when NODE_ENV='development' and Upstash is missing", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      assertProductionRedis();
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });

  it("THROWS with PRODUCTION_REDIS_REQUIRED when NODE_ENV='production' and Upstash is missing", () => {
    const original = process.env.NODE_ENV;
    // Make doubly sure Upstash is unset
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () => assertProductionRedis(),
        /PRODUCTION_REDIS_REQUIRED/,
      );
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });

  it("does not throw when NODE_ENV='production' and Upstash IS configured", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    try {
      assertProductionRedis();
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
    }
  });
});

describe('getRedisBackendMode', () => {
  it("returns 'memory' when Upstash is unset", () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    assert.equal(getRedisBackendMode(), 'memory');
    assert.equal(isUpstashConfigured(), false);
  });

  it("returns 'upstash' when both env vars are set", () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    try {
      assert.equal(getRedisBackendMode(), 'upstash');
      assert.equal(isUpstashConfigured(), true);
    } finally {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
    }
  });

  it("supports legacy KV_REST_API_* aliases", () => {
    process.env.KV_REST_API_URL = 'https://example.kv.io';
    process.env.KV_REST_API_TOKEN = 'kv-token';
    try {
      assert.equal(getRedisBackendMode(), 'upstash');
    } finally {
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
    }
  });
});

// ═════════════════════════════════════════════════════════════
// resolveWalletTier — F1a invariant
// ═════════════════════════════════════════════════════════════
//
// Pure function — testable without forging mirror-node signatures.
// Membership ordering is OPERATOR > ADMIN > USER, with operator
// short-circuiting admin (a strict-superset hierarchy).

describe('resolveWalletTier', () => {
  // Save and restore env between tests
  const ORIGINAL_OPERATOR = process.env.OPERATOR_ACCOUNTS;
  const ORIGINAL_ADMIN = process.env.ADMIN_ACCOUNTS;

  beforeEach(() => {
    delete process.env.OPERATOR_ACCOUNTS;
    delete process.env.ADMIN_ACCOUNTS;
  });

  // Restore after the suite
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  process.on('exit', () => {
    if (ORIGINAL_OPERATOR !== undefined) process.env.OPERATOR_ACCOUNTS = ORIGINAL_OPERATOR;
    if (ORIGINAL_ADMIN !== undefined) process.env.ADMIN_ACCOUNTS = ORIGINAL_ADMIN;
  });

  it("returns 'user' when no envs match", async () => {
    const { resolveWalletTier } = await import('./verify.js');
    assert.equal(resolveWalletTier('0.0.99999'), 'user');
  });

  it("returns 'admin' when account is in ADMIN_ACCOUNTS", async () => {
    process.env.ADMIN_ACCOUNTS = '0.0.111,0.0.222';
    const { resolveWalletTier } = await import('./verify.js');
    assert.equal(resolveWalletTier('0.0.111'), 'admin');
    assert.equal(resolveWalletTier('0.0.222'), 'admin');
    assert.equal(resolveWalletTier('0.0.333'), 'user');
  });

  it("returns 'operator' when account is in OPERATOR_ACCOUNTS", async () => {
    process.env.OPERATOR_ACCOUNTS = '0.0.500';
    const { resolveWalletTier } = await import('./verify.js');
    assert.equal(resolveWalletTier('0.0.500'), 'operator');
  });

  it("operator short-circuits admin (strict-superset)", async () => {
    process.env.OPERATOR_ACCOUNTS = '0.0.500';
    process.env.ADMIN_ACCOUNTS = '0.0.500,0.0.501';
    const { resolveWalletTier } = await import('./verify.js');
    assert.equal(resolveWalletTier('0.0.500'), 'operator');
    assert.equal(resolveWalletTier('0.0.501'), 'admin');
  });

  it('handles whitespace and empty entries in env', async () => {
    process.env.OPERATOR_ACCOUNTS = ' 0.0.500 , , 0.0.501 ';
    const { resolveWalletTier } = await import('./verify.js');
    assert.equal(resolveWalletTier('0.0.500'), 'operator');
    assert.equal(resolveWalletTier('0.0.501'), 'operator');
  });

  it('handles unset envs gracefully', async () => {
    const { resolveWalletTier } = await import('./verify.js');
    assert.equal(resolveWalletTier('0.0.anything'), 'user');
  });
});

// ═════════════════════════════════════════════════════════════
// satisfiesTier
// ═════════════════════════════════════════════════════════════

describe('satisfiesTier', () => {
  const userAuth: AuthContext = { tier: 'user', accountId: '0.0.1' };
  const adminAuth: AuthContext = { tier: 'admin', accountId: '0.0.2' };
  const operatorAuth: AuthContext = { tier: 'operator', accountId: 'operator' };

  it('public tier allows null auth', () => {
    assert.equal(satisfiesTier(null, 'public'), true);
  });

  it('public tier allows any auth', () => {
    assert.equal(satisfiesTier(userAuth, 'public'), true);
    assert.equal(satisfiesTier(adminAuth, 'public'), true);
    assert.equal(satisfiesTier(operatorAuth, 'public'), true);
  });

  it('user tier rejects null auth', () => {
    assert.equal(satisfiesTier(null, 'user'), false);
  });

  it('user tier accepts user auth', () => {
    assert.equal(satisfiesTier(userAuth, 'user'), true);
  });

  it('user tier accepts admin auth', () => {
    assert.equal(satisfiesTier(adminAuth, 'user'), true);
  });

  it('user tier accepts operator auth', () => {
    assert.equal(satisfiesTier(operatorAuth, 'user'), true);
  });

  it('admin tier rejects user auth', () => {
    assert.equal(satisfiesTier(userAuth, 'admin'), false);
  });

  it('admin tier accepts admin auth', () => {
    assert.equal(satisfiesTier(adminAuth, 'admin'), true);
  });

  it('operator tier only accepts operator auth', () => {
    assert.equal(satisfiesTier(null, 'operator'), false);
    assert.equal(satisfiesTier(userAuth, 'operator'), false);
    assert.equal(satisfiesTier(adminAuth, 'operator'), false);
    assert.equal(satisfiesTier(operatorAuth, 'operator'), true);
  });
});

// ═════════════════════════════════════════════════════════════
// extractToken
// ═════════════════════════════════════════════════════════════

describe('extractToken', () => {
  it('extracts from Authorization: Bearer header', () => {
    const token = extractToken(
      { authorization: 'Bearer sk_header_token' },
      undefined,
      undefined,
    );
    assert.equal(token, 'sk_header_token');
  });

  it('extracts from ?key= query param', () => {
    const token = extractToken(
      undefined,
      { key: 'sk_query_token' },
      undefined,
    );
    assert.equal(token, 'sk_query_token');
  });

  it('extracts from auth_token tool param', () => {
    const token = extractToken(undefined, undefined, 'sk_tool_token');
    assert.equal(token, 'sk_tool_token');
  });

  it('prefers header over query param', () => {
    const token = extractToken(
      { authorization: 'Bearer sk_from_header' },
      { key: 'sk_from_query' },
      'sk_from_tool',
    );
    assert.equal(token, 'sk_from_header');
  });

  it('returns undefined when nothing provided', () => {
    const token = extractToken(undefined, undefined, undefined);
    assert.equal(token, undefined);
  });
});
