/**
 * Directus NFT metadata enrichment.
 *
 * Mirrors the dApp's pipeline documented in
 * lazy-dapp-v3/docs/features/MCP_NFT_PRIZE_ENRICHMENT.md and implemented in
 * lazy-dapp-v3/src/services/external/directus/staticMetadata.ts
 *
 * Two sources, in order of preference:
 *   1. Directus TokenStaticData collection — fast, curated, includes image
 *   2. Hedera Mirror Node fallback — for community NFTs not in Directus
 *
 * Caching:
 *   - NFT metadata is immutable → cached indefinitely (keyed ${hederaId}!${serial})
 *   - Per warm Lambda instance (cold start hydrates from source)
 */

import { transformImageUrl } from '../utils/ipfs.js';

// ── Types ────────────────────────────────────────────────────────

export interface EnrichedNft {
  /** Canonical lookup key. */
  hederaId: string;
  serial: number;
  /** Display name (e.g. "Lazy Superhero #42"). Falls back to "SYMBOL #serial". */
  nftName: string;
  /** Collection symbol/short name. */
  collection: string;
  /** Normalized image URL (IPFS → pinned gateway). */
  image: string;
  /** Where the data came from, for debugging. */
  source: 'directus' | 'mirror' | 'fallback';
}

// ── Directus REST API ───────────────────────────────────────────

const DIRECTUS_URL = 'https://directus-production-62f4.up.railway.app';
const TOKEN_STATIC_DATA = 'TokenStaticData';

// Module-level cache (per warm Lambda).
// Immutable data → no TTL, just accumulate.
const metadataCache = new Map<string, EnrichedNft>();

function cacheKey(hederaId: string, serial: number): string {
  return `${hederaId}!${serial}`;
}

interface DirectusNftRow {
  uid?: string;
  address?: string;
  serial?: string | number;
  nftName?: string;
  collection?: string;
  image?: string;
}

/**
 * Fetch NFT metadata from Directus TokenStaticData for a single token + serials.
 * Returns an array of EnrichedNft for whichever serials were found.
 */
async function fetchFromDirectus(
  hederaId: string,
  serials: number[],
): Promise<EnrichedNft[]> {
  if (serials.length === 0) return [];

  // Directus REST filter + field selection
  const filter = encodeURIComponent(
    JSON.stringify({
      address: { _eq: hederaId },
      serial: { _in: serials.map(String) },
    }),
  );
  const fields = 'uid,address,serial,nftName,collection,image';
  const url = `${DIRECTUS_URL}/items/${TOKEN_STATIC_DATA}?filter=${filter}&fields=${fields}&limit=${serials.length}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    console.warn(`[directus] ${res.status} fetching ${hederaId}:${serials.join(',')}`);
    return [];
  }

  const body = (await res.json()) as { data?: DirectusNftRow[] };
  const rows = body.data ?? [];

  return rows
    .filter((r): r is DirectusNftRow & { address: string; serial: string | number } =>
      Boolean(r.address && r.serial !== undefined),
    )
    .map((r) => ({
      hederaId: r.address,
      serial: Number(r.serial),
      nftName: r.nftName ?? `${r.collection ?? 'NFT'} #${r.serial}`,
      collection: r.collection ?? r.address,
      image: transformImageUrl(r.image ?? ''),
      source: 'directus' as const,
    }));
}

// ── Mirror node fallback ────────────────────────────────────────

function getMirrorBase(): string {
  const network = (process.env.HEDERA_NETWORK ?? 'testnet').toLowerCase();
  return network === 'mainnet'
    ? 'https://mainnet-public.mirrornode.hedera.com'
    : 'https://testnet.mirrornode.hedera.com';
}

/**
 * Fetch basic NFT info from the mirror node as a fallback.
 * Provides token symbol/name but NOT image — following the dApp's
 * pattern of using a placeholder rather than hitting IPFS in the hot path.
 */
