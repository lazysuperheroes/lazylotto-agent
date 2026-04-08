// ---------------------------------------------------------------------------
// WalletConnect / Hedera DAppConnector helpers
// ---------------------------------------------------------------------------
//
// Pure-data constants and small helpers extracted from AuthFlow during the
// L2 split. The DAppConnector instance itself stays in the AuthFlow because
// its lifecycle is tied to the component (init on mount, disconnectAll on
// unmount), but the constants and the network helpers are reused by future
// view components without dragging the whole DAppConnector type with them.

import { HederaChainId } from '@hashgraph/hedera-wallet-connect/dist/lib/shared';

export type Network = 'testnet' | 'mainnet';

// WalletConnect project IDs — different for testnet vs mainnet so the
// session metadata in the wallet shows the right network. Both are public
// project IDs (the project ID alone doesn't grant any permissions).
export const PROJECT_IDS: Record<Network, string> = {
  testnet: 'bd6270834787a8e7615806237172c87c',
  mainnet: '6c3697705aa0c2e8a49d81ed6f734219',
};

export const CHAIN_IDS: Record<Network, string> = {
  testnet: HederaChainId.Testnet,
  mainnet: HederaChainId.Mainnet,
};

/**
 * Resolve the active network from the URL `?network=mainnet` query
 * parameter. Defaults to 'testnet' on the server (where window is
 * undefined) and when no parameter is set. The dashboard and AuthFlow
 * both call this so the page never silently runs against the wrong
 * network.
 */
export function getNetworkFromUrl(): Network {
  if (typeof window === 'undefined') return 'testnet';
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('network')?.toLowerCase();
  if (raw === 'mainnet') return 'mainnet';
  return 'testnet';
}

export function networkLabel(n: Network): string {
  return n === 'mainnet' ? 'Mainnet' : 'Testnet';
}

/**
 * Pick a random element from a non-empty array. Used by AuthFlow to
 * vary the character tagline / success line on each render. Falls
 * back to the empty string when given an empty array so callers
 * don't have to check.
 */
export function pickRandom(arr: string[]): string {
  if (arr.length === 0) return '';
  return arr[Math.floor(Math.random() * arr.length)] ?? '';
}
