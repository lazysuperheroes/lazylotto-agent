/**
 * Regression test for the Upstash auto-decode trap that the 0.3.3 audit
 * caught: `redis.get<string>(...)` followed by unconditional `JSON.parse`
 * silently downgrades `duplicate` results to `in-flight` because Upstash
 * REST auto-deserializes JSON values and `JSON.parse(object)` throws.
 *
 * The fix is the explicit `typeof raw === 'string' ? JSON.parse(raw) : raw`
 * guard. These tests pin that contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// We import lazily so the test can swap getRedis behaviour.
// `getRedis` lives on a globalThis singleton — we override it via
// the global mutation pattern documented in src/auth/redis.ts.

interface MockRedis {
  store: Map<string, unknown>;
  set(key: string, value: string | number, options?: { nx?: boolean; ex?: number }): Promise<string | null>;
  get<T = unknown>(key: string): Promise<T | null>;
  del(key: string): Promise<number>;
}

function makeMockRedis(): MockRedis {
  const store = new Map<string, unknown>();
  return {
    store,
    async set(key, value, options) {
      if (options?.nx && store.has(key)) return null;
      // Critical: if `value` looks like JSON, we store it as a parsed
      // object — that's exactly what Upstash REST does.
      if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
        try {
          store.set(key, JSON.parse(value));
        } catch {
          store.set(key, value);
        }
      } else {
        store.set(key, value);
      }
      return 'OK';
    },
    async get<T = unknown>(key: string): Promise<T | null> {
      return (store.get(key) ?? null) as T | null;
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
  };
}

async function withMockRedis<T>(mock: MockRedis, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as { __lazylottoRedisClient__?: unknown };
  const prev = g.__lazylottoRedisClient__;
  g.__lazylottoRedisClient__ = mock;
  try {
    return await fn();
  } finally {
    g.__lazylottoRedisClient__ = prev;
  }
}

describe('withIdempotency: Upstash auto-decode regression', () => {
  it('returns kind=duplicate even when Redis backend auto-decodes the stored JSON', async () => {
    const mock = makeMockRedis();
    await withMockRedis(mock, async () => {
      const { withIdempotency } = await import('./idempotency.js');

      let callCount = 0;
      const body = async () => {
        callCount++;
        return { transactionId: 'tx-123', amount: 50 };
      };

      // First call writes the result. Our mock stores it as a parsed
      // object (mimicking Upstash REST auto-decode behaviour).
      const first = await withIdempotency('withdraw:user-1', 'idem-A', body);
      assert.equal(first.kind, 'fresh');

      // Second call must return `duplicate` with the stored result —
      // pre-fix this returned `in-flight` because JSON.parse(<object>)
      // threw SyntaxError and the catch returned in-flight.
      const second = await withIdempotency('withdraw:user-1', 'idem-A', body);
      assert.equal(second.kind, 'duplicate', 'auto-decoded object must round-trip as duplicate, not in-flight');
      if (second.kind !== 'duplicate') return;
      assert.deepStrictEqual(second.result, { transactionId: 'tx-123', amount: 50 });
      assert.equal(callCount, 1, 'body must NOT have run a second time');
    });
  });

  it('returns kind=duplicate when Redis returns a JSON string (older client behaviour)', async () => {
    // Defensive variant: the typeof guard should also work if the backend
    // returns a string (e.g. PersistentStore in-memory mode, or older
    // Upstash SDK builds).
    const mock = makeMockRedis();
    // Force string storage by bypassing the auto-decode branch.
    mock.set = async (key, value, options) => {
      if (options?.nx && mock.store.has(key)) return null;
      mock.store.set(key, String(value));
      return 'OK';
    };

    await withMockRedis(mock, async () => {
      const { withIdempotency } = await import('./idempotency.js');
      const body = async () => ({ transactionId: 'tx-456' });

      await withIdempotency('withdraw:user-2', 'idem-B', body);
      const second = await withIdempotency('withdraw:user-2', 'idem-B', body);
      assert.equal(second.kind, 'duplicate');
      if (second.kind !== 'duplicate') return;
      assert.deepStrictEqual(second.result, { transactionId: 'tx-456' });
    });
  });
});

// ── PreserveClaim retention (H9) ──────────────────────────────────
// `withIdempotency` MUST keep the SET-NX-EX claim when the body
// throws a `PreserveClaimError` subclass (today: ReceiptUncertainError).
// Releasing the claim would let a retry execute a second on-chain
// action that, combined with a successful original, double-spends.

describe('withIdempotency: PreserveClaim retention', () => {
  it('keeps the claim on ReceiptUncertainError (canonical subclass)', async () => {
    const mock = makeMockRedis();
    await withMockRedis(mock, async () => {
      const { withIdempotency } = await import('./idempotency.js');
      const { ReceiptUncertainError } = await import('../hedera/transfers.js');

      const body = async () => {
        throw new ReceiptUncertainError('0.0.1234@1700000000.000000001');
      };

      await assert.rejects(
        () => withIdempotency('withdraw:userX', 'idem-uncertain', body),
        ReceiptUncertainError,
      );
      // The pending claim must remain — pre-fix, the catch DEL'd it.
      assert.equal(
        mock.store.get('lla:testnet:idem:withdraw:userX:idem-uncertain'),
        'pending',
        'claim must persist as "pending" so retries are bounced as in-flight',
      );
    });
  });

  it('keeps the claim on a generic PreserveClaimError subclass', async () => {
    const mock = makeMockRedis();
    await withMockRedis(mock, async () => {
      const { withIdempotency } = await import('./idempotency.js');
      const { PreserveClaimError } = await import('../hedera/transfers.js');

      class CustomPreserveError extends PreserveClaimError {
        constructor() {
          super('hypothetical post-submit failure');
          this.name = 'CustomPreserveError';
        }
      }

      const body = async () => {
        throw new CustomPreserveError();
      };

      await assert.rejects(
        () => withIdempotency('withdraw:userY', 'idem-custom', body),
        CustomPreserveError,
      );
      assert.equal(
        mock.store.get('lla:testnet:idem:withdraw:userY:idem-custom'),
        'pending',
        'PreserveClaimError subclass must retain the claim',
      );
    });
  });

  it('preserves claim via name-based fallback when instanceof fails (cross-bundle)', async () => {
    // Simulate a cross-module-identity hazard: an error whose name is
    // 'ReceiptUncertainError' but whose prototype chain doesn't pass
    // `instanceof PreserveClaimError`. Defense in depth fallback.
    const mock = makeMockRedis();
    await withMockRedis(mock, async () => {
      const { withIdempotency } = await import('./idempotency.js');
      const fakeUncertain = new Error('cross-bundle uncertain');
      fakeUncertain.name = 'ReceiptUncertainError';

      const body = async () => {
        throw fakeUncertain;
      };

      await assert.rejects(
        () => withIdempotency('withdraw:userZ', 'idem-fake', body),
        (err: unknown) => err === fakeUncertain,
      );
      assert.equal(
        mock.store.get('lla:testnet:idem:withdraw:userZ:idem-fake'),
        'pending',
        'name-based fallback must retain claim for cross-module ReceiptUncertainError',
      );
    });
  });

  it('DELs the claim on a plain Error (confirmed failure)', async () => {
    const mock = makeMockRedis();
    await withMockRedis(mock, async () => {
      const { withIdempotency } = await import('./idempotency.js');

      const body = async () => {
        throw new Error('confirmed pre-submit failure');
      };

      await assert.rejects(
        () => withIdempotency('withdraw:userW', 'idem-fail', body),
      );
      assert.equal(
        mock.store.get('lla:testnet:idem:withdraw:userW:idem-fail') ?? null,
        null,
        'confirmed-failure error must release the claim so a retry can run',
      );
    });
  });
});

describe('isPreserveClaim guard', () => {
  it('returns true for ReceiptUncertainError', async () => {
    const { isPreserveClaim } = await import('./idempotency.js');
    const { ReceiptUncertainError } = await import('../hedera/transfers.js');
    assert.equal(isPreserveClaim(new ReceiptUncertainError('tx')), true);
  });

  it('returns true for any PreserveClaimError subclass', async () => {
    const { isPreserveClaim } = await import('./idempotency.js');
    const { PreserveClaimError } = await import('../hedera/transfers.js');
    class Sub extends PreserveClaimError {}
    assert.equal(isPreserveClaim(new Sub()), true);
  });

  it('returns true via name fallback for non-instanceof ReceiptUncertainError', async () => {
    const { isPreserveClaim } = await import('./idempotency.js');
    const fake = new Error('x');
    fake.name = 'ReceiptUncertainError';
    assert.equal(isPreserveClaim(fake), true);
  });

  it('returns false for plain Error', async () => {
    const { isPreserveClaim } = await import('./idempotency.js');
    assert.equal(isPreserveClaim(new Error('x')), false);
  });

  it('returns false for non-Error values', async () => {
    const { isPreserveClaim } = await import('./idempotency.js');
    assert.equal(isPreserveClaim(null), false);
    assert.equal(isPreserveClaim('string'), false);
    assert.equal(isPreserveClaim({ name: 'ReceiptUncertainError' }), false);
  });
});
