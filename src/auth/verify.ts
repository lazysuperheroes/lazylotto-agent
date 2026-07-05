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
import { resolveWalletTier } from './tiers.js';
import type { AuthChallenge, AuthTier } from './types.js';

// F7 (2026-07-05): resolveWalletTier moved to ./tiers.ts (SDK-free) so the
// hot-path auth middleware can re-resolve tiers without importing this
// module's Hedera SDK deps. Re-exported for back-compat with existing importers.
export { resolveWalletTier };

/**
 * R9-FG-5 / Phase-7 Cluster C: typed sentinel for signature-validation
 * failures the caller wants to rethrow as-is (vs. wrap as a generic
 * SignatureMap decode failure). Pre-fix the catch at line 107 used
 * `err.message.includes('signature')` against literal strings
 * constructed lines 86, 96, 103 — the same R8-FG-25 archetype the
 * Phase-6 closure retired in refund.ts and MultiUserAgent.ts. A
 * future copy-edit on any of those messages silently flipped the
 * catch's branch. Discriminate via `instanceof` instead.
 */
export class SignatureValidationError extends Error {
  readonly __signatureValidation = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'SignatureValidationError';
  }
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
    // R10-FG-14 / Phase-9 Cluster E: typed sentinel completes the
    // R9-FG-5 migration. Pre-Phase-9 the most security-critical
    // throws in this file (challenge expiry, account mismatch,
    // signature failure) were plain Error and required substring
    // matching downstream — the exact archetype R9-FG-5 was
    // supposed to retire.
    throw new SignatureValidationError('Challenge expired or already used');
  }

  const challenge: AuthChallenge = typeof raw === 'string' ? JSON.parse(raw) : raw;

  // 2. Verify the challenge was issued for this account
  if (challenge.accountId !== accountId) {
    // R10-FG-14 / Phase-9 Cluster E: typed sentinel.
    throw new SignatureValidationError('Challenge was issued for a different account');
  }

  // 3. Decode the SignatureMap protobuf
  let signatureBytes: Uint8Array;
  try {
    const sigMapBytes = new Uint8Array(Buffer.from(signatureMapB64, 'base64'));
    const sigMap = proto.proto.SignatureMap.decode(sigMapBytes);

    if (!sigMap.sigPair || sigMap.sigPair.length === 0) {
      throw new SignatureValidationError('No signature pairs in SignatureMap');
    }
    // R4-FG-72 (round-4 low): require exactly one signature pair.
    // Pre-fix we silently took `sigPair[0]` and ignored any extras,
    // which would let a wallet that bundles multiple signatures
    // (e.g., one valid + one decoy) authenticate against the first
    // entry while the protocol contract is "the user signed once".
    // Hardening for the auth boundary.
    if (sigMap.sigPair.length !== 1) {
      throw new SignatureValidationError(
        `SignatureMap must contain exactly one signature pair (got ${sigMap.sigPair.length})`,
      );
    }

    const sigPair = sigMap.sigPair[0]!;
    const rawSig = sigPair.ed25519 ?? sigPair.ECDSASecp256k1;
    if (!rawSig) {
      throw new SignatureValidationError('No ED25519 or ECDSA signature found in SignaturePair');
    }
    signatureBytes = rawSig instanceof Uint8Array ? rawSig : new Uint8Array(rawSig);
  } catch (err) {
    // R9-FG-5 / Phase-7 Cluster C: discriminate via typed sentinel
    // instead of `err.message.includes('signature')` substring match.
    // The pre-fix substring check was vulnerable to copy-edits on the
    // upstream message strings — the SAME archetype the Phase-6 R8-FG-25
    // closure retired in refund.ts and MultiUserAgent.ts.
    if (err instanceof SignatureValidationError) throw err;
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
    // R10-FG-14 / Phase-9 Cluster E: typed sentinel. This is THE
    // most security-critical throw in the auth path; bucketing it
    // into plain Error required downstream substring matching
    // (the R9-FG-5 archetype) and made it indistinguishable from
    // benign decode errors at log-aggregation time.
    throw new SignatureValidationError('Signature verification failed');
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
