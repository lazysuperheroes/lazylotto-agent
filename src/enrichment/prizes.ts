/**
 * Prize enrichment pipeline for display.
 *
 * Combines the three sources documented in
 * lazy-dapp-v3/docs/features/MCP_NFT_PRIZE_ENRICHMENT.md:
 *   1. Directus TokenStaticData (primary) — image + nftName
 *   2. Mirror Node (fallback) — basic symbol/name when Directus is missing
 *   3. Directus Verification overlay — niceName + verificationLevel badge
 *
 * Plus HashScan deep links so every prize row is clickable through to the
 * block explorer.
 *
 * Input: a list of PrizeNft refs captured at the moment of the win.
 * Output: a list of fully-enriched prize NFTs ready for the dashboard.
 */

import type { PrizeNft } from '../agent/ReportGenerator.js';
import { enrichNfts, type EnrichedNft } from './directus.js';
import {
  getVerificationInfoBatch,
  shouldShowNiceName,
  type VerificationLevel,
} from './verification.js';
import {
  getHashScanEntityUrl,
  getHashScanNftSerialUrl,
  getCurrentHashScanNetwork,
} from '../utils/hashscan.js';

export interface EnrichedPrizeNft {
  /** Canonical identity. */
  hederaId: string;
  serial: number;

  // ── Display ────────────────────────────────────────────────
  /** NFT's own display name (e.g. "Lazy Hero #42"). */
  nftName: string;
  /** Raw collection symbol from mirror node (e.g. "LSH"). */
  collection: string;
  /** Human-friendly collection name (e.g. "Lazy Superheroes"). Only meaningful for verified tiers. */
  niceName: string;
  /** Whether niceName should be shown (verified tiers only). */
  showNiceName: boolean;
  /** Trust tier for badge styling. */
  verificationLevel: VerificationLevel;
  /** Normalized image URL (may be empty for mirror fallback — consumer should show a placeholder). */
  image: string;
  /** Where the display data came from, for debugging. */
  source: EnrichedNft['source'];

  // ── Deep links ─────────────────────────────────────────────
  /** HashScan link to the parent token collection. */
  tokenUrl: string;
  /** HashScan link to this specific NFT serial's page. */
  serialUrl: string;
}

/**
 * Enrich a flat list of PrizeNft refs with display metadata and HashScan links.
 * Efficient batch resolution across Directus, mirror node, and verification table.
 */
export async function enrichPrizes(
  prizeNfts: PrizeNft[],
): Promise<EnrichedPrizeNft[]> {
  if (prizeNfts.length === 0) return [];

  const network = getCurrentHashScanNetwork();

  // Dedupe refs for the lookup calls — same NFT may appear in multiple
  // play sessions but we only need to resolve it once.
  const uniqueRefs = Array.from(
    new Map(
      prizeNfts.map((p) => [`${p.hederaId}!${p.serial}`, { hederaId: p.hederaId, serial: p.serial }]),
    ).values(),
  );
  const uniqueTokenIds = Array.from(new Set(prizeNfts.map((p) => p.hederaId)));

  // Resolve both pipelines in parallel
  const [enriched, verificationMap] = await Promise.all([
    enrichNfts(uniqueRefs),
    getVerificationInfoBatch(uniqueTokenIds),
  ]);

  // Index by cache key for O(1) merge
  const enrichedByKey = new Map<string, EnrichedNft>();
  for (const n of enriched) {
    enrichedByKey.set(`${n.hederaId}!${n.serial}`, n);
  }

  return prizeNfts.map((prize): EnrichedPrizeNft => {
    const key = `${prize.hederaId}!${prize.serial}`;
    const nft = enrichedByKey.get(key);
    const verification = verificationMap.get(prize.hederaId) ?? {
      niceName: prize.hederaId,
      verificationLevel: 'unverified' as const,
    };

    return {
      hederaId: prize.hederaId,
      serial: prize.serial,
      nftName: nft?.nftName ?? `${prize.token} #${prize.serial}`,
      collection: nft?.collection ?? prize.token,
      niceName: verification.niceName,
      showNiceName: shouldShowNiceName(verification.verificationLevel),
      verificationLevel: verification.verificationLevel,
      image: nft?.image ?? '',
      source: nft?.source ?? 'fallback',
      tokenUrl: getHashScanEntityUrl(prize.hederaId, 'token', network),
      serialUrl: getHashScanNftSerialUrl(prize.hederaId, prize.serial, network),
    };
  });
}
