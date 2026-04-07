#!/usr/bin/env tsx
/**
 * One-shot diagnostic: pull the live HCS-20 topic via mirror node
 * and run it through the v2 reader. Confirms the parser handles the
 * existing v1 batch + recently-added prize_recovery messages, and
 * surfaces any new v2 sessions written after this point.
 */

import 'dotenv/config';
import { parseAuditTopic, type RawTopicMessage } from '../custodial/hcs20-reader.js';

async function main() {
  const topicId = process.env.HCS20_TOPIC_ID;
  if (!topicId) {
    console.error('HCS20_TOPIC_ID not set in env');
    process.exit(1);
  }
  console.log('Topic:', topicId);

  // Walk all messages with pagination
  const network = process.env.HEDERA_NETWORK ?? 'testnet';
  const mirrorBase = network === 'mainnet'
    ? 'https://mainnet.mirrornode.hedera.com'
    : 'https://testnet.mirrornode.hedera.com';

  const allMessages: RawTopicMessage[] = [];
  let nextPath: string | null = `/api/v1/topics/${topicId}/messages?limit=100&order=asc`;
  while (nextPath) {
    const url = nextPath.startsWith('/api/v1')
      ? `${mirrorBase}${nextPath}`
      : `${mirrorBase}${nextPath}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error('Mirror node error:', res.status);
      process.exit(1);
    }
    const data = (await res.json()) as {
      messages?: { sequence_number: number; consensus_timestamp: string; message: string }[];
      links?: { next?: string };
    };
    for (const m of data.messages ?? []) {
      try {
        const payload = JSON.parse(Buffer.from(m.message, 'base64').toString('utf-8'));
        allMessages.push({
          sequence: m.sequence_number,
          timestamp: new Date(Number(m.consensus_timestamp.split('.')[0]) * 1000).toISOString(),
          payload,
        });
      } catch {
        // skip undecodable
      }
    }
    nextPath = data.links?.next ?? null;
  }

  console.log('Fetched', allMessages.length, 'messages from topic');

  const result = await parseAuditTopic(allMessages);

  console.log('\n━━━ Reader stats ━━━');
  console.log(JSON.stringify(result.stats, null, 2));

  console.log('\n━━━ Reconstructed sessions ━━━');
  for (const s of result.sessions) {
    console.log(`\n• ${s.sessionId.slice(0, 16)}... [${s.status}]`);
    console.log(`  user:           ${s.user || '(unknown)'}`);
    console.log(`  pools:          ${s.pools.length}`);
    console.log(`  totalSpent:     ${s.totalSpent}`);
    console.log(`  totalWins:      ${s.totalWins}`);
    console.log(`  totalPrizeValue:${s.totalPrizeValue}`);
    console.log(`  totalNftCount:  ${s.totalNftCount}`);
    if (s.warnings.length) {
      console.log(`  warnings:`);
      for (const w of s.warnings) console.log(`    - ${w}`);
    }
    if (s.prizeTransfer) {
      console.log(`  prizeTransfer:  ${s.prizeTransfer.status}${s.prizeTransfer.txId ? ' (' + s.prizeTransfer.txId.slice(0, 30) + '...)' : ''}`);
    }
  }

  console.log('\n━━━ Non-session events ━━━');
  const nonSession = result.events.filter((e) => e.type !== 'session');
  for (const e of nonSession) {
    let desc = '';
    if (e.type === 'deposit') desc = `${e.amount} ${e.token} → ${e.user}`;
    else if (e.type === 'rake') desc = `${e.amount} ${e.token} ${e.user}→${e.agent}`;
    else if (e.type === 'withdrawal') desc = `${e.amount} ${e.token} from ${e.user}`;
    else if (e.type === 'operator_withdrawal') desc = `${e.amount} ${e.token} from ${e.agent}`;
    else if (e.type === 'refund') desc = `${e.amount} ${e.token} ${e.agent}→${e.user} (orig: ${e.originalDepositTxId.slice(0, 20)}...)`;
    else if (e.type === 'prize_recovery') desc = `${e.prizesTransferred} prizes ${e.agent}→${e.user}, attempts=${e.attempts ?? '?'}`;
    else if (e.type === 'deploy') desc = `tick=${e.tick}`;
    else if (e.type === 'control') desc = `event=${e.event}, by=${e.by}`;
    else desc = JSON.stringify(e).slice(0, 100);
    console.log(`  #${e.sequence} [${e.type}] ${desc}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
