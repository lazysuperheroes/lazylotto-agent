// x402 rake-holiday payment simulator — a reference client that pays the
// `/api/premium/rake-holiday` 402 gate and prints each step. Use it to test the
// gate manually if you don't have an x402-capable agent. Verified working
// against the Blocky402 testnet facilitator (2026-06-09). See
// docs/x402-payment-guide.md for the full walkthrough + the agent-prompt path.
//
// Run from repo root:
//   npx tsx uat-x402.ts <SESSION_TOKEN>
// - SESSION_TOKEN: pass as arg 1 (or set SESSION_TOKEN in .env). It's the user
//   who gets the holiday — grab it from localStorage 'lazylotto:sessionToken'.
// - Buyer: BUYER_ACCOUNT_ID / BUYER_PRIVATE_KEY in .env (required — errors if
//   unset). A funded testnet account, DIFFERENT from the gate's payTo (a
//   self-transfer is rejected).
// - BASE_URL optional (default http://localhost:3000).
import 'dotenv/config';
import { PrivateKey } from '@hiero-ledger/sdk';
import { createClientHederaSigner } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const ENDPOINT = `${BASE}/api/premium/rake-holiday`;
const TOKEN = process.argv[2] ?? process.env.SESSION_TOKEN;
const BUYER = process.env.BUYER_ACCOUNT_ID;
const KEY = process.env.BUYER_PRIVATE_KEY;

function parseKey(k: string): PrivateKey {
  try { return PrivateKey.fromStringDer(k); } catch { /* try next */ }
  try { return PrivateKey.fromStringECDSA(k); } catch { /* try next */ }
  try { return PrivateKey.fromStringED25519(k); } catch { /* try next */ }
  return PrivateKey.fromString(k);
}

async function main() {
  if (!TOKEN) {
    console.error('Pass the session token: npx tsx uat-x402.ts <sk_...>  (or set SESSION_TOKEN in .env)');
    process.exit(1);
  }
  if (!BUYER || !KEY) {
    console.error(
      'Missing buyer creds — set BUYER_ACCOUNT_ID and BUYER_PRIVATE_KEY in .env ' +
        '(a funded testnet account, DIFFERENT from payTo).',
    );
    process.exit(1);
  }
  console.log(`buyer=${BUYER}  endpoint=${ENDPOINT}`);
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  // 1) Unpaid request → expect 402 + PaymentRequired.
  const r1 = await fetch(ENDPOINT, { method: 'POST', headers });
  const challenge: any = await r1.json();
  console.log(`\n=== step1: ${r1.status} ===`);
  console.log(JSON.stringify(challenge, null, 2));
  if (r1.status !== 402) {
    console.log('Expected 402 — stopping.');
    return;
  }

  // 2) Choose the HBAR option (asset 0.0.0). To test USDC, change the find()
  //    to your USDC token id (buyer must hold + be associated with it).
  const accepts: any[] = challenge.accepts ?? [];
  const chosen = accepts.find((a) => a.asset === '0.0.0') ?? accepts[0];
  if (!chosen) {
    console.log('No payment options in the challenge — stopping.');
    return;
  }
  if (BUYER === chosen.payTo) {
    console.log(`\n⚠️  BUYER (${BUYER}) == payTo (${chosen.payTo}) — self-transfer will be rejected.`);
    console.log('Set BUYER_ACCOUNT_ID/BUYER_PRIVATE_KEY to a DIFFERENT funded account.');
    return;
  }
  console.log(
    `\nPaying ${chosen.extra?.display ?? chosen.amount} (${chosen.amount} of ${chosen.asset}) -> ${chosen.payTo}\n`,
  );

  // 3) Build + buyer-sign the payment. The facilitator co-signs the fee and
  //    submits — this builds/signs only, it does not broadcast.
  // The signer wants the CAIP-2 network id (e.g. 'hedera:testnet'), which the
  // challenge already specifies — use it so this works for mainnet too.
  const signer = createClientHederaSigner(BUYER, parseKey(KEY), { network: chosen.network });
  const result: any = await new ExactHederaScheme(signer).createPaymentPayload(
    challenge.x402Version ?? 2,
    chosen,
  );
  console.log('=== payloadResult ===');
  console.log(JSON.stringify(result, null, 2));

  // 4) Assemble the X-PAYMENT envelope and retry.
  const paymentPayload = {
    x402Version: result.x402Version ?? challenge.x402Version ?? 2,
    accepted: chosen,
    payload: result.payload,
    ...(result.extensions ? { extensions: result.extensions } : {}),
  };
  const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

  const r2 = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { ...headers, 'X-PAYMENT': xPayment },
  });
  console.log(`\n=== step2: ${r2.status} ===`);
  console.log(JSON.stringify(await r2.json(), null, 2));
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
