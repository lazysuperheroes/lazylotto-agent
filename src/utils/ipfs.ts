/**
 * Normalize NFT image URLs to a pinned IPFS gateway.
 *
 * Mirrors lazy-dapp-v3/src/services/core/mirrorNode/getImageAndMetadataFromNode.ts
 * so that agent-served images use the same gateway as the dApp. Keeps asset
 * caches warm across both surfaces.
 */

const IPFS_MAPPING: Record<string, string> = {
  'ipfs://': 'https://lazysuperheroes.myfilebase.com/ipfs/',
  'IPFS://': 'https://lazysuperheroes.myfilebase.com/ipfs/',
  'https://ipfs.infura.io/ipfs/': 'https://lazysuperheroes.myfilebase.com/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/': 'https://lazysuperheroes.myfilebase.com/ipfs/',
};

/**
 * Transform an NFT image URL to use our pinned gateway where possible.
 *
 * Handles:
 *   - Raw IPFS URIs (ipfs://Qm...)
 *   - Legacy Infura / Cloudflare IPFS gateways
 *   - HCS hashinals (hcs://<topicId>) via tier.bot CDN
 *   - Arweave (ar://... or arweave.net/...)
 *   - Everything else: returned unchanged
 */
export function transformImageUrl(imageUrl: string): string {
  if (!imageUrl) return imageUrl;

  // HCS hashinals (Hedera Consensus Service topic-backed assets)
  if (imageUrl.startsWith('hcs://')) {
    const topicId = imageUrl.split('/').pop();
    const network = (process.env.HEDERA_NETWORK ?? 'mainnet').toLowerCase();
    return `https://tier.bot/api/hashinals-cdn/${topicId}?network=${network}`;
  }

  // Arweave
  if (/^ar:\/\/|^https:\/\/arweave\.net\//i.test(imageUrl)) {
    const clean = imageUrl.replace(/^ar:\/\//, '').replace(/^https:\/\/arweave\.net\//, '');
    return `https://arweave.net/${clean}`;
  }

  // IPFS gateway normalization
  for (const [from, to] of Object.entries(IPFS_MAPPING)) {
    if (imageUrl.startsWith(from)) return imageUrl.replace(from, to);
  }

  return imageUrl;
}
