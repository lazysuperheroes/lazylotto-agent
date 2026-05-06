/**
 * Regression test for the same Upstash auto-decode trap that hit
 * idempotency.ts: getKillSwitchState's JSON.parse threw on auto-decoded
 * objects, silently dropping the operator's `reason` / `enabledBy` /
 * `enabledAt` metadata so users only saw a generic "agent temporarily
 * closed" toast even when the operator engaged with a specific reason.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

interface MockRedis {
  store: Map<string, unknown>;
  set(key: string, value: string | number, options?: { nx?: boolean; ex?: number }): Promise<string | null>;
  get<T = unknown>(key: string): Promise<T | null>;
  del(...keys: string[]): Promise<number>;
}

function makeMockRedis(): MockRedis {
  const store = new Map<string, unknown>();
  return {
    store,
    async set(key, value) {
      // Mimic Upstash REST: auto-decode JSON-shaped strings on write,
      // so `get` returns the parsed object.
      if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
        try { store.set(key, JSON.parse(value)); }
        catch { store.set(key, value); }
      } else {
        store.set(key, value);
      }
      return 'OK';
    },
    async get<T = unknown>(key: string): Promise<T | null> {
      return (store.get(key) ?? null) as T | null;
    },
    async del(...keys: string[]): Promise<number> {
      let removed = 0;
      for (const k of keys) if (store.delete(k)) removed++;
      return removed;
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

describe('getKillSwitchState: Upstash auto-decode regression', () => {
  it('preserves reason / enabledAt / enabledBy across an auto-decoded round trip', async () => {
    const mock = makeMockRedis();
    await withMockRedis(mock, async () => {
      const { enableKillSwitch, getKillSwitchState, disableKillSwitch } =
        await import('./killswitch.js');

      await enableKillSwitch('Mainnet drain in progress', '0.0.operator');

      const state = await getKillSwitchState();
      assert.equal(state.enabled, true);
      assert.equal(state.reason, 'Mainnet drain in progress',
        'reason must round-trip through Upstash auto-decode (was silently dropped pre-fix)');
      assert.equal(state.enabledBy, '0.0.operator');
      assert.ok(state.enabledAt, 'enabledAt should be populated');

      await disableKillSwitch('0.0.operator');
      const after = await getKillSwitchState();
      assert.equal(after.enabled, false);
    });
  });

  it('returns enabled:true with no metadata for legacy plain-string flag', async () => {
    // Older deployments may have written the flag as a plain '1' or 'true'.
    // Ensure we still surface enabled:true gracefully.
    const mock = makeMockRedis();
    await withMockRedis(mock, async () => {
      const { getKillSwitchState } = await import('./killswitch.js');
      // Manually plant a non-JSON value, mimicking legacy state.
      mock.store.set('lla:testnet:killswitch', '1');
      const state = await getKillSwitchState();
      assert.equal(state.enabled, true);
      assert.equal(state.reason, undefined);
    });
  });
});
