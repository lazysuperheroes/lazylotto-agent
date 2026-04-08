#!/usr/bin/env tsx
/**
 * Forensic walk: per-user comparison of live store totalDeposited
 * vs on-chain HCS-20 mint sum. Used to track down the audit-page-vs
 * -admin-overview deposit discrepancy where the audit page showed
 * 1,168.5 HBAR (sum of all-time on-chain mints) and the admin
 * overview showed 930 HBAR (sum of current live user totalDeposited).
 *
 * For each live user, this script:
 *   1. Reads their userId, hederaAccountId, totalDeposited per
 *      token from the local Redis store
 *   2. Walks the HCS-20 topic and sums all `mint` ops where
 *      `to === user.hederaAccountId`
 *   3. Computes the gap and flags users where store < chain
 *      (the "missing credit" cases) or store > chain (impossible
 *      under normal flows, indicates corruption)
 *   4. Also enumerates on-chain account IDs that received mints
 *      but don't have a live user record (the "ghost user" cases —
 *      deleted/deregistered users or registrations against
 *      different userIds for the same Hedera account)
 *
 * Usage:
 *   npx tsx src/scripts/audit-deposit-discrepancy.ts
 *
 * Reads HCS20_TOPIC_ID, HEDERA_NETWORK, KV_REST_API_URL, etc.
 * from .env. The store-side reads use the same RedisStore the
 * agent uses, so this is safe to run against production (read
 * only).
 */

import 'dotenv/config';
import { parseAuditTopic, type RawTopicMessage } from '../custodial/hcs20-reader.js';

interface OnChainSnapshot {
  /** account → total HBAR-equivalent minted to that account */
  perAccount: Map<string, number>;
}

async function fetchTopicMessages(topicId: string, network: string): Promise<RawTopicMessage[]> {
  const mirrorBase =
    network === 'mainnet'
      ? 'https://mainnet.mirrornode.hedera.com/api/v1'
      : 'https://testnet.mirrornode.hedera.com/api/v1';

  const messages: RawTopicMessage[] = [];
  let nextPath: string | null = `/topics/${topicId}/messages?limit=100&order=asc`;
  while (nextPath) {
    const url = nextPath.startsWith('/api/v1')
      ? `${mirrorBase.replace(/\/api\/v1$/, '')}${nextPath}`
      : `${mirrorBase}${nextPath}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Mirror node ${res.status}`);
    const data = (await res.json()) as {
      messages?: { sequence_number: number; consensus_timestamp: string; message: string }[];
      links?: { next?: string };
    };
    for (const m of data.messages ?? []) {
      try {
        const payload = JSON.parse(Buffer.from(m.message, 'base64').toString('utf-8'));
        messages.push({
          sequence: m.sequence_number,
          timestamp: new Date(Number(m.consensus_timestamp.split('.')[0]) * 1000).toISOString(),
          payload,
        });
      } catch {
        /* skip */
      }
    }
    nextPath = data.links?.next ?? null;
  }
  return messages;
}

function buildOnChainSnapshot(messages: RawTopicMessage[]): OnChainSnapshot {
  const perAccount = new Map<string, number>();
  for (const m of messages) {
    if (m.payload.op !== 'mint') continue;
    const to = String(m.payload.to ?? '');
    const amt = Number(m.payload.amt);
    if (!to || !Number.isFinite(amt)) continue;
    perAccount.set(to, (perAccount.get(to) ?? 0) + amt);
  }
  return { perAccount };
}

