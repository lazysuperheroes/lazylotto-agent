/**
 * Challenge generation for Hedera signature authentication.
 *
 * Creates a time-limited challenge that the user signs with their
 * Hedera wallet. The account's public key is fetched from the mirror
 * node and frozen into the challenge to prevent TOCTOU attacks.
 */

import { randomUUID } from 'node:crypto';
import { getRedis, KEY_PREFIX } from './redis.js';
import type { AuthChallenge, HederaKeyType } from './types.js';
import { getAccountKey } from '../hedera/mirror.js';

const CHALLENGE_TTL_SECONDS = 300; // 5 minutes

/**
 * Build the human-readable challenge message the user sees in their wallet.
 * This must be deterministically reproducible from the challenge fields.
 */
export function buildChallengeMessage(
  accountId: string,
  nonce: string,
  network: string,
): string {
  const networkLabel = network.charAt(0).toUpperCase() + network.slice(1);
  return [
    `LazyLotto Agent Authentication [${networkLabel}]`,
    '',
    'Sign to verify wallet ownership.',
    '',
    `Account: ${accountId}`,
    `Network: ${network}`,
    `Nonce: ${nonce}`,
  ].join('\n');
}

/**
 * Create a new challenge for a Hedera account.
 *
 * 1. Fetches the account's public key from mirror node (frozen at challenge time)
 * 2. Generates a random nonce
 * 3. Stores the challenge in Redis with a 5-minute TTL
 *
 * @throws If the account doesn't exist or has a complex key (threshold/keyList)
 */
export async function createChallenge(accountId: string): Promise<{
  challengeId: string;
  message: string;
  expiresAt: string;
}> {
  // Fetch and validate the account's public key
  const keyInfo = await getAccountKey(accountId);

  if (keyInfo._type !== 'ED25519' && keyInfo._type !== 'ECDSA_SECP256K1') {
    throw new Error(
      `Account ${accountId} has a complex key type (${keyInfo._type}). ` +
        'Only ED25519 and ECDSA_SECP256K1 keys are supported for signature authentication.'
    );
  }

  const nonce = randomUUID();
  const network = process.env.HEDERA_NETWORK ?? 'testnet';
  const message = buildChallengeMessage(accountId, nonce, network);
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString();

  const challenge: AuthChallenge = {
    id: nonce, // Use nonce as the challenge ID
    nonce,
    accountId,
    publicKeyHex: keyInfo.key,
    keyType: keyInfo._type as HederaKeyType,
    message,
    expiresAt,
  };

  const redis = await getRedis();
  await redis.set(
    `${KEY_PREFIX.challenge}${nonce}`,
    JSON.stringify(challenge),
    { ex: CHALLENGE_TTL_SECONDS },
  );

  return { challengeId: nonce, message, expiresAt };
}
