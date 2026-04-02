/**
 * Diagnostic script: reads HCS-20 accounting messages from a Hedera topic.
 *
 * Usage:
 *   npx tsx src/cli/read-accounting.ts [topicId] [--raw] [--limit N]
 *
 * If topicId is omitted, reads HCS20_TOPIC_ID from .env.
 *
 * Fetches all messages from the mirror node, decodes them, and prints
 * a formatted audit trail with running balances per account.
 */

import 'dotenv/config';
import { HEDERA_DEFAULTS } from '../config/defaults.js';

// ── CLI args ────────────────────────────────────────────────

const args = process.argv.slice(2);
const rawMode = args.includes('--raw');
const limitIdx = args.indexOf('--limit');
const maxMessages = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
const topicId = args.find((a) => /^0\.0\.\d+$/.test(a))
  ?? process.env.HCS20_TOPIC_ID;

if (!topicId) {
  console.error('Usage: npx tsx src/cli/read-accounting.ts [topicId] [--raw] [--limit N]');
  console.error('  Or set HCS20_TOPIC_ID in .env');
  process.exit(1);
}

// ── Mirror node ─────────────────────────────────────────────

type Network = 'testnet' | 'mainnet';
const network = (process.env.HEDERA_NETWORK ?? 'testnet') as Network;
const baseUrl = HEDERA_DEFAULTS.mirrorNodeUrl[network] ?? HEDERA_DEFAULTS.mirrorNodeUrl.testnet;

interface TopicMessage {
  sequence_number: number;
  consensus_timestamp: string;
  message: string; // base64-encoded
  payer_account_id: string;
}

interface TopicMessagesResponse {
  messages: TopicMessage[];
  links?: { next?: string };
}

async function fetchAllMessages(): Promise<TopicMessage[]> {
  const all: TopicMessage[] = [];
  let next: string | null = `/topics/${topicId}/messages?limit=100&order=asc`;

  while (next && all.length < maxMessages) {
    const url = next.startsWith('/api/v1')
      ? `${baseUrl.replace(/\/api\/v1$/, '')}${next}`
      : `${baseUrl}${next}`;

    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 404) {
        console.error(`Topic ${topicId} not found on ${network}.`);
        process.exit(1);
      }
      throw new Error(`Mirror node ${res.status}: ${url}`);
    }

    const data = (await res.json()) as TopicMessagesResponse;
    all.push(...(data.messages ?? []));
    next = data.links?.next ?? null;
  }

  return all.slice(0, maxMessages === Infinity ? undefined : maxMessages);
}

// ── Decode + display ────────────────────────────────────────

interface ParsedMessage {
  seq: number;
  timestamp: string;
  payer: string;
  payload: Record<string, unknown>;
}

function decode(msg: TopicMessage): ParsedMessage {
  const json = Buffer.from(msg.message, 'base64').toString('utf-8');
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(json);
  } catch {
    payload = { _raw: json };
  }
  return {
    seq: msg.sequence_number,
    timestamp: msg.consensus_timestamp,
    payer: msg.payer_account_id,
    payload,
  };
}

function formatOp(p: Record<string, unknown>): string {
  const op = p.op as string;
  switch (op) {
    case 'deploy':
      return `DEPLOY  ${p.name} (tick: ${p.tick}, max: ${p.max})`;
    case 'mint':
      return `MINT    ${p.amt} ${p.tick} → ${p.to}${p.memo ? ` [${p.memo}]` : ''}`;
    case 'burn':
      return `BURN    ${p.amt} ${p.tick} from ${p.from}${p.memo ? ` [${p.memo}]` : ''}`;
    case 'transfer':
      return `XFER    ${p.amt} ${p.tick} ${p.from} → ${p.to}${p.memo ? ` [${p.memo}]` : ''}`;
    case 'batch': {
      const ops = (p.operations as Record<string, unknown>[]) ?? [];
      const lines = ops.map((o) => `  ${formatOp(o)}`);
      return `BATCH   session=${p.sessionId} (${ops.length} ops)\n${lines.join('\n')}`;
    }
    default:
      return `${op?.toUpperCase() ?? '?'}  ${JSON.stringify(p)}`;
  }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log(`\nReading HCS-20 accounting from topic ${topicId} on ${network}...\n`);

  const messages = await fetchAllMessages();

  if (messages.length === 0) {
    console.log('No messages found on this topic.');
    return;
  }

  // Track running balances
  const balances: Record<string, number> = {};
  const addBalance = (acct: string, amt: number) => {
    balances[acct] = (balances[acct] ?? 0) + amt;
  };

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  HCS-20 Audit Trail — ${messages.length} message(s)`);
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const msg of messages) {
    const decoded = decode(msg);
    const ts = new Date(Number(decoded.timestamp.split('.')[0]) * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    if (rawMode) {
      console.log(`#${decoded.seq} [${ts}] payer=${decoded.payer}`);
      console.log(JSON.stringify(decoded.payload, null, 2));
      console.log();
    } else {
      console.log(`#${decoded.seq} [${ts}]  ${formatOp(decoded.payload)}`);
    }

    // Update running balances
    const p = decoded.payload;
    const amt = Number(p.amt) || 0;
    if (p.op === 'mint' && p.to) addBalance(p.to as string, amt);
    if (p.op === 'burn' && p.from) addBalance(p.from as string, -amt);
    if (p.op === 'transfer') {
      if (p.from) addBalance(p.from as string, -amt);
      if (p.to) addBalance(p.to as string, amt);
    }
    if (p.op === 'batch') {
      for (const bop of (p.operations as Record<string, unknown>[]) ?? []) {
        const bamt = Number(bop.amt) || 0;
        if (bop.op === 'mint' && bop.to) addBalance(bop.to as string, bamt);
        if (bop.op === 'burn' && bop.from) addBalance(bop.from as string, -bamt);
        if (bop.op === 'transfer') {
          if (bop.from) addBalance(bop.from as string, -bamt);
          if (bop.to) addBalance(bop.to as string, bamt);
        }
      }
    }
  }

  // Print running balance summary
  const accounts = Object.entries(balances).filter(([, v]) => v !== 0);
  if (accounts.length > 0) {
    console.log('\n───────────────────────────────────────────────────────────');
    console.log('  Running Balances (from HCS-20 operations)');
    console.log('───────────────────────────────────────────────────────────');
    for (const [acct, bal] of accounts.sort((a, b) => b[1] - a[1])) {
      console.log(`  ${acct}: ${bal >= 0 ? '+' : ''}${bal}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════\n');
}

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
