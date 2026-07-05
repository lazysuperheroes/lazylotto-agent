/**
 * Generic x402 gate: given a request + the accepted PaymentRequirements, either
 * return a 402 challenge (no / invalid / unsettled payment) or report a settled
 * payment. The ONLY x402-aware route glue — capability routes call this and act
 * on the result.
 *
 * Flow:
 *   no X-PAYMENT        → 402 with PaymentRequired { accepts }
 *   X-PAYMENT present   → facilitator.verify → facilitator.settle
 *                         success → { kind: 'settled', settlement }
 *                         else    → 402 with an error
 */

import { NextResponse } from 'next/server';
import type {
  PaymentRequirements,
  PaymentRequired,
  SettleResponse,
} from '@x402/core/types';
import { CORS_HEADERS } from './auth';
import type { X402FeatureConfig } from '~/config/features';
import { getFacilitator, decodePaymentHeader, X402_VERSION } from '~/x402/scheme';

export type X402GateResult =
  | { kind: 'challenge'; response: NextResponse }
  | {
      kind: 'settled';
      settlement: SettleResponse;
      paidRequirements: PaymentRequirements;
    };

export async function settleOrChallenge(opts: {
  request: Request;
  cfg: X402FeatureConfig;
  accepts: PaymentRequirements[];
  resourceUrl: string;
  resourceDescription: string;
}): Promise<X402GateResult> {
  const { request, cfg, accepts, resourceUrl, resourceDescription } = opts;

  const challenge = (error?: string): NextResponse => {
    const body: PaymentRequired = {
      x402Version: X402_VERSION,
      ...(error ? { error } : {}),
      resource: { url: resourceUrl, description: resourceDescription },
      accepts,
    };
    return NextResponse.json(body, { status: 402, headers: CORS_HEADERS });
  };

  const header = request.headers.get('x-payment');
  if (!header) return { kind: 'challenge', response: challenge() };

  let payload;
  try {
    payload = decodePaymentHeader(header);
  } catch {
    return { kind: 'challenge', response: challenge('Malformed X-PAYMENT header.') };
  }

  // F4 (2026-07-05 custodial audit): NEVER trust the client-echoed
  // `payload.accepted`. The client may only CHOOSE which server-built
  // option to pay — it cannot redefine the recipient, asset, network, or
  // (below) underpay. Match the echo to a server `accepts` entry by
  // (scheme, network, asset, payTo); a spoofed payTo=self or a fabricated
  // requirement finds no match and is refused. Pre-fix the gate passed the
  // client object straight to verify/settle, so a buyer could pay 1 tinybar
  // (or pay themselves) and be granted a full-price rake holiday.
  const chosen = payload.accepted as PaymentRequirements | undefined;
  const serverReq = chosen
    ? accepts.find(
        (a) =>
          a.scheme === chosen.scheme &&
          a.network === chosen.network &&
          a.asset === chosen.asset &&
          a.payTo === chosen.payTo,
      )
    : undefined;
  if (!chosen || !serverReq) {
    return {
      kind: 'challenge',
      response: challenge(
        'Payment does not match any offered requirement (scheme/network/asset/payTo).',
      ),
    };
  }
  if ((payload as { x402Version?: number }).x402Version !== X402_VERSION) {
    return {
      kind: 'challenge',
      response: challenge(`Unsupported x402 version (expected ${X402_VERSION}).`),
    };
  }

  // F11 (2026-05-06 audit): enforce the slippage floor. The buyer signed
  // against the request-time quote (serverReq.amount); a rate move within
  // the window is tolerated down to cfg.rakeHoliday.minAcceptedFraction,
  // but a spoofed underpayment is refused. Integer math over base units.
  let paidAmount: bigint;
  let serverAmount: bigint;
  try {
    paidAmount = BigInt(chosen.amount);
    serverAmount = BigInt(serverReq.amount);
  } catch {
    return { kind: 'challenge', response: challenge('Malformed payment amount.') };
  }
  const minFraction = cfg.rakeHoliday.minAcceptedFraction;
  const floor = (serverAmount * BigInt(Math.round(minFraction * 10_000))) / 10_000n;
  if (paidAmount < floor) {
    return {
      kind: 'challenge',
      response: challenge(
        `Payment ${paidAmount} below the minimum ${floor} ` +
          `(server quote ${serverAmount} × min fraction ${minFraction}).`,
      ),
    };
  }

  // Verify/settle against a SERVER-authoritative requirement: the server's
  // recipient/asset/network/scheme, carrying only the buyer's signed amount
  // (which the facilitator checks against the on-chain transfer, and which
  // we just floored). The client can no longer smuggle a cheaper or forged
  // requirement into verify/settle.
  const requirements: PaymentRequirements = { ...serverReq, amount: chosen.amount };
  const facilitator = getFacilitator(cfg);

  const verifyRes = await facilitator.verify(payload, requirements);
  if (!verifyRes.isValid) {
    return {
      kind: 'challenge',
      response: challenge(verifyRes.invalidReason ?? 'Payment verification failed.'),
    };
  }

  const settleRes = await facilitator.settle(payload, requirements);
  if (!settleRes.success) {
    return {
      kind: 'challenge',
      response: challenge(settleRes.errorReason ?? 'Payment settlement failed.'),
    };
  }

  return { kind: 'settled', settlement: settleRes, paidRequirements: requirements };
}
