'use client';

/**
 * Browser-side x402 payment for the rake-holiday gate, signed with the user's
 * connected WalletConnect wallet.
 *
 * Flow: fetch the 402 quote → user picks USDC or HBAR → build a partially-signed
 * Hedera TransferTransaction (fee-payer = the facilitator, so the buyer pays the
 * transfer amount but NOT the network fee) → sign it via WalletConnect →
 * base64 it into the x402 `X-PAYMENT` header → POST → the server settles via the
 * facilitator and grants the holiday.
 *
 * The transfer is built with `@hiero-ledger/sdk` — the SAME SDK the wallet-connect
 * DAppSigner uses — so no Transaction object crosses SDK identities.
 */

import {
  TransferTransaction,
  TransactionId,
  AccountId,
  Hbar,
  TokenId,
  Client,
} from '@hiero-ledger/sdk';
import type { DAppConnector } from '@hashgraph/hedera-wallet-connect/dist/lib/dapp';

const X402_VERSION = 2;

export interface PaymentOption {
  scheme: string;
  network: string; // CAIP-2, e.g. 'hedera:testnet'
  asset: string; // '0.0.0' for HBAR, else HTS token id
  amount: string; // atomic units (tinybars / token base units)
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { feePayer: string; priceUsd?: string; display?: string };
}

export interface RakeHolidayQuote {
  x402Version: number;
  resource: { url: string; description?: string };
  accepts: PaymentOption[];
}

export interface RakeHolidayResult {
  ok: boolean;
  alreadyProcessed: boolean;
  rakeHoliday: { until: string; durationDays: number; paid: string; settlementTx: string };
  message: string;
}

/** Browser-safe base64 of a byte array (no Node Buffer). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/** Fetch the 402 quote (the payment options) without paying. */
export async function fetchRakeHolidayQuote(token: string): Promise<RakeHolidayQuote> {
  const res = await fetch('/api/premium/rake-holiday', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 503) {
    throw new Error('Rake-holiday purchase is not currently available.');
  }
  if (res.status !== 402) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Unexpected status ${res.status} from the gate.`);
  }
  return res.json();
}

/**
 * Build a partially-signed TransferTransaction for the chosen option and sign it
 * with the connected wallet. Returns the base64 transaction bytes.
 */
async function buildSignedTransfer(
  option: PaymentOption,
  connector: DAppConnector,
): Promise<string> {
  const signer = connector.signers[0];
  if (!signer) throw new Error('No wallet connected — connect a wallet first.');

  const buyer = AccountId.fromString(signer.getAccountId().toString());
  const payTo = AccountId.fromString(option.payTo);
  const feePayer = AccountId.fromString(option.extra.feePayer);
  const isMainnet = option.network === 'hedera:mainnet';
  const client = isMainnet ? Client.forMainnet() : Client.forTestnet();

  // Fee-payer = the facilitator (it co-signs the fee + submits). The buyer signs
  // their own outgoing leg.
  let tx = new TransferTransaction().setTransactionId(TransactionId.generate(feePayer));

  if (option.asset === '0.0.0') {
    tx = tx
      .addHbarTransfer(buyer, Hbar.fromTinybars(`-${option.amount}`))
      .addHbarTransfer(payTo, Hbar.fromTinybars(option.amount));
  } else {
    const token = TokenId.fromString(option.asset);
    const amount = Number(option.amount);
    tx = tx
      .addTokenTransfer(token, buyer, -amount)
      .addTokenTransfer(token, payTo, amount);
  }

  const frozen = await tx.freezeWith(client);
  const signed = await signer.signTransaction(frozen);
  return bytesToBase64(signed.toBytes());
}

/** Pay the chosen option via WalletConnect and grant the holiday. */
export async function payRakeHoliday(
  token: string,
  option: PaymentOption,
  connector: DAppConnector,
): Promise<RakeHolidayResult> {
  const transaction = await buildSignedTransfer(option, connector);
  const paymentPayload = {
    x402Version: X402_VERSION,
    accepted: option,
    payload: { transaction },
  };
  const xPayment = btoa(JSON.stringify(paymentPayload));

  const res = await fetch('/api/premium/rake-holiday', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-PAYMENT': xPayment },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? `Payment failed (status ${res.status}).`);
  }
  return body as RakeHolidayResult;
}

/** Circle's testnet USDC faucet (only relevant on testnet). */
export const USDC_TESTNET_FAUCET = 'https://faucet.circle.com';

/** True when an option is the testnet USDC option (so the UI can link the faucet). */
export function isTestnetUsdc(option: PaymentOption): boolean {
  return option.network === 'hedera:testnet' && option.asset !== '0.0.0';
}
