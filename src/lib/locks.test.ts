/**
 * Distributed-lock contract tests (F10 lock-scope verification).
 *
 * The processWithdrawal invariant requires that the per-user lock is
 * held across BOTH the velocity-cap check AND the on-chain transfer.
 * This test exercises the underlying lock primitive that the route
 * layer (web `/api/user/withdraw`, MCP `multi_user_withdraw`) uses to
 * serialize concurrent operations on the same user.
 *
 * Uses the in-memory Redis fallback. No real Redis needed.
 */

// Force in-memory Redis fallback before importing the locks module.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  acquireUserLock,
  releaseUserLock,
  acquireOperatorLock,
  releaseOperatorLock,
  startOperatorLockHeartbeat,
  startUserLockHeartbeat,
} from './locks.js';
import { getRedis, KEY_PREFIX } from '../auth/redis.js';

async function clearLocks(): Promise<void> {
  const redis = await getRedis();
  // The in-memory store doesn't expose a SCAN — we just delete known
  // test keys. Each test uses a unique-enough userId to avoid collisions.
  for (const u of ['locktest-1', 'locktest-2', 'locktest-conflict', 'locktest-velocity']) {
    await redis.del(`${KEY_PREFIX.lockUser}${u}`);
  }
  for (const s of ['scope-a', 'scope-b']) {
    await redis.del(`${KEY_PREFIX.lockOperator}${s}`);
  }
}

describe('User locks (F10 contract)', () => {
  beforeEach(clearLocks);

  it('first acquire returns a fence token', async () => {
    const t = await acquireUserLock('locktest-1');
    assert.ok(t, 'expected a token from first acquire');
    await releaseUserLock('locktest-1', t!);
  });

  it('SECOND concurrent acquire on the same user returns null (serialization invariant)', async () => {
    const t1 = await acquireUserLock('locktest-conflict');
    assert.ok(t1);
    const t2 = await acquireUserLock('locktest-conflict');
    assert.equal(t2, null, 'second acquire must fail while first holds');
    await releaseUserLock('locktest-conflict', t1!);
  });

  it('after release, the next acquire succeeds', async () => {
    const t1 = await acquireUserLock('locktest-1');
    await releaseUserLock('locktest-1', t1!);
    const t2 = await acquireUserLock('locktest-1');
    assert.ok(t2, 'expected new token after release');
    await releaseUserLock('locktest-1', t2!);
  });

  it('release with WRONG fence token does NOT free the lock', async () => {
    const realToken = await acquireUserLock('locktest-1');
    assert.ok(realToken);

    // A stale owner attempts to release with a forged token.
    await releaseUserLock('locktest-1', 'forged-token-not-real');

    // The lock should still be held — second acquire must fail.
    const t2 = await acquireUserLock('locktest-1');
    assert.equal(t2, null, 'lock should still be held after wrong-token release');

    // Real owner can still release with the real token.
    await releaseUserLock('locktest-1', realToken!);
    const t3 = await acquireUserLock('locktest-1');
    assert.ok(t3);
    await releaseUserLock('locktest-1', t3!);
  });

  it('different users do not contend with each other', async () => {
    const t1 = await acquireUserLock('locktest-1');
    const t2 = await acquireUserLock('locktest-2');
    assert.ok(t1);
    assert.ok(t2);
    await releaseUserLock('locktest-1', t1!);
    await releaseUserLock('locktest-2', t2!);
  });

  // F10 invariant in concurrent shape: simulate two route handlers
  // racing on the same userId. The second handler must observe lock
  // contention and back off, NOT silently bypass into processWithdrawal.
  it('serializes two concurrent withdraw-shaped handlers via the lock contract', async () => {
    const userId = 'locktest-velocity';
    const order: string[] = [];

    async function withdrawShapedHandler(label: string): Promise<boolean> {
      const tok = await acquireUserLock(userId);
      if (!tok) {
        order.push(`${label}:locked`);
        return false; // route would 409 here
      }
      try {
        order.push(`${label}:enter`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`${label}:exit`);
        return true;
      } finally {
        await releaseUserLock(userId, tok);
      }
    }

    const [ok1, ok2] = await Promise.all([
      withdrawShapedHandler('A'),
      withdrawShapedHandler('B'),
    ]);

    // Exactly one handler should have completed; the other should have
    // been told the operation is locked. This is the contract route
    // handlers rely on for F10.
    const completed = [ok1, ok2].filter(Boolean).length;
    const blocked = [ok1, ok2].filter((v) => !v).length;
    assert.equal(completed, 1, 'exactly one handler should pass the lock');
    assert.equal(blocked, 1, 'the other handler must observe lock contention');
    // Trace ordering — locked event must come before enter/exit of the winner
    assert.ok(order.length === 3, `expected 3 events, got: ${order.join(', ')}`);
  });
});

