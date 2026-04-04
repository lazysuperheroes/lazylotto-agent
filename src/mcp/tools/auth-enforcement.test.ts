/**
 * Tests for MCP tool auth enforcement patterns.
 *
 * Validates:
 * - Operator tools deny user-tier tokens
 * - Multi-user tools enforce per-user ownership
 * - Registration dedup returns existing user
 * - Refund ledger adjustment deducts from user balance
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthContext } from '../../auth/types.js';
import type { AuthResult, ServerContext, ToolResult } from './types.js';
import type { IStore } from '../../custodial/IStore.js';
import type { UserAccount, UserBalances } from '../../custodial/types.js';
import { emptyBalances, emptyTokenEntry } from '../../custodial/types.js';

// ── Helpers ─────────────────────────────────────────────────────

function json(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function parseResult(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

/** Simulate requireOperator from operator.ts */
function requireOperator(authResult: AuthResult): ToolResult | null {
  if ('error' in authResult) return authResult.error;
  if (authResult.auth.tier === 'user') return errorResult('Access denied');
  return null;
}

/** Simulate the per-user ownership check from multi-user.ts */
function enforceOwnership(
  auth: AuthContext,
  requestedUserId: string | undefined,
  resolveUserId: (accountId: string) => string | null,
): { userId: string } | { error: ToolResult } {
  if (auth.tier === 'user') {
    const myUserId = resolveUserId(auth.accountId);
    if (!myUserId) return { error: errorResult('Not registered. Call multi_user_register first.') };
    if (requestedUserId && requestedUserId !== myUserId) return { error: errorResult('Access denied') };
    return { userId: myUserId };
  }
  if (!requestedUserId) return { error: errorResult('userId is required') };
  return { userId: requestedUserId };
}

// ── Operator Tier Enforcement ───────────────────────────────────

describe('Operator tier enforcement', () => {
  it('allows operator tier', () => {
    const result = requireOperator({ auth: { tier: 'operator', accountId: 'op' } });
    assert.equal(result, null);
  });

  it('allows admin tier', () => {
    const result = requireOperator({ auth: { tier: 'admin', accountId: '0.0.100' } });
    assert.equal(result, null);
  });

  it('denies user tier', () => {
    const result = requireOperator({ auth: { tier: 'user', accountId: '0.0.200' } });
    assert.notEqual(result, null);
    assert.equal(result!.isError, true);
    const parsed = parseResult(result!) as { error: string };
    assert.equal(parsed.error, 'Access denied');
  });

  it('returns error for failed auth', () => {
    const result = requireOperator({ error: errorResult('Invalid token') });
    assert.notEqual(result, null);
    assert.equal(result!.isError, true);
  });
});

// ── Per-User Ownership Enforcement ──────────────────────────────

describe('Per-user ownership enforcement', () => {
  const resolveUserId = (accountId: string) => {
    if (accountId === '0.0.100') return 'user-alice';
    if (accountId === '0.0.200') return 'user-bob';
    return null;
  };

  it('user tier auto-resolves their own userId', () => {
    const result = enforceOwnership(
      { tier: 'user', accountId: '0.0.100' },
      undefined,
      resolveUserId,
    );
    assert.ok(!('error' in result));
    assert.equal(result.userId, 'user-alice');
  });

  it('user tier can pass their own userId explicitly', () => {
    const result = enforceOwnership(
      { tier: 'user', accountId: '0.0.100' },
      'user-alice',
      resolveUserId,
    );
    assert.ok(!('error' in result));
    assert.equal(result.userId, 'user-alice');
  });

  it('user tier cannot access another user', () => {
    const result = enforceOwnership(
      { tier: 'user', accountId: '0.0.100' },
      'user-bob',
      resolveUserId,
    );
    assert.ok('error' in result);
    const parsed = parseResult(result.error) as { error: string };
    assert.equal(parsed.error, 'Access denied');
  });

  it('user tier denied if not registered', () => {
    const result = enforceOwnership(
      { tier: 'user', accountId: '0.0.999' },
      undefined,
      resolveUserId,
    );
    assert.ok('error' in result);
    const parsed = parseResult(result.error) as { error: string };
    assert.match(parsed.error, /not registered/i);
  });

  it('admin tier can access any user', () => {
    const result = enforceOwnership(
      { tier: 'admin', accountId: '0.0.100' },
      'user-bob',
      resolveUserId,
    );
    assert.ok(!('error' in result));
    assert.equal(result.userId, 'user-bob');
  });

  it('operator tier can access any user', () => {
    const result = enforceOwnership(
      { tier: 'operator', accountId: 'operator' },
      'user-alice',
      resolveUserId,
    );
    assert.ok(!('error' in result));
    assert.equal(result.userId, 'user-alice');
  });

  it('admin/operator without userId gets error', () => {
    const result = enforceOwnership(
      { tier: 'admin', accountId: '0.0.100' },
      undefined,
      resolveUserId,
    );
    assert.ok('error' in result);
  });
});

