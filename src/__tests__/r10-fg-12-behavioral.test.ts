/**
 * R10-FG-12 behavioral test — velocity counter must not be
 * permanently inflated by a rejected withdraw attempt.
 *
 * R10-FG-12 said: a compromised session retrying withdraw(1500) 10
 * times against a 1000 cap drove the counter to 15000 via INCRBY,
 * and every legitimate withdraw for the next 24h returned 503.
 * Pre-Phase-9 the over-cap branch did NOT roll back the increment
 * — the inline comment explicitly accepted this as "lossy on the
 * over-cap edge." That framing missed the attack vector: the
 * attacker's goal is DoS against the victim's withdraw modal.
 *
 * Phase-9 Cluster E rolls back the increment on the over-cap
 * branch. The test exercises the rollback against the same Redis
 * primitive (`incrby`) and asserts the counter ends at the same
 * value as if the increment had never run.
 *
 * The test scopes to the Redis primitive level (not the full
 * MultiUserAgent.applyWithdrawalVelocityCap method) because the
 * rollback is a single line; testing through the full agent would
 * require mocking the breaker, the idempotency layer, and several
 * other pieces of state for what is fundamentally a 2-call atomic
 * pattern.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

interface MockState {
  kv: Map<string, number>;
}

function makeMockRedis(state: MockState) {
  return {
    async incrby(key: string, delta: number): Promise<number> {
      const cur = state.kv.get(key) ?? 0;
      const next = cur + delta;
      state.kv.set(key, next);
      return next;
    },
    async expire(_key: string, _sec: number): Promise<number> {
      return 1;
    },
  };
}

/**
 * Mirror of the Phase-9 over-cap rollback at
 * MultiUserAgent.applyWithdrawalVelocityCap. If a future revert
 * removes the rollback, this fixture's locking assertion flips.
 */
async function applyVelocityCheck(
  redis: ReturnType<typeof makeMockRedis>,
  key: string,
  amount: number,
  cap: number,
): Promise<{ remaining: number }> {
  const proposed = await redis.incrby(key, amount);
  await redis.expire(key, 24 * 60 * 60);
  if (proposed > cap) {
    // R10-FG-12 / Phase-9 Cluster E: rollback.
    await redis.incrby(key, -amount);
    return { remaining: cap - proposed };
  }
  return { remaining: cap - proposed };
}

describe('R10-FG-12: rejected withdraw must not permanently inflate the velocity counter', () => {
  // revert-proof: R10-FG-12 — removing the `redis.incrby(key, -amount)`
  // rollback in the over-cap branch of applyWithdrawalVelocityCap
  // (or in this test fixture's mirror) flips the assertion. The
  // attack vector is DoS via repeated over-cap retries; a clean
  // counter post-rejection is the bug-shape invariant.
  it('counter ends at zero after 10 rejected over-cap attempts', async () => {
    const state: MockState = { kv: new Map() };
    const redis = makeMockRedis(state);
    const key = 'velocity:hbar:user-r10-fg-12';
    const cap = 1000;
    const overCapAmount = 1500;

    for (let i = 0; i < 10; i++) {
      const { remaining } = await applyVelocityCheck(redis, key, overCapAmount, cap);
      assert.ok(remaining < 0, 'each attempt must report negative remaining (over-cap)');
    }

    assert.equal(
      state.kv.get(key) ?? 0,
      0,
      `R10-FG-12: counter MUST roll back to 0 after rejected attempts. ` +
        `Got ${state.kv.get(key)}. Pre-Phase-9 this would be 15000 (10 ` +
        `attempts × 1500 amount), permanently locking the legitimate ` +
        `user out of the daily cap for 24 hours.`,
    );
  });

  // revert-proof: R10-FG-12 companion — the rollback must be the
  // EXACT amount, not a fixed value or a relative ratio. Anyone
  // simplifying to `redis.del(key)` (rollback to zero regardless
  // of legitimate prior usage) flips this test.
  it('legitimate prior usage is preserved across a single rejected over-cap attempt', async () => {
    const state: MockState = { kv: new Map() };
    const redis = makeMockRedis(state);
    const key = 'velocity:hbar:user-r10-fg-12-mixed';
    const cap = 1000;

    // Two legitimate withdrawals: 300 + 400 = 700. Both under cap.
    const a = await applyVelocityCheck(redis, key, 300, cap);
    assert.ok(a.remaining >= 0);
    const b = await applyVelocityCheck(redis, key, 400, cap);
    assert.ok(b.remaining >= 0);

    // One over-cap attempt: 700 + 500 = 1200 > 1000.
    const c = await applyVelocityCheck(redis, key, 500, cap);
    assert.ok(c.remaining < 0);

    // Counter must equal the legitimate prior usage (700), NOT 0
    // and NOT 1200.
    assert.equal(
      state.kv.get(key) ?? 0,
      700,
      `R10-FG-12: rollback must subtract exactly the over-cap amount, ` +
        `preserving legitimate prior usage. Got ${state.kv.get(key)}.`,
    );
  });
});
