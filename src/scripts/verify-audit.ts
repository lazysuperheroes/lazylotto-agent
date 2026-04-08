#!/usr/bin/env tsx
/**
 * Standalone audit verifier — reconstructs the LazyLotto Agent's
 * full per-user ledger from the HCS-20 audit topic alone, with no
 * dependency on the agent's local Redis store.
 *
 * This is the artifact a regulator, tax accountant, or skeptical
 * end user can run to independently verify the operator's books.
 * It speaks ONLY to the public Hedera mirror node — no auth, no
 * agent endpoint, no inside knowledge required.
 *
 * Usage:
 *
 *   # Walk the topic and print every reconstructed user ledger
 *   npx tsx src/scripts/verify-audit.ts --topic 0.0.8499866
 *
 *   # Filter to a single user
 *   npx tsx src/scripts/verify-audit.ts --topic 0.0.8499866 --user 0.0.7349994
 *
 *   # Use mainnet mirror node
 *   npx tsx src/scripts/verify-audit.ts --topic 0.0.X --network mainnet
 *
 *   # Output JSON instead of human-readable
 *   npx tsx src/scripts/verify-audit.ts --topic 0.0.8499866 --json
 *
 *   # Custom mirror node URL (for self-hosted or alternative providers)
 *   npx tsx src/scripts/verify-audit.ts --topic 0.0.8499866 \
 *     --mirror https://my-mirror.example.com/api/v1
 *
 * The reconstruction uses the same parseAuditTopic from the agent's
 * reader (src/custodial/hcs20-reader.ts), so it's guaranteed to
 * produce the same result as the dashboard. The difference is this
 * script reaches the reader directly via tsx instead of via a
 * Next.js API endpoint — it depends on no Redis, no Hedera SDK
 * client, and no LazyLotto contract.
 *
 * Output: per-user ledger with deposit/rake/spend/withdrawal/refund
 * totals, balance derivation, and any warnings (orphaned sessions,
 * corrupt sessions, agentSeq gaps).
 */

import { parseAuditTopic, type RawTopicMessage } from '../custodial/hcs20-reader.js';

interface CliArgs {
  topic: string;
  network: 'testnet' | 'mainnet';
  user: string | null;
  json: boolean;
  mirror: string | null;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let topic = '';
  let network: 'testnet' | 'mainnet' = 'testnet';
  let user: string | null = null;
  let json = false;
  let mirror: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--topic' && args[i + 1]) {
      topic = args[++i]!;
    } else if (a === '--network' && args[i + 1]) {
      network = args[++i] as 'testnet' | 'mainnet';
    } else if (a === '--user' && args[i + 1]) {
      user = args[++i]!;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--mirror' && args[i + 1]) {
      mirror = args[++i]!;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (!topic) {
    console.error('Error: --topic is required');
    printHelp();
    process.exit(1);
  }

  if (network !== 'testnet' && network !== 'mainnet') {
    console.error(`Error: --network must be 'testnet' or 'mainnet', got '${network}'`);
    process.exit(1);
  }

  return { topic, network, user, json, mirror };
}

function printHelp(): void {
  console.log(`
LazyLotto Agent — Standalone Audit Verifier

Reconstructs per-user ledger state from HCS-20 audit messages on
Hedera Consensus Service. No agent dependency — uses only the
public mirror node.

Usage:
  npx tsx src/scripts/verify-audit.ts --topic <topic-id> [options]

Required:
  --topic <id>           HCS-20 topic ID (e.g. 0.0.8499866)

Options:
  --network <name>       'testnet' (default) or 'mainnet'
  --user <accountId>     Filter to one user (e.g. 0.0.7349994)
  --json                 Output JSON instead of human-readable
  --mirror <url>         Custom mirror node URL
                         (default: https://{network}.mirrornode.hedera.com/api/v1)
  -h, --help             Show this help

Examples:
  # Verify a specific user's testnet ledger
  npx tsx src/scripts/verify-audit.ts \\
    --topic 0.0.8499866 --user 0.0.7349994

  # Dump all users on mainnet as JSON
  npx tsx src/scripts/verify-audit.ts \\
    --topic 0.0.X --network mainnet --json

This is a read-only verifier. It will never modify the topic, the
agent's Redis store, or any user's Hedera state.
`);
}

interface PerUserLedger {
  userAccountId: string;
  totalDeposited: number;
  totalDepositedByToken: Record<string, number>;
  totalRake: number;
  totalRakeByToken: Record<string, number>;
  totalSpent: number;
  totalSpentByToken: Record<string, number>;
  totalWithdrawn: number;
  totalWithdrawnByToken: Record<string, number>;
  totalRefunded: number;
  totalRefundedByToken: Record<string, number>;
  totalPrizeValue: number;
  totalPrizeValueByToken: Record<string, number>;
  totalNftPrizes: number;
  /** Derived: deposited - rake - spent - withdrawn - refunded. */
  ledgerBalance: number;
  ledgerBalanceByToken: Record<string, number>;
  sessionCount: number;
  sessionStatusCounts: Record<string, number>;
  warnings: string[];
}