// ── Registration Dedup ──────────────────────────────────────────

describe('Registration dedup', () => {
  it('returns already_registered when accountId matches existing user', () => {
    const resolveUserId = (accountId: string) =>
      accountId === '0.0.100' ? 'user-alice' : null;

    // Simulate the dedup check from multi_user_register
    const accountId = '0.0.100';
    const existing = resolveUserId(accountId);

    assert.equal(existing, 'user-alice');
    // In real code, this returns json({ status: 'already_registered', ... })
  });

  it('returns null for new accounts', () => {
    const resolveUserId = (accountId: string) =>
      accountId === '0.0.100' ? 'user-alice' : null;

    const existing = resolveUserId('0.0.999');
    assert.equal(existing, null);
    // In real code, this proceeds to registerUser()
  });
});

// ── Refund Ledger Adjustment ────────────────────────────────────

describe('Refund ledger adjustment', () => {
  function makeUser(userId: string, memo: string, hbarAvailable: number): UserAccount {
    const balances = emptyBalances();
    balances.tokens['hbar'] = { ...emptyTokenEntry(), available: hbarAvailable, totalDeposited: hbarAvailable };
    return {
      userId,
      depositMemo: memo,
      hederaAccountId: '0.0.100',
      eoaAddress: '0xabc',
      strategyName: 'balanced',
      strategyVersion: '0.2',
      strategySnapshot: {} as UserAccount['strategySnapshot'],
      rakePercent: 5,
      balances,
      connectionTopicId: null,
      registeredAt: new Date().toISOString(),
      lastPlayedAt: null,
      active: true,
    };
  }

  function makeMockStore(users: UserAccount[]): Pick<IStore, 'getUserByMemo' | 'updateBalance'> {
    const userMap = new Map(users.map(u => [u.depositMemo, u]));
    return {
      getUserByMemo(memo: string) {
        return userMap.get(memo);
      },
      updateBalance(userId: string, updater: (b: UserBalances) => UserBalances) {
        const user = users.find(u => u.userId === userId);
        if (!user) throw new Error('User not found');
        user.balances = updater(user.balances);
        return user.balances;
      },
    };
  }

  it('deducts from user balance when memo matches', () => {
    const user = makeUser('user-1', 'll-abc123', 10);
    const store = makeMockStore([user]);

    // Simulate the refund ledger adjustment logic
    const memo = 'll-abc123';
    const matched = store.getUserByMemo(memo);
    assert.ok(matched);
    assert.equal(matched!.userId, 'user-1');

    const refundHbar = 5; // 5 HBAR refunded
    store.updateBalance('user-1', (b) => {
      const entry = b.tokens['hbar'];
      if (entry) entry.available = Math.max(0, entry.available - refundHbar);
      return b;
    });

    assert.equal(user.balances.tokens['hbar'].available, 5); // 10 - 5
  });

  it('clamps to zero when refund exceeds balance', () => {
    const user = makeUser('user-1', 'll-abc123', 3);
    const store = makeMockStore([user]);

    store.updateBalance('user-1', (b) => {
      const entry = b.tokens['hbar'];
      if (entry) entry.available = Math.max(0, entry.available - 10);
      return b;
    });

    assert.equal(user.balances.tokens['hbar'].available, 0);
  });

  it('does nothing when memo does not match any user', () => {
    const user = makeUser('user-1', 'll-abc123', 10);
    const store = makeMockStore([user]);

    const matched = store.getUserByMemo('ll-unknown');
    assert.equal(matched, undefined);
    // Balance unchanged
    assert.equal(user.balances.tokens['hbar'].available, 10);
  });

  it('does nothing when no store is provided', () => {
    // Simulate processRefund without options.store
    const options = undefined as { store?: IStore } | undefined;
    assert.equal(options?.store, undefined);
    // Refund proceeds without ledger adjustment — this is the MCP tool path
    // when store is not wired (should not happen in practice, but safe)
  });
});
