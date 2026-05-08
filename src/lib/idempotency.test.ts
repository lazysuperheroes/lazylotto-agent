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
  /**
   * R4-FG-65: minimal eval shim. The production code uses
   * `redis.eval(RELEASE_SCRIPT, [key], [token])` for fenced
   * compare-and-DEL. The script is "if redis.call('get', KEYS[1])
   * == ARGV[1] then return redis.call('del', KEYS[1]) else return 0".
   * The mock implements the fence-check behaviour directly (we don't
   * run real Lua here).
   */
  eval(script: string, keys: string[], args: string[]): Promise<number>;
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
    async eval(_script, keys, args) {
      // Fence-check + delete. The script we substitute for is the
      // canonical RELEASE_SCRIPT from src/lib/locks.ts.
      const key = keys[0]!;
      const expected = args[0]!;
      const actual = store.get(key);
      if (actual === expected) {
        store.delete(key);
        return 1;
      }
      return 0;
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
      // R4-FG-65: claim is now `pending:<uuid>` (fenced) instead of
      // the literal `'pending'`; assert by prefix to remain
      // tolerant of either form.
      const v = mock.store.get('lla:testnet:idem:withdraw:userX:idem-uncertain');
      assert.ok(
        typeof v === 'string' && v.startsWith('pending'),
        `claim must persist as "pending*" so retries are bounced as in-flight (got ${String(v)})`,
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
      // R4-FG-65: claim is now fenced; assert by prefix.
      const v = mock.store.get('lla:testnet:idem:withdraw:userY:idem-custom');
      assert.ok(
        typeof v === 'string' && v.startsWith('pending'),
        `PreserveClaimError subclass must retain the claim (got ${String(v)})`,
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
      // R4-FG-65: claim is now fenced; assert by prefix.
      const v = mock.store.get('lla:testnet:idem:withdraw:userZ:idem-fake');
      assert.ok(
        typeof v === 'string' && v.startsWith('pending'),
        `name-based fallback must retain claim (got ${String(v)})`,
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

  // revert-proof: if R5-FG-48's eval-failure fallback DEL is removed
  // (catch reverted to bare swallow), this test fails — when the
  // RELEASE_SCRIPT eval throws, no fallback DEL runs, and the claim
  // sticks at `pending:<uuid>` for 24h. Sibling retries get
  // `kind:'in-flight'` for 24h with no recoverable signal.
  it('R5-FG-48: falls back to plain DEL when RELEASE_SCRIPT eval throws', async () => {
    const mock = makeMockRedis();
    // Force eval to throw so the fallback path engages.
    mock.eval = async () => {
      throw new Error('synthetic Redis cluster failover');
    };
    await withMockRedis(mock, async () => {
      const { withIdempotency } = await import('./idempotency.js');

      const body = async () => {
        throw new Error('non-PreserveClaim post-pre-submit failure');
      };

      await assert.rejects(
        () => withIdempotency('withdraw:userE', 'idem-eval-fail', body),
      );
      // Pre-fix the claim would still exist (eval threw, bare catch
      // swallowed it). Post-fix the plain DEL fallback fires and the
      // claim is gone — sibling retries can run.
      assert.equal(
        mock.store.get('lla:testnet:idem:withdraw:userE:idem-eval-fail') ?? null,
        null,
        'eval-failure must trigger the plain-DEL fallback so retries can recover',
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