async function fetchFromMirror(
  hederaId: string,
  serials: number[],
): Promise<EnrichedNft[]> {
  if (serials.length === 0) return [];

  const mirrorBase = getMirrorBase();

  // Fetch token-level info once (symbol + name)
  let tokenSymbol = hederaId;
  try {
    const res = await fetch(`${mirrorBase}/api/v1/tokens/${hederaId}`);
    if (res.ok) {
      const body = (await res.json()) as { symbol?: string; name?: string };
      tokenSymbol = body.symbol ?? body.name ?? hederaId;
    }
  } catch (e) {
    console.warn(`[mirror] token lookup failed for ${hederaId}:`, e);
  }

  // For each serial, verify it exists on the mirror node but skip IPFS fetch
  const results: EnrichedNft[] = [];
  for (const serial of serials) {
    try {
      const res = await fetch(`${mirrorBase}/api/v1/tokens/${hederaId}/nfts/${serial}`);
      if (!res.ok) continue;
      await res.json(); // existence check only
      results.push({
        hederaId,
        serial,
        nftName: `${tokenSymbol} #${serial}`,
        collection: tokenSymbol,
        image: '', // No image — consumer should show a placeholder
        source: 'mirror',
      });
    } catch (e) {
      console.warn(`[mirror] nft lookup failed for ${hederaId}/${serial}:`, e);
    }
  }

  return results;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Enrich a list of { hederaId, serial } pairs with display metadata.
 * Tries Directus first, falls back to mirror node for missing serials.
 * Caches results indefinitely (NFT metadata is immutable).
 */
export async function enrichNfts(
  refs: Array<{ hederaId: string; serial: number }>,
): Promise<EnrichedNft[]> {
  if (refs.length === 0) return [];

  // 1. Partition into cached vs missing
  const cached: EnrichedNft[] = [];
  const missingByToken = new Map<string, number[]>();

  for (const ref of refs) {
    const hit = metadataCache.get(cacheKey(ref.hederaId, ref.serial));
    if (hit) {
      cached.push(hit);
    } else {
      const list = missingByToken.get(ref.hederaId) ?? [];
      list.push(ref.serial);
      missingByToken.set(ref.hederaId, list);
    }
  }

  if (missingByToken.size === 0) return cached;

  // 2. Fetch missing from Directus in parallel per token
  const directusResults = await Promise.all(
    Array.from(missingByToken.entries()).map(([hederaId, serials]) =>
      fetchFromDirectus(hederaId, serials).catch((e) => {
        console.warn(`[enrichment] Directus failed for ${hederaId}:`, e);
        return [] as EnrichedNft[];
      }),
    ),
  );

  const directusFlat = directusResults.flat();
  for (const nft of directusFlat) {
    metadataCache.set(cacheKey(nft.hederaId, nft.serial), nft);
  }

  // 3. Identify serials still missing → mirror node fallback
  const stillMissing = new Map<string, number[]>();
  for (const [hederaId, serials] of missingByToken) {
    const foundSerials = new Set(
      directusFlat.filter((n) => n.hederaId === hederaId).map((n) => n.serial),
    );
    const missing = serials.filter((s) => !foundSerials.has(s));
    if (missing.length > 0) stillMissing.set(hederaId, missing);
  }

  const mirrorResults = await Promise.all(
    Array.from(stillMissing.entries()).map(([hederaId, serials]) =>
      fetchFromMirror(hederaId, serials).catch((e) => {
        console.warn(`[enrichment] Mirror failed for ${hederaId}:`, e);
        return [] as EnrichedNft[];
      }),
    ),
  );

  const mirrorFlat = mirrorResults.flat();
  for (const nft of mirrorFlat) {
    metadataCache.set(cacheKey(nft.hederaId, nft.serial), nft);
  }

  // 4. Final fallback: anything still not found → minimal placeholder
  const allFound = new Set(
    [...cached, ...directusFlat, ...mirrorFlat].map((n) =>
      cacheKey(n.hederaId, n.serial),
    ),
  );
  const fallbacks: EnrichedNft[] = [];
  for (const ref of refs) {
    if (!allFound.has(cacheKey(ref.hederaId, ref.serial))) {
      fallbacks.push({
        hederaId: ref.hederaId,
        serial: ref.serial,
        nftName: `NFT #${ref.serial}`,
        collection: ref.hederaId,
        image: '',
        source: 'fallback',
      });
    }
  }

  return [...cached, ...directusFlat, ...mirrorFlat, ...fallbacks];
}

/** Test helper — clears the module cache. */
export function clearEnrichmentCache(): void {
  metadataCache.clear();
}