async function main() {
  const topicId = process.env.HCS20_TOPIC_ID;
  if (!topicId) {
    console.error('HCS20_TOPIC_ID not set in env');
    process.exit(1);
  }
  const network = process.env.HEDERA_NETWORK ?? 'testnet';

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Deposit Discrepancy Forensic Walk');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Topic:   ${topicId}`);
  console.log(`  Network: ${network}`);
  console.log('');

  // Phase 1: pull on-chain mints from the topic
  console.log('[1/3] Walking HCS-20 topic for mint ops...');
  const messages = await fetchTopicMessages(topicId, network);
  const onChain = buildOnChainSnapshot(messages);
  let onChainTotal = 0;
  for (const v of onChain.perAccount.values()) onChainTotal += v;
  console.log(`      ${messages.length} messages, ${onChain.perAccount.size} unique mint recipients, ${onChainTotal.toFixed(4)} total HBAR-equiv minted`);

  // Phase 2: read live user records from the store. Fall back
  // gracefully if Redis credentials aren't in the env — the
  // on-chain side of the report is still valuable on its own.
  console.log('');
  console.log('[2/3] Reading live user store...');
  type LiveUser = { userId: string; hederaAccountId: string; balances: { tokens: Record<string, { totalDeposited: number }> } };
  let allUsers: LiveUser[] = [];
  let storeAvailable = false;
  let storeCleanup: (() => Promise<void>) | null = null;
  const hasRedisEnv =
    Boolean(process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL) &&
    Boolean(process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN);
  if (hasRedisEnv) {
    try {
      const { RedisStore } = await import('../custodial/RedisStore.js');
      const store = new RedisStore();
      await store.load();
      await store.refreshUserIndex();
      allUsers = store.getAllUsers() as LiveUser[];
      storeAvailable = true;
      storeCleanup = () => store.close();
      console.log(`      ${allUsers.length} live user record(s) (from Redis)`);
    } catch (err) {
      console.warn(`      ⚠ Redis store unavailable: ${err instanceof Error ? err.message : err}`);
      console.warn('      Continuing with on-chain-only mode.');
    }
  } else {
    console.log('      ⚠ KV_REST_API_URL / UPSTASH_REDIS_REST_URL not set in .env');
    console.log('      Continuing with on-chain-only mode (no per-user store comparison).');
  }

  // Group live users by hederaAccountId (empty map in on-chain-only mode)
  const liveByAccount = new Map<string, LiveUser[]>();
  for (const user of allUsers) {
    if (!liveByAccount.has(user.hederaAccountId)) {
      liveByAccount.set(user.hederaAccountId, []);
    }
    liveByAccount.get(user.hederaAccountId)!.push(user);
  }

  // Phase 3: compare per account
  console.log('');
  console.log('[3/3] Per-account comparison:');
  console.log('');

  let liveStoreTotalGross = 0;
  let liveStoreTotalNet = 0;
  const allAccounts = new Set<string>([
    ...onChain.perAccount.keys(),
    ...liveByAccount.keys(),
  ]);

  for (const account of Array.from(allAccounts).sort()) {
    const chainNet = onChain.perAccount.get(account) ?? 0;
    const liveUsers = liveByAccount.get(account) ?? [];

    if (liveUsers.length === 0) {
      // Ghost: on-chain mints but no live user record
      // (or store wasn't available — flag both cases)
      const tag = storeAvailable ? 'GHOST (no live user)' : 'on-chain only';
      console.log(`  ━━━ ${account} ━━━ ${tag}`);
      console.log(`    On-chain mints: ${chainNet.toFixed(4)} HBAR (net of rake)`);
      console.log('');
      continue;
    }

    let storeTotalDeposited = 0; // GROSS sum across all live records
    for (const user of liveUsers) {
      for (const entry of Object.values(user.balances.tokens)) {
        storeTotalDeposited += entry.totalDeposited;
      }
    }
    liveStoreTotalGross += storeTotalDeposited;
    liveStoreTotalNet += chainNet;

    console.log(`  ━━━ ${account} ━━━`);
    console.log(`    Live user records:        ${liveUsers.length} (${liveUsers.map((u) => u.userId.slice(0, 8)).join(', ')})`);
    console.log(`    Store totalDeposited (Σ): ${storeTotalDeposited.toFixed(4)} HBAR (gross, before rake)`);
    console.log(`    On-chain mints (Σ):       ${chainNet.toFixed(4)} HBAR (net, after rake)`);
    console.log(`    Implied rake (gross-net): ${(storeTotalDeposited - chainNet).toFixed(4)} HBAR`);
    if (storeTotalDeposited < chainNet) {
      // Store < chain net → store records less than what was net-deposited.
      // This is impossible under normal flow because store stores gross.
      // Indicates: deleted records, mid-incident snapshot, or bug.
      console.log(`    ⚠ ANOMALY: store gross < chain net. Missing ${(chainNet - storeTotalDeposited).toFixed(4)} HBAR of credits.`);
    }
    if (liveUsers.length > 1) {
      console.log(`    ⚠ NOTE: ${liveUsers.length} user records share this Hedera account. Was a duplicate registration intentional?`);
    }
    console.log('');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Totals');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  On-chain net mints:           ${onChainTotal.toFixed(4)} HBAR`);
  console.log(`  Live store gross deposited:   ${liveStoreTotalGross.toFixed(4)} HBAR`);
  console.log(`  (gross includes rake — net comparison only meaningful per-user above)`);
  console.log('');
  console.log('  Interpretation:');
  console.log('  - "GHOST" rows are accounts with on-chain deposits but no live user record.');
  console.log('    Likely cause: user was deregistered or the record was wiped.');
  console.log('  - "ANOMALY" warnings are accounts where the live store shows LESS gross');
  console.log('    deposit than the chain shows net. Should never happen under normal flow.');
  console.log('  - Multiple user records on the same Hedera account is allowed but worth');
  console.log('    confirming was intentional (e.g. test re-registrations).');

  if (storeCleanup) await storeCleanup();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
