/**
 * Smoke test for the HTTP auth + MCP flow.
 *
 * Validates the full challenge-response authentication chain
 * against a running HTTP server instance. Uses the agent's own
 * private key (from .env) to sign the challenge — no WalletConnect needed.
 *
 * Usage:
 *   npx tsx src/cli/smoke-test.ts [base-url]
 *
 * Default base URL: http://localhost:3001
 */

import 'dotenv/config';
import { PrivateKey, PublicKey } from '@hashgraph/sdk';
import * as proto from '@hashgraph/proto';

const BASE_URL = process.argv[2] || 'http://localhost:3001';
const ACCOUNT_ID = process.env.HEDERA_ACCOUNT_ID;
const PRIVATE_KEY_STR = process.env.HEDERA_PRIVATE_KEY;

if (!ACCOUNT_ID || !PRIVATE_KEY_STR) {
  console.error('ERROR: HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY must be set in .env');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function ok(name: string) {
  passed++;
  console.log(`  ✓ ${name}`);
}

function fail(name: string, err: string) {
  failed++;
  console.error(`  ✗ ${name}: ${err}`);
}

async function post(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json() as Record<string, unknown>;
  return { status: res.status, data };
}

async function main() {
  console.log(`\nSmoke Test — ${BASE_URL}\n`);
  console.log(`Account: ${ACCOUNT_ID}`);
  console.log('');

  // 1. Health check
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (res.ok) ok('Health check');
    else fail('Health check', `Status ${res.status}`);
  } catch (e) {
    fail('Health check', `Server not reachable at ${BASE_URL}. Start with: npm run dev -- --mcp-server --http`);
    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    process.exit(1);
  }

  // 2. Request challenge
  let challengeId: string;
  let message: string;
  try {
    const { status, data } = await post('/auth/challenge', { accountId: ACCOUNT_ID });
    if (status !== 200) throw new Error(data.error as string || `Status ${status}`);
    challengeId = data.challengeId as string;
    message = data.message as string;
    if (challengeId && message) ok('Request challenge');
    else fail('Request challenge', 'Missing challengeId or message');
  } catch (e) {
    fail('Request challenge', e instanceof Error ? e.message : String(e));
    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    process.exit(1);
  }

  // 3. Sign challenge with agent's private key
  let signatureMapBase64: string;
  try {
    const privateKey = PrivateKey.fromStringDer(PRIVATE_KEY_STR!);
    const messageBytes = new Uint8Array(Buffer.from(message!, 'utf-8'));
    const signatureBytes = privateKey.sign(messageBytes);

    // Build a Hedera SignatureMap protobuf (matches WalletConnect format)
    const pubKeyBytes = privateKey.publicKey.toBytesRaw();
    const isEd25519 = PRIVATE_KEY_STR!.startsWith('302e') || privateKey.publicKey.toString().length < 80;

    const sigPair: Record<string, unknown> = {
      pubKeyPrefix: pubKeyBytes,
    };
    if (isEd25519) {
      sigPair.ed25519 = signatureBytes;
    } else {
      sigPair.ECDSASecp256k1 = signatureBytes;
    }

    const sigMap = proto.proto.SignatureMap.encode({
      sigPair: [sigPair as proto.proto.ISignaturePair],
    }).finish();

    signatureMapBase64 = Buffer.from(sigMap).toString('base64');
    ok('Sign challenge');
  } catch (e) {
    fail('Sign challenge', e instanceof Error ? e.message : String(e));
    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    process.exit(1);
  }

  // 4. Verify signature
  let sessionToken: string;
  try {
    const { status, data } = await post('/auth/verify', {
      challengeId: challengeId!,
      accountId: ACCOUNT_ID,
      signatureMapBase64: signatureMapBase64!,
    });
    if (status !== 200) throw new Error(data.error as string || `Status ${status}`);
    sessionToken = data.sessionToken as string;
    if (sessionToken && sessionToken.startsWith('sk_')) ok('Verify signature → session token');
    else fail('Verify signature', 'Invalid session token format');
  } catch (e) {
    fail('Verify signature', e instanceof Error ? e.message : String(e));
    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    process.exit(1);
  }

  // 5. Use session token to call health (basic connectivity proof)
  try {
    const res = await fetch(`${BASE_URL}/health`, {
      headers: { Authorization: `Bearer ${sessionToken!}` },
    });
    if (res.ok) ok('Authenticated health check');
    else fail('Authenticated health check', `Status ${res.status}`);
  } catch (e) {
    fail('Authenticated health check', e instanceof Error ? e.message : String(e));
  }

  // 6. Refresh session
  try {
    const { status, data } = await post('/auth/refresh', { sessionToken: sessionToken! });
    if (status !== 200) throw new Error(data.error as string || `Status ${status}`);
    const newToken = data.sessionToken as string;
    if (newToken && newToken.startsWith('sk_') && newToken !== sessionToken) {
      ok('Refresh session (new token issued)');
      sessionToken = newToken; // Use the new token going forward
    } else {
      fail('Refresh session', 'Token not rotated');
    }
  } catch (e) {
    fail('Refresh session', e instanceof Error ? e.message : String(e));
  }

  // 7. Lock API key
  try {
    const { status, data } = await post('/auth/lock', { sessionToken: sessionToken! });
    if (status === 200 && data.locked) ok('Lock API key');
    else fail('Lock API key', `Status ${status}`);
  } catch (e) {
    fail('Lock API key', e instanceof Error ? e.message : String(e));
  }

  // 8. Revoke session
  try {
    const { status, data } = await post('/auth/revoke', { sessionToken: sessionToken! });
    if (status === 200) ok('Revoke session');
    else fail('Revoke session', `Status ${status}`);
  } catch (e) {
    fail('Revoke session', e instanceof Error ? e.message : String(e));
  }

  // 9. Verify revoked token is rejected
  try {
    const { status } = await post('/auth/refresh', { sessionToken: sessionToken! });
    if (status === 401) ok('Revoked token rejected');
    else fail('Revoked token rejected', `Expected 401, got ${status}`);
  } catch (e) {
    fail('Revoked token rejected', e instanceof Error ? e.message : String(e));
  }

  // Summary
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
