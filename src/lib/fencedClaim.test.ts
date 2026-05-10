/**
 * Phase-4 R7: fencedClaim primitive regression tests.
 *
 * Locks the SET-NX/release contract. Any future regression that
 * reverts the primitive's fence/PreserveClaim semantics fails here.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fencedClaim, releaseFence } from './fencedClaim.js';
import { getRedis } from '../auth/redis.js';
import { ReceiptUncertainError } from '../hedera/transfers.js';

describe('Phase-4 R7: fencedClaim primitive', () => {
  beforeEach(async () => {
    // Redis mock state may persist between tests. The auth/redis.ts
    // module exposes getRedis(); we manually FLUSHALL via key
    // enumeration since the mock doesn't expose flushall directly.
    const redis = await getRedis();
    // Best-effort: delete the keys we actually touch. Tests use
    // distinct prefixes so cross-test contamination is unlikely.
    await Promise.all(
      [
        'test:fc:basic',
        'test:fc:busy',
        'test:fc:throw',
        'test:fc:preserve',
        'test:fc:release-after-throw',
      ].map((k) => redis.del(k).catch(() => 0)),
    );
  });
  afterEach(async () => {
    const redis = await getRedis();
    await Promise.all(
      [
        'test:fc:basic',
        'test:fc:busy',
        'test:fc:throw',
        'test:fc:preserve',
        'test:fc:release-after-throw',
      ].map((k) => redis.del(k).catch(() => 0)),
    );
  });

  // revert-proof: R6-Phase-4 — replacing fencedClaim's SET-NX with a
  // plain SET would let a sibling overwrite an in-flight claim,
  // breaking the contract this primitive provides.
  it('returns kind:"ran" for a clean execution', async () => {
    const out = await fencedClaim('test:fc:basic', async () => 42);
    assert.equal(out.kind, 'ran');
    if (out.kind === 'ran') {
      assert.equal(out.result, 42);
      assert.match(out.fence, /^pending:/);
    }
  });

  // revert-proof: R6-Phase-4 — removing the SET-NX `null` check
  // would let two concurrent acquirers both run their bodies, the
  // exact archetype the primitive exists to prevent.
  it('returns kind:"busy" when the slot is held', async () => {
    const redis = await getRedis();
    await redis.set('test:fc:busy', 'pending:sibling', { nx: true, ex: 60 });

    const out = await fencedClaim('test:fc:busy', async () => 99);
    assert.equal(out.kind, 'busy');
    if (out.kind === 'busy') {
      assert.equal(out.existing, 'pending:sibling');
    }
  });

  // revert-proof: R6-FG-12 + R6-Phase-4 — removing the catch's
  // compare-and-DEL would leave non-preserve failures with a stuck
  // claim until TTL (the R6-FG-12 pendingLedger archetype). The
  // primitive's release-on-throw contract is the structural fix.
  it('releases the claim on a non-preserve throw', async () => {
    const redis = await getRedis();

    await assert.rejects(async () => {
      await fencedClaim('test:fc:throw', async () => {
        throw new Error('boom');
      });
    }, /boom/);

    // Slot must be free for an immediate retry.
    const after = await redis.get('test:fc:throw');
    assert.equal(after, null, 'claim must be released after non-preserve throw');
  });

  // revert-proof: R6-Phase-4 — flipping the preserve-claim branch
  // to release would let a retry double-submit an on-chain action.
  it('PRESERVES the claim on PreserveClaimError (rethrows)', async () => {
    const redis = await getRedis();

    await assert.rejects(async () => {
      await fencedClaim('test:fc:preserve', async () => {
        throw new ReceiptUncertainError('0.0.X@1.0');
      });
    }, /receipt/i);

    // Slot must STILL BE HELD — that's the entire point.
    const after = await redis.get('test:fc:preserve');
    assert.match(
      String(after ?? ''),
      /^pending:/,
      'PreserveClaim path must keep the fence; got: ' + String(after),
    );
  });

  // smoke-only: documents the immediate-retry contract — after a
  // failure, a subsequent fencedClaim call on the same key acquires.
  it('immediate retry after failure can re-acquire', async () => {
    await assert.rejects(async () => {
      await fencedClaim('test:fc:release-after-throw', async () => {
        throw new Error('first attempt fails');
      });
    });
    const out = await fencedClaim('test:fc:release-after-throw', async () => 'second');
    assert.equal(out.kind, 'ran');
    if (out.kind === 'ran') {
      assert.equal(out.result, 'second');
    }
  });
});

describe('Phase-4 R7: releaseFence helper', () => {
  // revert-proof: R6-Phase-4 — releaseFence is the exported
  // composition seam used by `withIdempotency` and any future caller
  // that needs to release a fenced claim from a custom catch path.
  // Removing the eval→DEL fallback regresses R5-FG-48 (eval failures
  // that left claims stuck for 24h).
  it('compare-and-DEL releases when fence matches', async () => {
    const redis = await getRedis();
    await redis.set('test:fc:rel', 'pending:abc', { nx: true, ex: 60 });
    await releaseFence('test:fc:rel', 'pending:abc');
    const after = await redis.get('test:fc:rel');
    assert.equal(after, null);
  });

  // revert-proof: R8-FG-14 / R5-FG-48 — when redis.eval throws
  // (cluster failover, mock without eval, transport blip),
  // releaseFence MUST fall back to a plain DEL so the claim is
  // not stuck for 24h. Pre-Phase-6 this fallback existed in
  // releaseFence's catch but had NO test — a regression that
  // deletes the fallback would not flip any assertion.
  it('releaseFence falls back to plain DEL when eval throws', async () => {
    const realRedis = await getRedis();
    await realRedis.set('test:fc:eval-fail', 'pending:abc', { nx: true, ex: 60 });

    // Inject an eval-throwing redis-like double via dynamic import
    // monkey-patch. The mock `eval` is what releaseFence calls; we
    // replace it temporarily with a thrower, run releaseFence, and
    // assert the key was DELed via the fallback.
    const original = (realRedis as { eval?: unknown }).eval;
    (realRedis as { eval: unknown }).eval = async (): Promise<never> => {
      throw new Error('simulated eval failure (cluster failover)');
    };
    try {
      await releaseFence('test:fc:eval-fail', 'pending:abc');
      // Restore eval before the get() call so the test runner sees
      // the post-fallback state cleanly.
    } finally {
      (realRedis as { eval: unknown }).eval = original;
    }
    const after = await realRedis.get('test:fc:eval-fail');
    assert.equal(after, null, 'eval-fail fallback DEL must clear the key');
  });

  // revert-proof: R6-Phase-4 — without the fence check the catch
  // path would nuke a sibling's claim that won the race after TTL.
  it('compare-and-DEL leaves a foreign fence intact', async () => {
    const redis = await getRedis();
    await redis.set('test:fc:rel-foreign', 'pending:sibling', { nx: true, ex: 60 });

    // Caller releases with a stale fence — should be a no-op.
    await releaseFence('test:fc:rel-foreign', 'pending:stale');

    const after = await redis.get('test:fc:rel-foreign');
    assert.equal(
      after,
      'pending:sibling',
      'foreign fence must be left intact; got: ' + String(after),
    );
    // Cleanup.
    await redis.del('test:fc:rel-foreign');
  });
});
