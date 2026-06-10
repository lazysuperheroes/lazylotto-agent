import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRakeHolidayActive,
  getEffectiveRakePercent,
  grantRakeHoliday,
  getRakeHoliday,
} from './rakeHoliday.js';

const NOW = 1_700_000_000_000;

// revert-proof: with no holiday, the user's base rake applies unchanged. The
// effective-rake resolver MUST be a no-op when nobody has paid for a holiday.
test('getEffectiveRakePercent returns the base rake when no holiday is active', async () => {
  const u = 'rh-user-none';
  assert.equal(await isRakeHolidayActive(u), false);
  assert.equal(await getEffectiveRakePercent(u, 5), 5);
});

// revert-proof: a granted holiday zeroes the effective rake — this is the paid
// capability. creditDeposit is unchanged; only the rate passed into it is 0.
test('a granted holiday makes the effective rake 0', async () => {
  const u = 'rh-user-active';
  await grantRakeHoliday({
    userId: u,
    durationDays: 30,
    settlementTxId: 'tx-a',
    priceUsdCents: 500,
    asset: 'hbar',
    amount: '6169000000',
    nowMs: NOW,
  });
  assert.equal(await isRakeHolidayActive(u), true);
  assert.equal(await getEffectiveRakePercent(u, 5), 0);
});

// revert-proof: a holiday grant is idempotent per settlement tx id — replaying
// the same on-chain payment must NOT stack/extend or double-process.
test('grantRakeHoliday is idempotent per settlement tx id', async () => {
  const u = 'rh-user-idem';
  const first = await grantRakeHoliday({
    userId: u,
    durationDays: 30,
    settlementTxId: 'tx-dup',
    priceUsdCents: 500,
    asset: 'hbar',
    amount: '1',
    nowMs: NOW,
  });
  assert.equal(first.alreadyProcessed, false);
  const second = await grantRakeHoliday({
    userId: u,
    durationDays: 30,
    settlementTxId: 'tx-dup',
    priceUsdCents: 500,
    asset: 'hbar',
    amount: '1',
    nowMs: NOW + 1000,
  });
  assert.equal(second.alreadyProcessed, true);
});

// revert-proof: the grant records an until-timestamp exactly one window ahead.
test('grantRakeHoliday records an until-timestamp one window ahead', async () => {
  const u = 'rh-user-until';
  const { grant } = await grantRakeHoliday({
    userId: u,
    durationDays: 30,
    settlementTxId: 'tx-until',
    priceUsdCents: 500,
    asset: 'hbar',
    amount: '1',
    nowMs: NOW,
  });
  assert.equal(grant.untilMs, NOW + 30 * 86_400_000);
  const read = await getRakeHoliday(u);
  assert.equal(read?.settlementTxId, 'tx-until');
});

// revert-proof: getRakeHoliday must survive Upstash REST auto-deserialization,
// where get() returns the ALREADY-PARSED object (the in-memory fallback returns
// the raw string we stored). Pre-fix this called `JSON.parse(v)` unconditionally;
// on an object that threw SyntaxError → caught → null, so the dashboard silently
// showed the BASE rate while a holiday was active (deposits were still credited
// at 0% because isRakeHolidayActive only checks key presence — masking the bug).
test('getRakeHoliday handles an already-parsed (Upstash) object from get', async () => {
  const grant = {
    userId: 'rh-upstash',
    grantedAtMs: NOW,
    untilMs: NOW + 30 * 86_400_000,
    settlementTxId: 'tx-upstash',
    priceUsdCents: 500,
    asset: 'hbar',
    amount: '1',
  };
  const g = globalThis as unknown as { __lazylottoRedisClient__?: unknown };
  const prev = g.__lazylottoRedisClient__;
  // Upstash returns the parsed object, not the JSON string we stored.
  g.__lazylottoRedisClient__ = { get: async () => grant };
  try {
    const read = await getRakeHoliday('rh-upstash');
    assert.equal(read?.settlementTxId, 'tx-upstash');
    assert.equal(read?.untilMs, grant.untilMs);
  } finally {
    g.__lazylottoRedisClient__ = prev;
  }
});
