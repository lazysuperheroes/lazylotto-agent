/**
 * HIP-15 Hedera address checksum.
 *
 * Computes a 5-letter checksum for Hedera addresses (e.g., "0.0.1234" → "0.0.1234-vfmkw")
 * to help users verify they are sending to the correct address on the correct network.
 *
 * Spec: https://hips.hedera.com/hip/hip-15
 */

/** Ledger ID bytes for each network. */
const LEDGER_IDS: Record<string, number[]> = {
  mainnet: [0x00],
  testnet: [0x01],
  previewnet: [0x02],
};

/**
 * Compute the HIP-15 checksum for a Hedera address.
 *
 * @param address - The address without checksum (e.g., "0.0.1234")
 * @param network - "mainnet", "testnet", or "previewnet"
 * @returns 5-letter checksum string (e.g., "vfmkw")
 */
export function computeChecksum(address: string, network: string): string {
  const ledgerId = LEDGER_IDS[network] ?? LEDGER_IDS.testnet;

  const p3 = 26 * 26 * 26;          // 26^3 = 17576
  const p5 = 26 * 26 * 26 * 26 * 26; // 26^5 = 11881376
  const m = 1_000_003;
  const w = 31;

  // Convert address characters to digit array ('.' → 10, '0'-'9' → 0-9)
  const d: number[] = [];
  for (const ch of address) {
    d.push(ch === '.' ? 10 : ch.charCodeAt(0) - 0x30);
  }

  let sd0 = 0;
  let sd1 = 0;
  let sd = 0;
  let sh = 0;

  for (let i = 0; i < d.length; i++) {
    sd = (w * sd + d[i]) % p3;
    if (i % 2 === 0) {
      sd0 = (sd0 + d[i]) % 11;
    } else {
      sd1 = (sd1 + d[i]) % 11;
    }
  }

  // Weighted sum of ledger ID bytes padded with 6 zeros
  for (const b of ledgerId) {
    sh = (w * sh + (b & 0xff)) % p5;
  }
  for (let i = 0; i < 6; i++) {
    sh = (w * sh) % p5;
  }

  const c = ((((address.length % 5) * 11 + sd0) * 11 + sd1) * p3 + sd + sh) % p5;
  let cp = (c * m) % p5;

  let checksum = '';
  for (let i = 0; i < 5; i++) {
    checksum = String.fromCharCode(0x61 + (cp % 26)) + checksum;
    cp = Math.floor(cp / 26);
  }

  return checksum;
}

/**
 * Format a Hedera address with its HIP-15 checksum.
 *
 * @param address - The address (e.g., "0.0.1234")
 * @param network - "mainnet", "testnet", or "previewnet" (defaults to HEDERA_NETWORK env)
 * @returns Address with checksum (e.g., "0.0.1234-vfmkw")
 */
export function withChecksum(address: string, network?: string): string {
  const net = network ?? process.env.HEDERA_NETWORK ?? 'testnet';
  return `${address}-${computeChecksum(address, net)}`;
}
