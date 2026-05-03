/**
 * Signature verification for Hedera challenge-response authentication.
 *
 * Decodes the WalletConnect SignatureMap protobuf, extracts the signature
 * bytes, and verifies against the account's public key using the Hedera SDK.
 *
 * Ported from lazy-dapp-v3 src/server/api/routers/wallet.ts:181-303.
 */

import { PublicKey } from '@hashgraph/sdk';
import * as proto from '@hashgraph/proto';
import { getRedis, KEY_PREFIX } from './redis.js';
import { createSession, revokeAllForAccount } from './session.js';
import type { AuthChallenge, AuthTier } from './types.js';

/**
 * Resolve a Hedera account ID to its wallet-bound auth tier.
 *
 * Tier hierarchy is explicit (operator > admin > user > public). Each tier
 * maps to a comma-separated env list of Hedera account IDs:
 *   - OPERATOR_ACCOUNTS — fees, reconcile, health, kill switch, fee withdrawal
 *   - ADMIN_ACCOUNTS    — refunds, dead-letter queue, all-user views
 *
 * Operator is a strict superset (membership in OPERATOR_ACCOUNTS
 * short-circuits the admin check). Operators inherit every admin
 * capability via the `tierLevel` ordering in middleware.ts.
 *
 * No env-list match → 'user' tier (the authenticated wallet owner).
 *
 * Exported as a pure function so the tier-resolution invariant is
 * unit-testable without forging mirror-node signatures.
 */
export function resolveWalletTier(accountId: string): AuthTier {
  const parseList = (raw: string | undefined): string[] =>
    (raw ?? '').split(',').map((a) => a.trim()).filter(Boolean);

  const operatorAccounts = parseList(process.env.OPERATOR_ACCOUNTS);
  const adminAccounts    = parseList(process.env.ADMIN_ACCOUNTS);

  if (operatorAccounts.includes(accountId)) return 'operator';
  if (adminAccounts.includes(accountId))    return 'admin';
  return 'user';
}

/**
 * Verify a signed challenge and create a session.
 *
 * @param challengeId    - The challenge nonce/ID returned by createChallenge
 * @param accountId      - The Hedera account claiming to authenticate
 * @param signatureMapB64 - Base64-encoded Hedera SignatureMap protobuf from WalletConnect
 * @returns Session token and metadata on success
 * @throws On expired/invalid challenge, signature mismatch, or decode failure
 */
export async function verifyChallenge(
  challengeId: string,
  accountId: string,
  signatureMapB64: string,
): Promise<{
  sessionToken: string;
  accountId: string;
  tier: AuthTier;
  expiresAt: string;
}> {
  const redis = await getRedis();

  // 1. Atomically fetch and delete the challenge (single-use nonce)
  const raw = await redis.getdel<string>(`${KEY_PREFIX.challenge}${challengeId}`);
  if (!raw) {
    throw new Error('Challenge expired or already used');
  }

  const challenge: AuthChallenge = typeof raw === 'string' ? JSON.parse(raw) : raw;

  // 2. Verify the challenge was issued for this account
  if (challenge.accountId !== accountId) {
    throw new Error('Challenge was issued for a different account');
  }

  // 3. Decode the SignatureMap protobuf
  let signatureBytes: Uint8Array;
  try {
    const sigMapBytes = new Uint8Array(Buffer.from(signatureMapB64, 'base64'));
    const sigMap = proto.proto.SignatureMap.decode(sigMapBytes);

    if (!sigMap.sigPair || sigMap.sigPair.length === 0) {
      throw new Error('No signature pairs in SignatureMap');
    }

    const sigPair = sigMap.sigPair[0]!;
    const rawSig = sigPair.ed25519 ?? sigPair.ECDSASecp256k1;
    if (!rawSig) {
      throw new Error('No ED25519 or ECDSA signature found in SignaturePair');
    }
    signatureBytes = rawSig instanceof Uint8Array ? rawSig : new Uint8Array(rawSig);
  } catch (err) {
    if (err instanceof Error && err.message.includes('signature')) throw err;
    throw new Error(
      `Failed to decode SignatureMap: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 4. Verify the signature against the frozen public key
  const pubKey = challenge.keyType === 'ED25519'
    ? PublicKey.fromStringED25519(challenge.publicKeyHex)
    : PublicKey.fromStringECDSA(challenge.publicKeyHex);

  const messageBytes = new Uint8Array(Buffer.from(challenge.message, 'utf-8'));

  // Try direct verification first
  let isValid = pubKey.verify(messageBytes, signatureBytes);

  // Fallback: some wallets prefix with "\x19Hedera Signed Message:\n{length}"
  if (!isValid) {
    const prefix = `\x19Hedera Signed Message:\n${messageBytes.length}`;
    const prefixedBytes = new Uint8Array(Buffer.from(prefix + challenge.message, 'utf-8'));
    isValid = pubKey.verify(prefixedBytes, signatureBytes);
  }

  if (!isValid) {
    throw new Error('Signature verification failed');
  }

  // 5. Determine tier from wallet bindings (see resolveWalletTier).
  const tier: AuthTier = resolveWalletTier(accountId);

  // 6. Revoke any existing sessions for this account (auto-revoke on re-auth)
  await revokeAllForAccount(accountId);

  // 7. Create a new session
  const { token, expiresAt } = await createSession(accountId, tier);

  return {
    sessionToken: token,
    accountId,
    tier,
    expiresAt,
  };
}
