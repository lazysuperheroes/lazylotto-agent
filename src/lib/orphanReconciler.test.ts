/**
 * Phase-6 Cluster F: orphan reconciler regression tests.
 *
 * Pre-Phase-6 the reconciler was dead code in dev and tests:
 *
 *   1. RedisLike had no `scan` method declared — the in-memory
 *      mock used `(redis as { scan? })` and silently fell through
 *      to a `break` when the method was undefined.
 *   2. EXPECTED_TTL_SEC registered only 5 of 9+ production claim
 *      namespaces (missed `refunded`, `escalated`, `killswitch`).
 *   3. The strict `value.startsWith('pending:')` filter excluded
 *      legitimate non-fenced claims (escalation = '1',
 *      killswitch = JSON state).
 *   4. No test file existed.
 *
 * These tests pin the post-Phase-6 contract: the reconciler can
 * actually walk the in-memory mock, sees every registered
 * namespace, surfaces stuck claims, and parses the `context`
 * suffix written by `fencedClaim`.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fencedClaim } from './fencedClaim.js';
import { findOrphanedClaims } from './orphanReconciler.js';
import { getRedis, KEY_PREFIX } from '../auth/redis.js';

describe('Phase-6 Cluster F: orphan reconciler regression', () => {
  beforeEach(async () => {
    // R9-FG-12 / Phase-7 Cluster G: clear ALL test keys including
    // the integration test's `:integration` seed. Pre-Phase-7 the
    // candidate list missed it — if test #4 panicked before its
    // tail cleanup, the key persisted across runs polluting test
    // #1's count assertions.
    const redis = await getRedis();
    const candidates = [
      `${KEY_PREFIX.idempotency}orphan-test:1`,
      `${KEY_PREFIX.idempotency}orphan-test:integration`,
      `${KEY_PREFIX.lockUser}orphan-test-user`,
      `${KEY_PREFIX.refunded}orphan-test-tx`,
    ];
    await Promise.all(candidates.map((k) => redis.del(k).catch(() => 0)));
  });

  // revert-proof: R8-FG-9 + R9-FG-12 — without `scan` on RedisLike,
  // the reconciler's `(redis as { scan? }).scan` probe finds undefined
  // and silently breaks out of every namespace loop. The mock
  // implementation makes the function actually return data; the
  // assertion below requires findOrphanedClaims to MOVE off zero
  // when stale claims are seeded. R9-FG-12: this test relies on
  // beforeEach cleaning `${KEY_PREFIX.idempotency}orphan-test:1`
  // before each run; if the cleanup candidate list regresses, this
  // test becomes flaky on warm-state runs.
  it('detects a stale fenced claim under idempotency namespace', async () => {
    const redis = await getRedis();
    // Seed a claim whose TTL is below the staleness threshold.
    // idempotency expected TTL is 24*60*60 = 86400; ratio 0.5 means
    // anything with remaining TTL <= 43200 is stale. We seed with
    // ex=10s so it's well past stale.
    await redis.set(
      `${KEY_PREFIX.idempotency}orphan-test:1`,
      'pending:abc-123',
      { nx: true, ex: 10 },
    );
    const orphans = await findOrphanedClaims({ staleThresholdRatio: 0.5 });
    const found = orphans.find(
      (o) => o.key === `${KEY_PREFIX.idempotency}orphan-test:1`,
    );
    assert.ok(found, `expected to find seeded orphan; got ${JSON.stringify(orphans)}`);
    assert.equal(found?.fence, 'pending:abc-123');
  });

  // revert-proof: R8-FG-26 — fencedClaim encodes `context` into
  // the fence value as `pending:<uuid>:<context>`. The reconciler
  // parses the suffix into `OrphanedClaim.context`. A regression
  // that drops the suffix encoding (or skips the suffix parse)
  // flips this test.
  it('parses context suffix from fence value', async () => {
    const redis = await getRedis();
    // fencedClaim's release-on-success would clean up the claim
    // before we observe it. Seed manually with the encoded suffix
    // so the reconciler sees it as held.
    await redis.set(
      `${KEY_PREFIX.lockUser}orphan-test-user`,
      'pending:f0f0-1111:test-subsystem',
      { nx: true, ex: 5 },
    );
    const orphans = await findOrphanedClaims({ staleThresholdRatio: 0.5 });
    const found = orphans.find(
      (o) => o.key === `${KEY_PREFIX.lockUser}orphan-test-user`,
    );
    assert.ok(found);
    assert.equal(found?.context, 'test-subsystem');
  });

  // revert-proof: R8-FG-9 — `refunded` namespace MUST be in
  // EXPECTED_TTL_SEC. Pre-Phase-6 stuck refund claims were
  // invisible to the reconciler. Removing the namespace from the
  // registry flips this assertion.
  it('walks the refunded namespace (Phase-6 newly-registered)', async () => {
    const redis = await getRedis();
    // refunded TTL is 30 days = 2592000s; seed with very short TTL
    // so the staleness ratio fires.
    await redis.set(
      `${KEY_PREFIX.refunded}orphan-test-tx`,
      'pending:r-9999',
      { nx: true, ex: 30 },
    );
    const orphans = await findOrphanedClaims({ staleThresholdRatio: 0.5 });
    const found = orphans.find(
      (o) => o.key === `${KEY_PREFIX.refunded}orphan-test-tx`,
    );
    assert.ok(found, `expected orphan in refunded namespace; got ${orphans.length} total`);
    assert.equal(found?.kind.includes('refunded'), true);
  });

  // smoke-only: integration check that fencedClaim writes a fence
  // the reconciler can later observe. Simulates a claim held by a
  // sibling Lambda via direct seed (the body would normally release
  // on completion — here we want the seed to remain).
  it('fencedClaim integration — seeded claim shows up after release-skip', async () => {
    const redis = await getRedis();
    // fencedClaim with a context option writes `pending:<uuid>:ctx`.
    // We invoke it with a body that throws PreserveClaimError so
    // the claim is kept (mimicking the pending-on-chain case).
    const { ReceiptUncertainError } = await import('../hedera/transfers.js');
    await assert.rejects(async () => {
      await fencedClaim(
        `${KEY_PREFIX.idempotency}orphan-test:integration`,
        async () => {
          throw new ReceiptUncertainError('0.0.X@1.0');
        },
        { ttlSec: 10, context: 'integration-test' },
      );
    });
    // Seeded; observed via reconciler.
    const orphans = await findOrphanedClaims({ staleThresholdRatio: 0.5 });
    const found = orphans.find(
      (o) => o.key === `${KEY_PREFIX.idempotency}orphan-test:integration`,
    );
    assert.ok(found, 'PreserveClaim path must keep the fence; reconciler must see it');
    assert.equal(found?.context, 'integration-test');
    // Cleanup.
    await redis.del(`${KEY_PREFIX.idempotency}orphan-test:integration`).catch(() => 0);
  });
});
