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
