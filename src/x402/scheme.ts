/**
 * x402-on-Hedera scheme wiring for the rake-holiday gate.
 *
 * Uses the x402-foundation packages (NOT Coinbase's EVM-only `x402-next`):
 *   - `@x402/core/http`  → HTTPFacilitatorClient (verify + settle).
 *   - `@x402/core/types` → the wire types (PaymentRequirements/PaymentPayload).
 *   - `@x402/hedera`     → Hedera constants (HBAR asset id, etc.).
 *
 * The server only builds PaymentRequirements + calls the facilitator's
 * verify/settle. The buyer's wallet builds + signs the transfer (client side);
 * the facilitator co-signs the fee and submits.
 *
 * NOTE: this path can only be exercised end-to-end against a live facilitator
 * with a paying client — it needs UAT, not just a build.
 */

import { HTTPFacilitatorClient } from '@x402/core/http';
import type { PaymentRequirements, PaymentPayload, Network } from '@x402/core/types';
import { HBAR_ASSET_ID, HEDERA_USDC_DECIMALS } from '@x402/hedera';
import type { X402FeatureConfig } from '../config/features.js';
import {
  fetchExchangeRate,
  usdCentsToTinybars,
  usdCentsToUsdcBaseUnits,
} from './exchangeRate.js';

/**
 * x402 protocol version. The x402-foundation stack (@x402/core) and the
 * Blocky402 facilitator both use version 2 — verified against the facilitator's
 * /supported endpoint. (Coinbase's original x402 used 1; don't confuse them.)
 */
export const X402_VERSION = 2;

const EXACT = 'exact';

let cachedFacilitator: HTTPFacilitatorClient | null = null;

export function getFacilitator(cfg: X402FeatureConfig): HTTPFacilitatorClient {
  if (!cachedFacilitator) {
    cachedFacilitator = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
  }
  return cachedFacilitator;
}

/**
 * Build the accepted payment options for a USD-cent price: USDC (1:1) AND the
 * live HBAR equivalent (quoted from the mirror-node exchange rate). The client
 * picks one. The HBAR quote is locked at request time; the x402 gate
 * (settleOrChallenge) enforces the configured slippage floor
 * (rakeHoliday.minAcceptedFraction) at settlement — F4/F11.
 */
/**
 * Human-readable token amount for DISPLAY only — the protocol `amount` stays in
 * atomic units (tinybars / base units). e.g. "63.15 HBAR", "5.00 USDC".
 */
function humanAmount(asset: string, atomic: string): string {
  const n = Number(atomic);
  if (asset === HBAR_ASSET_ID) {
    const hbar = n / 1e8;
    return `${hbar.toFixed(hbar < 1 ? 4 : 2)} HBAR`;
  }
  return `${(n / 10 ** HEDERA_USDC_DECIMALS).toFixed(2)} USDC`;
}

export async function buildRakeHolidayRequirements(
  cfg: X402FeatureConfig,
): Promise<PaymentRequirements[]> {
  const network = cfg.network as Network;
  const cents = cfg.rakeHoliday.priceUsdCents;
  const priceUsd = `$${(cents / 100).toFixed(2)}`;
  const base = {
    scheme: EXACT,
    network,
    payTo: cfg.payTo,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds,
  };

  // USDC: 1:1 with USD, 6 decimals.
  const usdcAmount = String(usdCentsToUsdcBaseUnits(cents));
  const usdc: PaymentRequirements = {
    ...base,
    asset: cfg.usdcTokenId,
    amount: usdcAmount,
    // `display`/`priceUsd` are human-readable enrichment alongside the atomic
    // `amount`; any UI/chat reads these so it never shows a raw integer.
    extra: {
      feePayer: cfg.feePayer,
      priceUsd,
      display: humanAmount(cfg.usdcTokenId, usdcAmount),
    },
  };

  // HBAR: live-rate equivalent, in tinybars.
  const rate = await fetchExchangeRate(cfg.mirrorNodeUrl);
  const hbarAmount = String(usdCentsToTinybars(cents, rate));
  const hbar: PaymentRequirements = {
    ...base,
    asset: HBAR_ASSET_ID,
    amount: hbarAmount,
    extra: {
      feePayer: cfg.feePayer,
      priceUsd,
      display: humanAmount(HBAR_ASSET_ID, hbarAmount),
    },
  };

  return [usdc, hbar];
}

/** Decode the `X-PAYMENT` header (base64 JSON) into a PaymentPayload. */
export function decodePaymentHeader(header: string): PaymentPayload {
  const json = Buffer.from(header, 'base64').toString('utf8');
  return JSON.parse(json) as PaymentPayload;
}
