/**
 * HashScan URL builders — network-aware deep links to the Hedera block explorer.
 *
 * Canonical rules (mirrors lazy-dapp-v3/src/utils/hashscan.ts):
 *   - Every hederaId is clickable (tokens, contracts, accounts)
 *   - Every NFT serial links to the specific-serial page, not the collection homepage
 *   - Every transaction ID is clickable
 *   - Transaction IDs must be in mirror-node format: 0.0.1234-1735123456-789000000
 *     (hyphens), not the SDK format 0.0.1234@1735123456.789000000 (at-sign + dot)
 */

export type HashScanNetwork = 'mainnet' | 'testnet' | 'previewnet';

function getBaseUrl(network: HashScanNetwork): string {
  return network === 'mainnet'
    ? 'https://hashscan.io/mainnet'
    : `https://hashscan.io/${network}`;
}

/**
 * Convert an SDK transaction ID (0.0.X@seconds.nanos) to mirror-node format
 * (0.0.X-seconds-nanos). HashScan only accepts the mirror form.
 */
export function toMirrorTxId(txId: string): string {
  return txId.replace('@', '-').replace(/\.(\d+)$/, '-$1');
}

/** Link to a token, contract, or account entity. */
export function getHashScanEntityUrl(
  entityId: string,
  type: 'contract' | 'token' | 'account',
  network: HashScanNetwork,
): string {
  return `${getBaseUrl(network)}/${type}/${entityId}`;
}

/** Link to a specific NFT serial's page (shows metadata + ownership history). */
export function getHashScanNftSerialUrl(
  tokenId: string,
  serial: number | string,
  network: HashScanNetwork,
): string {
  return `${getBaseUrl(network)}/token/${tokenId}/${serial}`;
}

/**
 * Link to a transaction. Accepts both SDK and mirror formats — auto-converts
 * SDK format (with @) to mirror format (with -).
 */
export function getHashScanTransactionUrl(txId: string, network: HashScanNetwork): string {
  const mirrorFormat = txId.includes('@') ? toMirrorTxId(txId) : txId;
  return `${getBaseUrl(network)}/transaction/${mirrorFormat}`;
}

/** Resolve the current HashScan network from HEDERA_NETWORK env var. */
export function getCurrentHashScanNetwork(): HashScanNetwork {
  const network = (process.env.HEDERA_NETWORK ?? 'testnet').toLowerCase();
  if (network === 'mainnet' || network === 'testnet' || network === 'previewnet') {
    return network;
  }
  return 'testnet';
}
