/**
 * Hedera HBAR<->USD exchange rate (mirror node) + USD-denominated price
 * conversions for the x402 rake-holiday gate.
 *
 * Rate definition (GET /api/v1/network/exchangerate):
 *   `hbar_equivalent` HBAR is worth `cent_equivalent` cents, so
 *     USD per HBAR = cent_equivalent / hbar_equivalent / 100.
 * The `/100` (cents→dollars) is baked into the rate — do NOT apply it twice.
 */

export interface HederaExchangeRate {
  centEquivalent: number;
  hbarEquivalent: number;
}

/** USDC on Hedera has 6 decimals: 1 cent = 1e4 base units. */
const USDC_BASE_UNITS_PER_CENT = 10_000;

/** Fetch the current HBAR<->USD rate from the mirror node. */
export async function fetchExchangeRate(
  mirrorNodeUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HederaExchangeRate> {
  const res = await fetchImpl(`${mirrorNodeUrl}/api/v1/network/exchangerate`);
  if (!res.ok) {
    throw new Error(`exchangerate fetch failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    current_rate?: { cent_equivalent?: number; hbar_equivalent?: number };
  };
  const cent = body.current_rate?.cent_equivalent;
  const hbar = body.current_rate?.hbar_equivalent;
  if (!cent || !hbar) {
    throw new Error('exchangerate: malformed current_rate');
  }
  return { centEquivalent: cent, hbarEquivalent: hbar };
}

/**
 * Convert USD cents to tinybars at the given rate. 1 HBAR = 1e8 tinybars.
 *   tinybars(N cents) = round(N * hbar_equivalent / cent_equivalent * 1e8)
 * e.g. $5.00 (500c) at cent=243159, hbar=30000 (~$0.081/HBAR) ≈ 61.7 HBAR.
 */
export function usdCentsToTinybars(
  cents: number,
  rate: HederaExchangeRate,
): number {
  return Math.round((cents * rate.hbarEquivalent) / rate.centEquivalent * 1e8);
}

/** Inverse: the USD-cent value of a tinybar amount (used for slippage checks). */
export function tinybarsToUsdCents(
  tinybars: number,
  rate: HederaExchangeRate,
): number {
  return ((tinybars / 1e8) * rate.centEquivalent) / rate.hbarEquivalent;
}

/** Convert USD cents to USDC base units (6 decimals). $5.00 → 5_000_000. */
export function usdCentsToUsdcBaseUnits(cents: number): number {
  return Math.round(cents * USDC_BASE_UNITS_PER_CENT);
}
