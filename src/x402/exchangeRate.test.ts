import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  usdCentsToTinybars,
  tinybarsToUsdCents,
  usdCentsToUsdcBaseUnits,
  fetchExchangeRate,
} from './exchangeRate.js';

const RATE = { centEquivalent: 243159, hbarEquivalent: 30000 }; // ≈ $0.081/HBAR

// revert-proof: USD→HBAR uses cent_equivalent/hbar_equivalent with the /100
// baked into the rate (NOT applied twice). $5.00 ≈ 61.7 HBAR at this rate —
// guards against the factor-of-10 conversion slip.
test('usdCentsToTinybars: $5.00 ≈ 61.7 HBAR at ~$0.081/HBAR', () => {
  const hbar = usdCentsToTinybars(500, RATE) / 1e8;
  assert.ok(hbar > 61 && hbar < 62.5, `expected ~61.7 HBAR, got ${hbar}`);
});

// revert-proof: USDC is 6-decimal; 1 cent = 1e4 base units, so $5 = 5_000_000.
test('usdCentsToUsdcBaseUnits: $5.00 = 5_000_000 base units', () => {
  assert.equal(usdCentsToUsdcBaseUnits(500), 5_000_000);
});

// revert-proof: tinybars→cents is the inverse of cents→tinybars (slippage check).
test('tinybarsToUsdCents round-trips cents→tinybars→cents', () => {
  const tb = usdCentsToTinybars(500, RATE);
  const cents = tinybarsToUsdCents(tb, RATE);
  assert.ok(Math.abs(cents - 500) < 1, `round-trip off: ${cents}`);
});

// revert-proof: the parser reads current_rate.{cent,hbar}_equivalent.
test('fetchExchangeRate parses current_rate from the mirror node', async () => {
  const fake = (async () => ({
    ok: true,
    json: async () => ({
      current_rate: {
        cent_equivalent: 243159,
        hbar_equivalent: 30000,
        expiration_time: 1,
      },
    }),
  })) as unknown as typeof fetch;
  const rate = await fetchExchangeRate('https://m.test', fake);
  assert.equal(rate.centEquivalent, 243159);
  assert.equal(rate.hbarEquivalent, 30000);
});
