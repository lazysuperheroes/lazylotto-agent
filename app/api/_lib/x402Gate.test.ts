/**
 * F4 / F11 (2026-07-05 custodial audit): the x402 gate must NOT trust the
 * client-echoed `payload.accepted`. It must match the echo to a server-built
 * `accepts` entry (scheme/network/asset/payTo) and enforce the slippage floor
 * (minAcceptedFraction) before verify/settle — otherwise a buyer pays 1
 * tinybar (or pays themselves) and is granted a full-price rake holiday.
 *
 * These reject cases all return a `challenge` BEFORE the facilitator is
 * contacted, so no facilitator mock / network is needed.
 */

import { describe, it, expect } from 'vitest';
import type { PaymentRequirements } from '@x402/core/types';
import type { X402FeatureConfig } from '~/config/features';
import { settleOrChallenge } from './x402Gate';

const NET = 'hedera:testnet' as const;

const cfg: X402FeatureConfig = {
  enabled: true,
  facilitatorUrl: 'https://facilitator.example',
  network: NET,
  payTo: '0.0.5000',
  feePayer: '0.0.6000',
  maxTimeoutSeconds: 120,
  mirrorNodeUrl: 'https://mirror.example',
  usdcTokenId: '0.0.7777',
  recordToHcs20: false,
  rakeHoliday: { priceUsdCents: 500, durationDays: 30, minAcceptedFraction: 0.97 },
};

const serverReq = {
  scheme: 'exact',
  network: NET,
  asset: '0.0.7777',
  amount: '5000000', // $5.00 USDC (6 decimals)
  payTo: '0.0.5000',
  maxTimeoutSeconds: 120,
  extra: { feePayer: '0.0.6000' },
} as unknown as PaymentRequirements;

const accepts: PaymentRequirements[] = [serverReq];

function paymentRequest(accepted: unknown, x402Version = 2): Request {
  const header = Buffer.from(JSON.stringify({ x402Version, accepted })).toString('base64');
  return new Request('https://x/api/premium/rake-holiday', {
    method: 'POST',
    headers: { 'x-payment': header },
  });
}

function opts(request: Request) {
  return { request, cfg, accepts, resourceUrl: 'https://x/api/premium/rake-holiday', resourceDescription: 'rake holiday' };
}

describe('x402 gate F4/F11: reject spoofed / underpaid requirements', () => {
  // revert-proof: no X-PAYMENT must always 402; a regression returning
  // `settled` here would grant the capability for free.
  it('challenges (402) when no X-PAYMENT header is present', async () => {
    const res = await settleOrChallenge(opts(new Request('https://x', { method: 'POST' })));
    expect(res.kind).toBe('challenge');
  });

  // revert-proof: reverting to `requirements = payload.accepted` lets a
  // payTo=self spoof through to verify/settle; the server-match makes it
  // find no offered requirement → challenge.
  it('F4: rejects a payTo=self spoof (matches no offered requirement)', async () => {
    const res = await settleOrChallenge(opts(paymentRequest({ ...serverReq, payTo: '0.0.ATTACKER' })));
    expect(res.kind).toBe('challenge');
  });

  // revert-proof: a wrong-asset echo must not match the server offer; a
  // regression trusting the echo would settle against the cheaper asset.
  it('F4: rejects an asset mismatch (matches no offered requirement)', async () => {
    const res = await settleOrChallenge(opts(paymentRequest({ ...serverReq, asset: '0.0.WRONG' })));
    expect(res.kind).toBe('challenge');
  });

  // revert-proof: reverting the F11 slippage floor lets a 1-base-unit
  // payment settle a full-price holiday; the floor (0.97 × 5_000_000)
  // rejects it.
  it('F4/F11: rejects an underpayment far below the slippage floor', async () => {
    const res = await settleOrChallenge(opts(paymentRequest({ ...serverReq, amount: '1' })));
    expect(res.kind).toBe('challenge');
  });

  // revert-proof: dropping the x402Version check accepts a downgraded/forged
  // envelope; version 1 must be refused (the stack is v2).
  it('rejects a wrong x402 version', async () => {
    const res = await settleOrChallenge(opts(paymentRequest(serverReq, 1)));
    expect(res.kind).toBe('challenge');
  });
});