function emptyLedger(userAccountId: string): PerUserLedger {
  return {
    userAccountId,
    totalDeposited: 0,
    totalDepositedByToken: {},
    totalRake: 0,
    totalRakeByToken: {},
    totalSpent: 0,
    totalSpentByToken: {},
    totalWithdrawn: 0,
    totalWithdrawnByToken: {},
    totalRefunded: 0,
    totalRefundedByToken: {},
    totalPrizeValue: 0,
    totalPrizeValueByToken: {},
    totalNftPrizes: 0,
    ledgerBalance: 0,
    ledgerBalanceByToken: {},
    sessionCount: 0,
    sessionStatusCounts: {},
    warnings: [],
  };
}

function addToToken(map: Record<string, number>, token: string, amt: number): void {
  map[token] = (map[token] ?? 0) + amt;
}

async function main() {
  const args = parseArgs();

  const mirrorBase =
    args.mirror ??
    (args.network === 'mainnet'
      ? 'https://mainnet.mirrornode.hedera.com/api/v1'
      : 'https://testnet.mirrornode.hedera.com/api/v1');

  if (!args.json) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  LazyLotto Audit Verifier');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Topic:   ${args.topic}`);
    console.log(`  Network: ${args.network}`);
    console.log(`  Mirror:  ${mirrorBase}`);
    if (args.user) console.log(`  Filter:  ${args.user}`);
    console.log('');
  }

  // Walk the topic with pagination
  const allMessages: RawTopicMessage[] = [];
  let nextPath: string | null = `/topics/${args.topic}/messages?limit=100&order=asc`;
  let pageCount = 0;
  while (nextPath) {
    const url = nextPath.startsWith('/api/v1')
      ? `${mirrorBase.replace(/\/api\/v1$/, '')}${nextPath}`
      : `${mirrorBase}${nextPath}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Mirror node error: ${res.status} ${res.statusText}`);
      console.error(`URL: ${url}`);
      process.exit(2);
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
    pageCount++;
  }

  if (!args.json) {
    console.log(`[1/3] Pulled ${allMessages.length} messages from ${pageCount} page(s)`);
  }

  // Run the reader
  const result = await parseAuditTopic(allMessages);

  if (!args.json) {
    console.log(`[2/3] Reader stats:`);
    console.log(`        v1 messages: ${result.stats.v1Messages}`);
    console.log(`        v2 messages: ${result.stats.v2Messages}`);
    console.log(`        unknown:     ${result.stats.unknownMessages}`);
    console.log(`        skipped:     ${result.stats.skippedMessages}`);
    console.log(`        sessions:    ${result.sessions.length} (${Object.entries(result.stats.sessionsByStatus).map(([k, v]) => `${k}=${v}`).join(', ')})`);
    if (result.stats.agentSeqGaps.length > 0) {
      console.log(`        ⚠ agentSeq gaps:`);
      for (const gap of result.stats.agentSeqGaps) {
        console.log(`          ${gap.agent} after seq ${gap.afterSeq}`);
      }
    }
    console.log('');
  }

  // Build per-user ledgers
  const ledgers = new Map<string, PerUserLedger>();
  function getOrCreateLedger(accountId: string): PerUserLedger {
    if (!ledgers.has(accountId)) {
      ledgers.set(accountId, emptyLedger(accountId));
    }
    return ledgers.get(accountId)!;
  }

  for (const event of result.events) {
    if (event.type === 'deposit') {
      const led = getOrCreateLedger(event.user);
      led.totalDeposited += event.amount;
      addToToken(led.totalDepositedByToken, normalizeLegacyToken(event.token), event.amount);
    } else if (event.type === 'rake') {
      const led = getOrCreateLedger(event.user);
      led.totalRake += event.amount;
      addToToken(led.totalRakeByToken, normalizeLegacyToken(event.token), event.amount);
    } else if (event.type === 'withdrawal') {
      const led = getOrCreateLedger(event.user);
      led.totalWithdrawn += event.amount;
      addToToken(led.totalWithdrawnByToken, normalizeLegacyToken(event.token), event.amount);
    } else if (event.type === 'refund') {
      const led = getOrCreateLedger(event.user);
      led.totalRefunded += event.amount;
      addToToken(led.totalRefundedByToken, normalizeLegacyToken(event.token), event.amount);
    } else if (event.type === 'session') {
      const session = event.session;
      if (!session.user) continue;
      const led = getOrCreateLedger(session.user);
      led.sessionCount++;
      led.sessionStatusCounts[session.status] =
        (led.sessionStatusCounts[session.status] ?? 0) + 1;
      led.totalSpent += session.totalSpent;
      for (const [token, amt] of Object.entries(session.totalSpentByToken)) {
        addToToken(led.totalSpentByToken, token, amt);
      }
      led.totalPrizeValue += session.totalPrizeValue;
      for (const [token, amt] of Object.entries(session.totalPrizeValueByToken)) {
        addToToken(led.totalPrizeValueByToken, token, amt);
      }
      led.totalNftPrizes += session.totalNftCount;
      if (session.warnings.length > 0) {
        led.warnings.push(`session ${session.sessionId.slice(0, 8)}: ${session.warnings.join('; ')}`);
      }
    }
    // deploy/control/operator_withdrawal/prize_recovery/unknown not credited per-user
  }

  // Derive ledger balance per user (deposited - rake - spent - withdrawn - refunded)
  for (const led of ledgers.values()) {
    led.ledgerBalance =
      led.totalDeposited - led.totalRake - led.totalSpent - led.totalWithdrawn - led.totalRefunded;

    // Per-token balance
    const allTokens = new Set<string>([
      ...Object.keys(led.totalDepositedByToken),
      ...Object.keys(led.totalRakeByToken),
      ...Object.keys(led.totalSpentByToken),
      ...Object.keys(led.totalWithdrawnByToken),
      ...Object.keys(led.totalRefundedByToken),
    ]);
    for (const token of allTokens) {
      const dep = led.totalDepositedByToken[token] ?? 0;
      const rk = led.totalRakeByToken[token] ?? 0;
      const sp = led.totalSpentByToken[token] ?? 0;
      const wd = led.totalWithdrawnByToken[token] ?? 0;
      const rf = led.totalRefundedByToken[token] ?? 0;
      const balance = dep - rk - sp - wd - rf;
      // Round to 4 decimals
      led.ledgerBalanceByToken[token] = Math.round(balance * 10000) / 10000;
    }
  }

  // Filter
  const filteredLedgers = args.user
    ? Array.from(ledgers.values()).filter((l) => l.userAccountId === args.user)
    : Array.from(ledgers.values()).sort((a, b) => a.userAccountId.localeCompare(b.userAccountId));

  if (filteredLedgers.length === 0) {
    if (args.user) {
      console.error(`No on-chain activity found for user ${args.user}`);
    } else {
      console.error('No user activity found on this topic');
    }
    process.exit(3);
  }

  // Output
  if (args.json) {
    console.log(JSON.stringify({
      topic: args.topic,
      network: args.network,
      mirror: mirrorBase,
      stats: result.stats,
      ledgers: filteredLedgers,
    }, null, 2));
  } else {
    console.log(`[3/3] Reconstructed ${filteredLedgers.length} user ledger(s):\n`);
    for (const led of filteredLedgers) {
      console.log(`  ━━━ ${led.userAccountId} ━━━`);
      console.log(`    Deposited:      ${formatTokenMap(led.totalDepositedByToken)}`);
      console.log(`    Rake:           ${formatTokenMap(led.totalRakeByToken)}`);
      console.log(`    Spent on plays: ${formatTokenMap(led.totalSpentByToken)}`);
      console.log(`    Withdrawn:      ${formatTokenMap(led.totalWithdrawnByToken)}`);
      if (led.totalRefunded > 0) {
        console.log(`    Refunded:       ${formatTokenMap(led.totalRefundedByToken)}`);
      }
      console.log(`    ──────────────────────────────`);
      console.log(`    Balance left:   ${formatTokenMap(led.ledgerBalanceByToken)}`);
      console.log('');
      console.log(`    Plays: ${led.sessionCount} session(s)`);
      if (Object.keys(led.sessionStatusCounts).length > 0) {
        for (const [status, count] of Object.entries(led.sessionStatusCounts)) {
          console.log(`      ${status}: ${count}`);
        }
      }
      console.log(`    Wins (informational): ${formatTokenMap(led.totalPrizeValueByToken) || '(none)'}${led.totalNftPrizes > 0 ? ` + ${led.totalNftPrizes} NFT(s)` : ''}`);
      if (led.warnings.length > 0) {
        console.log(`    ⚠ Warnings:`);
        for (const w of led.warnings) {
          console.log(`      - ${w}`);
        }
      }
      console.log('');
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Note: "Wins" are informational. Prizes flow to');
    console.log('  the user EOA via the LazyLotto contract and do');
    console.log('  not offset the Balance left figure above. Verify');
    console.log('  prizes by checking the user\'s wallet on HashScan.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }
}

function formatTokenMap(map: Record<string, number>): string {
  const entries = Object.entries(map).filter(([, v]) => v !== 0);
  if (entries.length === 0) return '0';
  return entries.map(([token, amt]) => `${amt} ${token}`).join(', ');
}

/**
 * Defensive normalizer for any token string that survives the
 * reader's own resolveTokenField() pass.
 *
 * Since the AccountingService writer now stamps an explicit `token`
 * field on every v1 mint/transfer/burn (and the reader prefers it
 * over `tick: LLCRED`), the only way "LLCRED" reaches this script
 * is via a pre-fix legacy message on an existing topic — and even
 * those go through the reader's LLCRED→HBAR fallback first. This
 * helper is kept as a belt-and-braces guard rather than a load-
 * bearing fix; it's a no-op against any modern reader output.
 *
 * See docs/hcs20-v2-schema.md and AccountingService.normalizeTokenField
 * for the writer side of the contract.
 */
function normalizeLegacyToken(token: string): string {
  if (token === 'LLCRED' || token === 'llcred') return 'HBAR';
  return token;
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
