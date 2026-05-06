/**
 * Unit tests for `escalateUncertainDlFailure`.
 *
 * Covers:
 *  - No webhook configured → no fetch attempted, no throw
 *  - Webhook fires with the expected payload shape per kind
 *  - Webhook fetch failure is swallowed (caller is in a degraded
 *    state already; throwing here would mask the underlying error)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
const originalWebhookEnv = process.env.RECONCILE_FAILURE_WEBHOOK_URL;

interface FetchCall {
  url: string;
  init: RequestInit;
}

function installFetch(behavior: 'ok' | 'throw' | 'reject'): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    if (behavior === 'throw') throw new Error('synthetic network error');
    if (behavior === 'reject') return new Response(null, { status: 500 });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  return { calls };
}

describe('escalateUncertainDlFailure', () => {
  beforeEach(() => {
    delete process.env.RECONCILE_FAILURE_WEBHOOK_URL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWebhookEnv === undefined) {
      delete process.env.RECONCILE_FAILURE_WEBHOOK_URL;
    } else {
      process.env.RECONCILE_FAILURE_WEBHOOK_URL = originalWebhookEnv;
    }
  });

  it('no-op when RECONCILE_FAILURE_WEBHOOK_URL is unset', async () => {
    const { calls } = installFetch('ok');
    const { escalateUncertainDlFailure } = await import('./escalation.js');
    await escalateUncertainDlFailure({
      kind: 'refund_uncertain',
      uncertainTxId: 'tx-1',
      cause: new Error('boom'),
    });
    assert.equal(calls.length, 0, 'no fetch when webhook URL absent');
  });

  it('fires the webhook with a Slack/Discord-shaped { text } body', async () => {
    process.env.RECONCILE_FAILURE_WEBHOOK_URL = 'https://hooks.example.com/xyz';
    const { calls } = installFetch('ok');
    const { escalateUncertainDlFailure } = await import('./escalation.js');
    await escalateUncertainDlFailure({
      kind: 'withdrawal_uncertain',
      uncertainTxId: '0.0.1234@1700000000.000000001',
      userId: 'user-A',
      cause: new Error('redis hiccup'),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://hooks.example.com/xyz');
    const body = JSON.parse(calls[0]!.init.body as string) as { text: string };
    assert.match(body.text, /withdrawal_uncertain/);
    assert.match(body.text, /0\.0\.1234@1700000000\.000000001/);
    assert.match(body.text, /user-A/);
    assert.match(body.text, /redis hiccup/);
  });

  it('does not include user line when userId is omitted (operator-fee path)', async () => {
    process.env.RECONCILE_FAILURE_WEBHOOK_URL = 'https://hooks.example.com/xyz';
    const { calls } = installFetch('ok');
    const { escalateUncertainDlFailure } = await import('./escalation.js');
    await escalateUncertainDlFailure({
      kind: 'operator_fee_withdraw_uncertain',
      uncertainTxId: 'tx-op',
      cause: 'string cause',
    });
    const body = JSON.parse(calls[0]!.init.body as string) as { text: string };
    assert.doesNotMatch(body.text, /User:/);
  });

  it('swallows webhook fetch failure (does not throw)', async () => {
    process.env.RECONCILE_FAILURE_WEBHOOK_URL = 'https://hooks.example.com/xyz';
    installFetch('throw');
    const { escalateUncertainDlFailure } = await import('./escalation.js');
    // Should not throw — the caller is already in a degraded state.
    await escalateUncertainDlFailure({
      kind: 'play_uncertain',
      uncertainTxId: 'tx-play',
      userId: 'user-B',
      cause: new Error('boom'),
    });
  });

  it('handles non-Error cause objects via String() coercion', async () => {
    process.env.RECONCILE_FAILURE_WEBHOOK_URL = 'https://hooks.example.com/xyz';
    const { calls } = installFetch('ok');
    const { escalateUncertainDlFailure } = await import('./escalation.js');
    await escalateUncertainDlFailure({
      kind: 'refund_uncertain',
      uncertainTxId: 'tx-z',
      cause: { code: 'EREDIS', detail: 'connection refused' } as unknown,
    });
    const body = JSON.parse(calls[0]!.init.body as string) as { text: string };
    assert.ok(body.text.length > 0, 'must produce a non-empty payload');
  });
});