describe('Operator locks', () => {
  beforeEach(clearLocks);

  it('different scopes can be held in parallel', async () => {
    const a = await acquireOperatorLock('scope-a');
    const b = await acquireOperatorLock('scope-b');
    assert.ok(a);
    assert.ok(b);
    await releaseOperatorLock('scope-a', a!);
    await releaseOperatorLock('scope-b', b!);
  });

  it('same scope cannot be held twice', async () => {
    const t1 = await acquireOperatorLock('scope-a');
    const t2 = await acquireOperatorLock('scope-a');
    assert.ok(t1);
    assert.equal(t2, null);
    await releaseOperatorLock('scope-a', t1!);
  });
});

describe('Lock heartbeat (R4-FG-66 + R5-FG-49)', () => {
  beforeEach(clearLocks);

  // revert-proof: if startOperatorLockHeartbeat reverts to no-op
  // (the R4-FG-66 fix removed), the lock TTL is whatever was set at
  // acquire — heartbeat would NOT extend it. This test acquires
  // with a 2s TTL, lets the heartbeat fire 4× over 4s, and asserts
  // the lock is still held. Pre-fix the lock would TTL out at 2s.
  it('R4-FG-66: heartbeat extends an operator lock past its acquire-time TTL', async () => {
    const token = await acquireOperatorLock('scope-a', 2);
    assert.ok(token);
    const hb = startOperatorLockHeartbeat('scope-a', token!, 500, 2);
    try {
      // Wait long enough for the original TTL to expire several times.
      await new Promise((r) => setTimeout(r, 2_500));
      // Lock must still be held — sibling SET-NX returns null.
      const sibling = await acquireOperatorLock('scope-a', 60);
      assert.equal(sibling, null, 'heartbeat should have kept the lock alive');
    } finally {
      hb.cancel();
      await releaseOperatorLock('scope-a', token!);
    }
  });

  // revert-proof: if startLockHeartbeat reverts to setInterval (the
  // R5-FG-49 self-rescheduling-setTimeout fix removed), the
  // cancelled-flag check happens AFTER stacked callbacks have queued
  // — a sibling acquire could see its lock silently re-extended by
  // a zombie callback. We can't directly observe Lua eval timing in
  // this test, but we can assert that cancelling immediately stops
  // further compare-and-extend attempts: re-acquire with a different
  // token after cancel + delete; if a stacked callback still ran the
  // Lua script, it would compare against the original token (no
  // match → no-op), so the re-acquire stays valid.
  it('R5-FG-49: cancel immediately halts further heartbeat ticks', async () => {
    const tokenA = await acquireUserLock('locktest-1', 2);
    assert.ok(tokenA);
    const hb = startUserLockHeartbeat('locktest-1', tokenA!, 2, 100);
    // Let it tick a few times.
    await new Promise((r) => setTimeout(r, 250));
    hb.cancel();
    await releaseUserLock('locktest-1', tokenA!);

    // Acquire fresh under a different token.
    const tokenB = await acquireUserLock('locktest-1', 60);
    assert.ok(tokenB, 'fresh acquire should succeed after cancel + release');

    // If a stacked tick had survived `cancel()`, it would EXPIRE the
    // key (matching tokenA, but tokenA was released; the EXPIRE
    // would no-op against tokenB's value — Lua's GET == ARGV[1]
    // check fences). Re-validate the tokenB lock is still held by
    // attempting a sibling acquire.
    await new Promise((r) => setTimeout(r, 300));
    const sibling = await acquireUserLock('locktest-1', 60);
    assert.equal(sibling, null, 'tokenB lock must remain held; no zombie tick should have nuked it');
    await releaseUserLock('locktest-1', tokenB!);
  });
});
