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

  // The client echoes back the option it chose to pay.
  const requirements = payload.accepted;
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
