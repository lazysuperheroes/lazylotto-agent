/**
 * Price oracle for token-to-USD conversion.
 *
 * Sources:
 *  - HBAR/USD: Mirror node /api/v1/network/exchangerate (testnet + mainnet)
 *  - Token/HBAR: SaucerSwap REST API (mainnet only, needs API key)
 *  - Token/USD: derived as tokenHbarPrice * hbarUsdPrice
 *
 * Design:
 *  - Never throws — returns null on any failure
 *  - In-memory cache with configurable TTL
 *  - getCachedUsdPrice() is synchronous (reads from cache only)
 *  - refresh() is async (fetches fresh prices)
 *  - Testnet: HBAR/USD works, token prices return null
 */

import { HEDERA_DEFAULTS } from '../config/defaults.js';
import { HBAR_TOKEN_KEY } from '../config/strategy.js';

interface PriceEntry {
  usdPrice: number;
  fetchedAt: number;
}

interface ExchangeRateResponse {
  current_rate: {
    cent_equivalent: number;
    hbar_equivalent: number;
    expiration_time: number;
  };
  next_rate: {
    cent_equivalent: number;
    hbar_equivalent: number;
    expiration_time: number;
  };
}

export class PriceOracle {
  private cache: Map<string, PriceEntry> = new Map();
  private cacheTtlMs: number;
  private tokenRegistry: Map<string, string> = new Map(); // symbol → tokenId

  constructor(config?: { cacheTtlMs?: number }) {
    this.cacheTtlMs = config?.cacheTtlMs ?? 300_000; // 5 min default
  }

  // ── Async queries (fetch from network) ────────────────────

  /** Fetch HBAR/USD price from mirror node exchange rate. */
  async getHbarUsdPrice(): Promise<number | null> {
    try {
      const network = (process.env.HEDERA_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';
      const baseUrl = HEDERA_DEFAULTS.mirrorNodeUrl[network];
      const res = await fetch(`${baseUrl}/network/exchangerate`);
      if (!res.ok) return null;

      const data = (await res.json()) as ExchangeRateResponse;
      const rate = data.current_rate;
      const hbarUsd = rate.cent_equivalent / rate.hbar_equivalent / 100;

      this.cache.set(HBAR_TOKEN_KEY, {
        usdPrice: hbarUsd,
        fetchedAt: Date.now(),
      });

      return hbarUsd;
    } catch {
      return null;
    }
  }

  /** Fetch token/HBAR price from SaucerSwap (mainnet only). */
  async getTokenHbarPrice(tokenId: string): Promise<number | null> {
    if (process.env.HEDERA_NETWORK !== 'mainnet') return null;

    try {
      // SaucerSwap token endpoint
      const apiKey = process.env.SAUCERSWAP_API_KEY;
      const headers: Record<string, string> = {};
      if (apiKey) headers['x-api-key'] = apiKey;

      const res = await fetch(
        `https://api.saucerswap.finance/tokens/${tokenId}`,
        { headers }
      );
      if (!res.ok) return null;

      const data = (await res.json()) as { price?: number; priceUsd?: number };
      return data.price ?? null; // price is in HBAR
    } catch {
      return null;
    }
  }

  /** Convert an amount in a token to USD. Returns null if price unavailable. */
  async toUsd(amount: number, tokenKey: string): Promise<number | null> {
    if (tokenKey === HBAR_TOKEN_KEY) {
      const hbarPrice = await this.getHbarUsdPrice();
      return hbarPrice !== null ? amount * hbarPrice : null;
    }

    // For FTs: token→HBAR→USD
    const hbarPrice = await this.getHbarUsdPrice();
    if (hbarPrice === null) return null;

    const tokenHbarPrice = await this.getTokenHbarPrice(tokenKey);
    if (tokenHbarPrice === null) return null;

    const tokenUsd = tokenHbarPrice * hbarPrice;
    this.cache.set(tokenKey, { usdPrice: tokenUsd, fetchedAt: Date.now() });

    return amount * tokenUsd;
  }

  /** Refresh all cached prices. */
  async refresh(): Promise<void> {
    await this.getHbarUsdPrice();
    for (const tokenId of this.tokenRegistry.values()) {
      await this.toUsd(1, tokenId);
    }
  }

  // ── Sync cache read (used by BudgetManager.recordSpend) ───

  /** Read cached USD price for a token. Returns null if not cached or stale. */
  getCachedUsdPrice(tokenKey: string): number | null {
    const entry = this.cache.get(tokenKey);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > this.cacheTtlMs) return null;
    return entry.usdPrice;
  }

  // ── Registration ──────────────────────────────────────────

  /** Register a token symbol → ID mapping for price lookups. */
  registerToken(symbol: string, tokenId: string): void {
    this.tokenRegistry.set(symbol, tokenId);
  }
}
