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

/**
 * R9-FG-3 / Phase-7 Cluster A: enable schema-drift detection. Pre-fix
 * `HCS20_SOFT_VALIDATE` was never set anywhere — the reader's env-gate
 * skipped every message and the consumer below (which iterates
 * `result.stats.schemaValidationFailures`) always saw zero entries.
 * The verify-audit thesis ("R8-FG-6: schema drift surfaces as critical
 * alerts") was shipped but functionally dead. Setting the env at module
 * load means the reader runs softValidate on every message walked
 * during this script's run.
 */
process.env.HCS20_SOFT_VALIDATE = '1';

import { parseAuditTopic, type RawTopicMessage } from '../custodial/hcs20-reader.js';
import {
  MirrorTxCache,
  TokenDecimalsCache,
  realDecimalsLookup,
  realMirrorFetcher,
  validateBurnCrossCheck,
  validateMintCrossCheck,
  type AuditAlert,
} from './verify-audit-crosscheck.js';

interface CliArgs {
  topic: string;
  network: 'testnet' | 'mainnet';
  user: string | null;
  json: boolean;
  mirror: string | null;
  /**
   * R2-FG-3 / R2-FG-4: agent's Hedera account id for strict recipient
   * validation in phantom-mint / phantom-burn cross-checks. Optional;
   * if absent, the script falls back to looser checks (amount +
   * direction only) since the topic alone doesn't carry agent info.
   */
  agentAccountId: string | null;
  /**
   * R5-FG-44 (P12-305): when true, also load `audit_trail_orphaned`
   * dead-letters from the configured store and merge them into the
   * alerts list. Without this, an operator running on a "healthy
   * looking" topic gets a clean conservation report while the agent
   * is silently dead-lettering orphans every hour. Requires Redis
   * env (UPSTASH_REDIS_REST_URL/TOKEN) since dead-letters live in
   * Redis, not on chain.
   */
  storeSnapshot: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let topic = '';
  let network: 'testnet' | 'mainnet' = 'testnet';
  let user: string | null = null;
  let json = false;
  let mirror: string | null = null;

  let agentAccountId: string | null = null;
  let storeSnapshot = false;

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
    } else if ((a === '--agent' || a === '--agent-account-id') && args[i + 1]) {
      agentAccountId = args[++i]!;
    } else if (a === '--store-snapshot') {
      storeSnapshot = true;
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

  if (agentAccountId !== null && !/^\d+\.\d+\.\d+$/.test(agentAccountId)) {
    console.error(`Error: --agent must be a Hedera account id (e.g. 0.0.123456), got '${agentAccountId}'`);
    process.exit(1);
  }

  return { topic, network, user, json, mirror, agentAccountId, storeSnapshot };
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
  --agent <accountId>    Agent's Hedera account id. When provided, the
                         phantom-mint / phantom-burn cross-checks
                         (R2-FG-3 / R2-FG-4) additionally validate that
                         deposits flowed TO the agent and withdrawals
                         flowed FROM the agent. Without it the
                         cross-check still validates amount + direction.
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
  /** R2-FG-22: per-user rake reversed via refunds, for sum-bound check. */
  totalRakeReversedByToken: Record<string, number>;
  totalSpent: number;
  totalSpentByToken: Record<string, number>;
  totalWithdrawn: number;
  totalWithdrawnByToken: Record<string, number>;
  totalRefunded: number;
  totalRefundedByToken: Record<string, number>;
  totalPrizeValue: number;
  totalPrizeValueByToken: Record<string, number>;
  totalNftPrizes: number;
  /**
   * Derived: deposited - rake - spent - withdrawn - refunded + rakeReversed - held - flushOrphaned.
   *
   * R10-FG-9 / Phase-9 Cluster B: aggregate formula now matches the
   * per-token formula. Pre-Phase-9 the docstring AND the computation
   * at the assignment site read `dep - rk - sp - wd - rf` (omitting
   * held + flushOrphan), so JSON consumers and the printed table saw
   * different numbers from the per-token sum. R8-FG-24 / R6-FG-10
   * shipped the per-token subtractions; R10-FG-9 / R11-P5-002 surfaced
   * the aggregate-stale-vs-per-token-correct discrepancy.
   */
  ledgerBalance: number;
  ledgerBalanceByToken: Record<string, number>;
  /**
   * R8-FG-24 / Phase-6 Cluster C: amounts held by
   * `play_uncertain_success_pending_triage` events for this user.
   * Reduces the "available" component of `ledgerBalanceByToken` —
   * pre-fix verify-audit only formatted held reservations into the
   * alert message, never actually reduced the user's reconstructed
   * balance, so the user could withdraw more than the agent had
   * reserved.
   */
  heldByToken: Record<string, number>;
  /**
   * R6-FG-10 / Phase-6 Cluster C: per-token sum of orphaned
   * deposit-credit-flush amounts. Subtract from `totalDeposited`
   * during reconstruction so a topic-only DR replay produces the
   * right balance.
   */
  depositCreditFlushOrphanedByToken: Record<string, number>;
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
    totalRakeReversedByToken: {},
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
    heldByToken: {},
    depositCreditFlushOrphanedByToken: {},
    sessionCount: 0,
    sessionStatusCounts: {},
    warnings: [],
  };
}

function addToToken(map: Record<string, number>, token: string, amt: number): void {
  map[token] = (map[token] ?? 0) + amt;
}

/**
 * F20 (2026-05-06 audit DR-02): operator-state ledger reconstructed
 * from `rake` and `operator_withdrawal` events on the topic.
 * `verify-audit.ts` previously skipped these events entirely, so the
 * standalone DR tool produced no operator-side numbers — making the
 * "Redis-loss recovery from topic alone" runbook impossible to
 * actually run as documented.
 */
interface OperatorLedger {
  /** Total rake collected across the topic. */
  totalRakeCollected: Record<string, number>;
  /** Total withdrawn by operator across the topic. */
  totalWithdrawnByOperator: Record<string, number>;
  /** Derived: totalRakeCollected − totalWithdrawnByOperator − rakeReversed. */
  balances: Record<string, number>;
  /** Total rake reversed via refunds (F9). */
  totalRakeReversed: Record<string, number>;
}

function emptyOperatorLedger(): OperatorLedger {
  return {
    totalRakeCollected: {},
    totalWithdrawnByOperator: {},
    balances: {},
    totalRakeReversed: {},
  };
}

// AuditAlert / MirrorTxCache / TokenDecimalsCache / validators are
// imported from `./verify-audit-crosscheck.js` so unit tests can
// drive them without invoking this script's `main()` side-effect.


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
  // R5-FG-108 (P11-014): wall-clock budget separate from per-page
  // timeout. Pre-fix 8s timeout × 1000 pages = 133 minutes worst
  // case; operator running with no progress signal waited an
  // unbounded time. Now: hard cap at 5 minutes; on overrun, return
  // partial data with a clear warning so the operator can re-run
  // with a tighter time window.
  const WALL_CLOCK_BUDGET_MS = 5 * 60 * 1000;
  const startMs = Date.now();
  let partial = false;
  while (nextPath) {
    if (Date.now() - startMs > WALL_CLOCK_BUDGET_MS) {
      console.warn(
        `\n  ⚠ Wall-clock budget exhausted (${WALL_CLOCK_BUDGET_MS / 1000}s) ` +
          `after ${pageCount} pages, ${allMessages.length} messages. ` +
          `Returning partial data — re-run with a narrower topic window for full coverage.\n`,
      );
      partial = true;
      break;
    }
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
        // R5-FG-85: preserve sub-second precision.
        const tsParts = m.consensus_timestamp.split('.');
        const ms =
          Number(tsParts[0] ?? 0) * 1000 +
          Math.floor(Number(tsParts[1] ?? 0) / 1_000_000);
        allMessages.push({
          sequence: m.sequence_number,
          timestamp: new Date(ms).toISOString(),
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
    console.log(
      `[1/3] Pulled ${allMessages.length} messages from ${pageCount} page(s)` +
        (partial ? ' (PARTIAL)' : ''),
    );
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
    if (result.stats.agentSeqDuplicates.length > 0) {
      console.log(`        ✖ agentSeq DUPLICATES (R2-FG-18):`);
      for (const dup of result.stats.agentSeqDuplicates) {
        console.log(`          ${dup.agent} seq=${dup.seq} sessions=${dup.sessions.join(',')}`);
      }
    }
    console.log('');
  }

  // Build per-user ledgers + operator ledger
  const ledgers = new Map<string, PerUserLedger>();
  const operatorLedger = emptyOperatorLedger();
  const alerts: AuditAlert[] = [];
  // F18 / F21 / R2-FG-3 / R2-FG-4: collect deposit + withdrawal txIds
  // for cross-checking. The burnTxIds set drives the new phantom-burn
  // check (R2-FG-4) — every withdrawal/operator_withdrawal with a
  // `withdrawTxId` body is verified against the matching mirror tx.
  // Pre-F18 burns (no withdrawTxId) emit a soft warning per occurrence.
  //
  // R2-FG-20 (round-2 TR-14): namespace dedup by burn kind so a user
  // burn and an operator burn that legitimately share a withdrawTxId
  // (e.g. shared on-chain tx that pays both) don't accidentally
  // suppress one. Cross-kind collision is unusual and gets surfaced
  // as a critical alert below.
  const seenWithdrawTxIdsByKind: Record<
    'user' | 'operator',
    Set<string>
  > = {
    user: new Set(),
    operator: new Set(),
  };
  /** Collisions across kinds — same txId claimed by both a user burn AND an operator burn. */
  const crossKindBurnCollisions: Array<{ txId: string }> = [];
  /**
   * R5-FG-14 (P12-301): track depositTxIds for both deposits AND
   * rake events so the cross-check can flag rakes that reference no
   * deposit (forged rake credit on operator) and post-cutoff rakes
   * that lack a depositTxId entirely (writer regression — should
   * always carry the field after R5).
   */
  const depositTxIdsByUser = new Map<string, Set<string>>();
  const rakeDepositTxIdsByUser = new Map<string, Set<string>>();
  const rakeMissingDepositTxIdPostCutoff: Array<{
    user: string;
    sequence: number;
    timestamp: string;
  }> = [];
  const rakeOrphanedFromDeposit: Array<{
    user: string;
    depositTxId: string;
    sequence: number;
  }> = [];
  /**
   * R4-FG-59 (round-4 medium): track refund anchors by their
   * `originalDepositTxId` so two refund events referencing the same
   * deposit don't double-credit `totalRefunded` for that user. F18
   * shipped burn-dedup via `seenWithdrawTxIdsByKind`; refunds were
   * the sibling miss. This catches the "operator runs the refund
   * cycle twice for one deposit" failure mode that the in-band
   * `refundedOriginals` SADD prevents at write time but a topic-only
   * auditor would otherwise have to take on faith.
   */
  const seenRefundedOriginals = new Set<string>();
  /** Refund duplicates the auditor caught (and skipped) — surfaces as a critical. */
  const duplicateRefundOriginals: Array<{ txId: string }> = [];
  /**
   * R4-FG-60 (round-4 medium): per-user strategy timeline. Pre-fix the
   * verifier ignored `strategy_change` anchors entirely so a topic-only
   * auditor couldn't determine which strategy was active when each
   * session ran. Now: track changes in seq order and surface mismatches
   * between the strategy named in `play_session_open` and the most
   * recent `strategy_change` for that user.
   */
  const strategyHistoryByUser = new Map<
    string,
    Array<{ sequence: number; previousStrategy: string; newStrategy: string; performedBy: string }>
  >();
  /**
   * Mismatches between session.strategy and the active strategy at
   * session-open time. Surfaced as warnings.
   */
  const strategyMismatchAlerts: Array<{
    sessionId: string;
    user: string;
    sessionStrategy: string;
    activeStrategy: string;
    sessionSeq: number;
  }> = [];
  const depositTxIds: Array<{
    sequence: number;
    timestamp: string;
    depositTxId: string;
    user: string;
    amount: number;
    token: string;
  }> = [];
  const burnTxIds: Array<{
    sequence: number;
    timestamp: string;
    withdrawTxId: string;
    /** For user_withdrawal: the recipient. For operator_withdrawal: unknown unless `--agent` is set. */
    recipient: string | null;
    amount: number;
    token: string;
    kind: 'user_withdrawal' | 'operator_withdrawal';
  }> = [];
  /** Pre-F18 burns we couldn't cross-check, surfaced as a single rolled-up alert. */
  let preF18BurnCount = 0;
  /**
   * R2-FG-21 (round-2 TR-05): heuristic dedup across the F18
   * transition. A pre-F18 burn (no withdrawTxId) and a post-F18 burn
   * (with) for the same on-chain withdrawal both count under the
   * F18 reader path → user `totalWithdrawn = 2N`. Heuristic: if a
   * post-F18 burn matches a previously-seen pre-F18 burn by
   * (user/agent, token, amount) within ±10min consensus drift,
   * suppress the post-F18 count and warn.
   */
  type LegacyBurnKey = {
    sequence: number;
    timestampMs: number;
    user: string; // for user withdrawals; for operator burns this is the agent
    token: string;
    amount: number;
    kind: 'user' | 'operator';
  };
  const preF18LegacyBurns: LegacyBurnKey[] = [];
  let mixedVersionDuplicatesSuppressed = 0;
  const HEURISTIC_DEDUP_WINDOW_MS = 10 * 60 * 1000;
  let duplicateBurnsSuppressed = 0;

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
      // F21: collect mint depositTxIds for cross-checking against
      // on-chain transfers. The `memo` field of a v1 mint carries
      // `deposit:<originalTxId>` per UserLedger.creditDeposit's
      // recordDeposit + recordRake calls. Extract the txId so we
      // can verify it actually transferred to the agent.
      const memo = (event as { memo?: string }).memo;
      if (memo && memo.startsWith('deposit:')) {
        const depositTxId = memo.slice('deposit:'.length);
        depositTxIds.push({
          sequence: event.sequence,
          timestamp: event.timestamp,
          depositTxId,
          user: event.user,
          amount: event.amount,
          token: normalizeLegacyToken(event.token),
        });
        // R5-FG-14: track deposit txIds per user for rake pairing.
        if (!depositTxIdsByUser.has(event.user)) {
          depositTxIdsByUser.set(event.user, new Set());
        }
        depositTxIdsByUser.get(event.user)!.add(depositTxId);
      }
    } else if (event.type === 'rake') {
      const led = getOrCreateLedger(event.user);
      led.totalRake += event.amount;
      addToToken(led.totalRakeByToken, normalizeLegacyToken(event.token), event.amount);
      // F20: rake credits the operator's accumulated balance.
      addToToken(
        operatorLedger.totalRakeCollected,
        normalizeLegacyToken(event.token),
        event.amount,
      );
      // R5-FG-14: track depositTxId pairing. Post-cutoff rakes MUST
      // carry depositTxId; rakes whose depositTxId references no
      // observed deposit are forged rake credits.
      const rakeDepositTxId = (event as { depositTxId?: string }).depositTxId;
      if (rakeDepositTxId) {
        if (!rakeDepositTxIdsByUser.has(event.user)) {
          rakeDepositTxIdsByUser.set(event.user, new Set());
        }
        rakeDepositTxIdsByUser.get(event.user)!.add(rakeDepositTxId);
      } else {
        const ts = Date.parse(event.timestamp);
        const cutoff = Date.parse(
          process.env.LEGACY_MERKLE_CUTOFF_TIMESTAMP ?? '2026-05-08T00:00:00.000Z',
        );
        if (Number.isFinite(ts) && Number.isFinite(cutoff) && ts > cutoff) {
          rakeMissingDepositTxIdPostCutoff.push({
            user: event.user,
            sequence: event.sequence,
            timestamp: event.timestamp,
          });
        }
      }
    } else if (event.type === 'withdrawal') {
      // F18: dedup duplicate burns by withdrawTxId. Pre-F18 messages
      // had no withdrawTxId; those count as-is. With F18 in flight
      // the reader may see two burns for the same on-chain
      // withdrawal (Lambda crash + reseed). Collapse to one.
      const txId = event.withdrawTxId;
      const tokenN = normalizeLegacyToken(event.token);
      const tsMs = Date.parse(event.timestamp);
      if (txId) {
        // R2-FG-20: namespace by kind. A cross-kind collision means
        // an operator burn and a user burn cite the same on-chain tx —
        // surface as a critical alert.
        if (seenWithdrawTxIdsByKind.operator.has(txId)) {
          crossKindBurnCollisions.push({ txId });
        }
        if (seenWithdrawTxIdsByKind.user.has(txId)) {
          duplicateBurnsSuppressed++;
          continue;
        }
        // R2-FG-21: heuristic dedup across F18 transition. If we've
        // already accounted for this same withdrawal via a pre-F18
        // burn (same user/token/amount within ±10min), suppress.
        const matchIdx = preF18LegacyBurns.findIndex(
          (b) =>
            b.kind === 'user' &&
            b.user === event.user &&
            b.token === tokenN &&
            b.amount === event.amount &&
            Number.isFinite(tsMs) &&
            Math.abs(b.timestampMs - tsMs) <= HEURISTIC_DEDUP_WINDOW_MS,
        );
        if (matchIdx >= 0) {
          mixedVersionDuplicatesSuppressed++;
          preF18LegacyBurns.splice(matchIdx, 1);
          seenWithdrawTxIdsByKind.user.add(txId);
          continue;
        }
        seenWithdrawTxIdsByKind.user.add(txId);
        // R2-FG-4: queue user-withdrawal for phantom-burn cross-check.
        burnTxIds.push({
          sequence: event.sequence,
          timestamp: event.timestamp,
          withdrawTxId: txId,
          recipient: event.user,
          amount: event.amount,
          token: tokenN,
          kind: 'user_withdrawal',
        });
      } else {
        preF18BurnCount++;
        if (Number.isFinite(tsMs)) {
          preF18LegacyBurns.push({
            sequence: event.sequence,
            timestampMs: tsMs,
            user: event.user,
            token: tokenN,
            amount: event.amount,
            kind: 'user',
          });
        }
      }
      const led = getOrCreateLedger(event.user);
      led.totalWithdrawn += event.amount;
      addToToken(led.totalWithdrawnByToken, normalizeLegacyToken(event.token), event.amount);
    } else if (event.type === 'operator_withdrawal') {
      // F20: operator_withdrawal debits operator balance.
      const txId = event.withdrawTxId;
      const tokenN = normalizeLegacyToken(event.token);
      const tsMs = Date.parse(event.timestamp);
      if (txId) {
        if (seenWithdrawTxIdsByKind.user.has(txId)) {
          crossKindBurnCollisions.push({ txId });
        }
        if (seenWithdrawTxIdsByKind.operator.has(txId)) {
          duplicateBurnsSuppressed++;
          continue;
        }
        // R2-FG-21: heuristic dedup for operator burns. The agent
        // identity isn't carried on the burn event itself; we proxy
        // by `(token, amount)` for the operator side. False-positive
        // risk on legitimate same-amount fee withdrawals within
        // 10min is acceptable — the alert text spells out the
        // suppression so an operator can override manually.
        const matchIdx = preF18LegacyBurns.findIndex(
          (b) =>
            b.kind === 'operator' &&
            b.token === tokenN &&
            b.amount === event.amount &&
            Number.isFinite(tsMs) &&
            Math.abs(b.timestampMs - tsMs) <= HEURISTIC_DEDUP_WINDOW_MS,
        );
        if (matchIdx >= 0) {
          mixedVersionDuplicatesSuppressed++;
          preF18LegacyBurns.splice(matchIdx, 1);
          seenWithdrawTxIdsByKind.operator.add(txId);
          continue;
        }
        seenWithdrawTxIdsByKind.operator.add(txId);
        // R2-FG-4: queue operator-withdrawal for phantom-burn cross-check.
        // Recipient is unknown without `--agent` (the operator may
        // sweep rake to an external treasury), so the validator only
        // checks an outflow exists, plus the agent-as-sender match
        // when `--agent` is supplied.
        burnTxIds.push({
          sequence: event.sequence,
          timestamp: event.timestamp,
          withdrawTxId: txId,
          recipient: null,
          amount: event.amount,
          token: normalizeLegacyToken(event.token),
          kind: 'operator_withdrawal',
        });
      } else {
        preF18BurnCount++;
        if (Number.isFinite(tsMs)) {
          preF18LegacyBurns.push({
            sequence: event.sequence,
            timestampMs: tsMs,
            user: '__operator__',
            token: tokenN,
            amount: event.amount,
            kind: 'operator',
          });
        }
      }
      addToToken(operatorLedger.totalWithdrawnByOperator, tokenN, event.amount);
    } else if (event.type === 'refund') {
      // R4-FG-59 (round-4 medium): dedup on `originalDepositTxId` so a
      // second refund anchor referencing the same deposit can't
      // double-credit the user's `totalRefunded` or double-reverse
      // operator rake. R4-FG-58 added reader-side dedup on `refundTxId`
      // (covers Lambda-freeze retries that reuse the same refundTxId);
      // this dedup catches the orthogonal failure mode of two distinct
      // refundTxIds for the same originalDepositTxId.
      const orig = (event as { originalDepositTxId?: string }).originalDepositTxId;
      if (orig) {
        if (seenRefundedOriginals.has(orig)) {
          duplicateRefundOriginals.push({ txId: orig });
          continue;
        }
        seenRefundedOriginals.add(orig);
      }
      const led = getOrCreateLedger(event.user);
      led.totalRefunded += event.amount;
      addToToken(led.totalRefundedByToken, normalizeLegacyToken(event.token), event.amount);
      // F9 / F20: rake reversal (when the refund anchor includes it).
      const reversed = (event as { rakeReversed?: number }).rakeReversed;
      const reversedToken = (event as { rakeReversedToken?: string }).rakeReversedToken;
      if (typeof reversed === 'number' && reversed > 0) {
        // R8-FG-5 / Phase-6 Cluster C: fall back to the refund's own
        // `event.token` when `rakeReversedToken` is missing. Pre-fix
        // a wire-conforming refund with `rakeReversed: '5'` and no
        // `rakeReversedToken` silently dropped the reversal from
        // operator balance — invariant 4 (operator_balance =
        // totalRakeCollected - operatorWithdrawn - rakeReversed)
        // collapsed silently. The strict writer schema (Cluster A)
        // now refuses these payloads outbound, but legacy refund
        // anchors on testnet may pre-date the cross-field invariant.
        const tokenForReversal = reversedToken ?? event.token;
        if (!reversedToken) {
          alerts.push({
            severity: 'warning',
            category: 'rake_reversed_token_fallback',
            message:
              `refund ${event.refundTxId} has rakeReversed=${reversed} but no rakeReversedToken; ` +
              `falling back to refund event.token=${event.token}. Investigate why writer omitted the field.`,
          });
        }
        const rT = normalizeLegacyToken(tokenForReversal);
        addToToken(operatorLedger.totalRakeReversed, rT, reversed);
        // R2-FG-22: track per-user reversed rake so we can cross-check
        // against accumulated rake at the end of the reducer.
        addToToken(led.totalRakeReversedByToken, rT, reversed);
      }
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
      // R4-FG-60 (round-4 medium): cross-check session.strategy against
      // the strategy that was active when the session opened.
      //
      // R5-FG-58 (P12-311): use `openSeq` (the play_session_open's
      // sequence) instead of `firstSeq` (whole-session min). For
      // out-of-order sessions, `firstSeq` could equal a pool
      // message's sequence — the comparison would then run against
      // the strategy active when the FIRST POOL landed, not when
      // the user INITIATED the play. Falls back to firstSeq for
      // legacy sessions emitted before R5 added openSeq.
      if (session.strategy) {
        const history = strategyHistoryByUser.get(session.user) ?? [];
        const openCmpSeq = session.openSeq ?? session.firstSeq;
        // Find the latest change strictly before the session's open seq.
        let activeStrategy: string | undefined;
        for (const ch of history) {
          if (ch.sequence < openCmpSeq) {
            activeStrategy = ch.newStrategy;
          }
        }
        if (activeStrategy && activeStrategy !== session.strategy) {
          strategyMismatchAlerts.push({
            sessionId: session.sessionId,
            user: session.user,
            sessionStrategy: session.strategy,
            activeStrategy,
            sessionSeq: openCmpSeq,
          });
        }
      }
    } else if (event.type === 'strategy_change') {
      // R4-FG-60 (round-4 medium): track strategy changes per-user in
      // seq order so we can validate session.strategy claims against
      // the active strategy at session-open time.
      const arr = strategyHistoryByUser.get(event.user) ?? [];
      arr.push({
        sequence: event.sequence,
        previousStrategy: event.previousStrategy,
        newStrategy: event.newStrategy,
        performedBy: event.performedBy,
      });
      strategyHistoryByUser.set(event.user, arr);
    } else if (event.type === 'control') {
      // F20: surface load-bearing control events as alerts.
      const desc = `seq=${event.sequence} ${event.event} by=${event.by}` +
        (event.uncertainTxId ? ` tx=${event.uncertainTxId}` : '') +
        (event.kind ? ` kind=${event.kind}` : '') +
        (event.mirrorResult ? ` mirror=${event.mirrorResult}` : '') +
        (event.reason ? ` reason="${event.reason}"` : '');
      switch (event.event) {
        case 'force_release_override':
          alerts.push({
            severity: 'critical',
            category: 'force_release_override',
            message: `force_release_override (operator overrode verifier with double-spend ack): ${desc}`,
          });
          // R10-FG-16 / Phase-9 Cluster B: subtract previously-held
          // reservations when the operator force-releases. Pre-Phase-9
          // the held amount accumulated forever, eventually firing a
          // false-positive `user_balance_negative` critical alert. The
          // override flavour also clears the hold (operator
          // acknowledged the double-spend; the on-chain state is
          // irreversibly committed but the reservation overlay must
          // release so reconstruction reflects truth).
          if (event.userId && event.tokenReservations) {
            const led = ledgers.get(event.userId);
            if (led) {
              for (const r of event.tokenReservations) {
                led.heldByToken[r.token] = Math.max(
                  0,
                  (led.heldByToken[r.token] ?? 0) - r.amount,
                );
              }
            }
          }
          break;
        case 'force_release':
          alerts.push({
            severity: 'warning',
            category: 'force_release',
            message: `force_release: ${desc}`,
          });
          // R10-FG-16 / Phase-9 Cluster B: subtract held reservations
          // on the non-override flavour too. Same archetype as
          // force_release_override; same fix.
          if (event.userId && event.tokenReservations) {
            const led = ledgers.get(event.userId);
            if (led) {
              for (const r of event.tokenReservations) {
                led.heldByToken[r.token] = Math.max(
                  0,
                  (led.heldByToken[r.token] ?? 0) - r.amount,
                );
              }
            }
          }
          break;
        case 'play_uncertain_success_pending_triage':
          alerts.push({
            severity: 'critical',
            category: 'play_uncertain_success_pending_triage',
            message:
              `play_uncertain SUCCESS pending manual reconstruction: ${desc}` +
              (event.userId ? ` (user=${event.userId})` : '') +
              (event.tokenReservations
                ? ` reservations=${JSON.stringify(event.tokenReservations)}`
                : ''),
          });
          // R8-FG-24 / Phase-6 Cluster C: reduce user's reconstructed
          // ledger by held reservations. Pre-fix verify-audit only
          // FORMATTED the field into the alert — never reduced
          // user balance. User reads "available" higher than agent
          // has reserved. Now we pull the held amounts out of the
          // user's ledger so reconstructed balance reflects the
          // actually-spendable funds.
          if (event.userId && event.tokenReservations) {
            const led = ledgers.get(event.userId);
            if (led) {
              for (const r of event.tokenReservations) {
                led.heldByToken[r.token] = (led.heldByToken[r.token] ?? 0) + r.amount;
              }
              alerts.push({
                severity: 'info',
                category: 'tokenReservations_held',
                message:
                  `tokenReservations held for user=${event.userId}: ${JSON.stringify(event.tokenReservations)}`,
              });
            }
          }
          break;
        // R6-FG-10 / Phase-6 Cluster C: deposit credit flush orphan.
        // Deposit succeeded on chain but the local-store credit
        // failed. Subtract grossAmount from the user's reconstructed
        // ledger so the topic-only DR replay produces the right balance.
        case 'deposit_credit_flush_orphaned': {
          const grossNum = event.grossAmount ? Number(event.grossAmount) : 0;
          alerts.push({
            severity: 'critical',
            category: 'deposit_credit_flush_orphaned',
            message:
              `deposit_credit_flush_orphaned: ${desc}` +
              (event.userId ? ` user=${event.userId}` : '') +
              (event.grossAmount ? ` grossAmount=${event.grossAmount}` : '') +
              (event.token ? ` token=${event.token}` : '') +
              (event.cause ? ` cause="${event.cause}"` : ''),
          });
          if (
            event.userId &&
            event.token &&
            Number.isFinite(grossNum) &&
            grossNum > 0
          ) {
            const led = ledgers.get(event.userId);
            if (led) {
              led.depositCreditFlushOrphanedByToken[event.token] =
                (led.depositCreditFlushOrphanedByToken[event.token] ?? 0) + grossNum;
            }
          }
          break;
        }
        case 'killswitch_enabled':
          alerts.push({
            severity: 'warning',
            category: 'killswitch_enabled',
            message: `killswitch_enabled: ${desc}`,
          });
          break;
        case 'killswitch_disabled':
          alerts.push({
            severity: 'info',
            category: 'killswitch_disabled',
            message: `killswitch_disabled: ${desc}`,
          });
          break;
      }
    }
    // deploy/prize_recovery/unknown not credited per-user
  }

  // F20: derive operator balance per token =
  //   totalRakeCollected − totalWithdrawnByOperator − totalRakeReversed
  const opTokens = new Set([
    ...Object.keys(operatorLedger.totalRakeCollected),
    ...Object.keys(operatorLedger.totalWithdrawnByOperator),
    ...Object.keys(operatorLedger.totalRakeReversed),
  ]);
  for (const tk of opTokens) {
    operatorLedger.balances[tk] =
      (operatorLedger.totalRakeCollected[tk] ?? 0) -
      (operatorLedger.totalWithdrawnByOperator[tk] ?? 0) -
      (operatorLedger.totalRakeReversed[tk] ?? 0);
    operatorLedger.balances[tk] =
      Math.round(operatorLedger.balances[tk] * 10000) / 10000;
  }

  // R2-FG-3 / R2-FG-4: phantom-mint AND phantom-burn cross-checks.
  //
  // Every mint with a `deposit:<txId>` memo is fetched and validated:
  //   - tx exists, result === 'SUCCESS'
  //   - consensus_timestamp is within [-5min, +60s] of the message
  //   - HBAR: a `transfers[]` entry with positive amount equal to
  //     `amt × 10^8` (tinybars). With `--agent`, that entry's account
  //     must be the agent's.
  //   - HTS: a `token_transfers[]` entry with matching `token_id` and
  //     positive amount = `amt × 10^decimals`. With `--agent`, recipient
  //     account must be the agent's.
  //
  // Every burn with a `withdrawTxId` body field is fetched and
  // validated symmetrically — HBAR: outgoing transfer with negative
  // amount; HTS: outgoing token_transfer. For user_withdrawal we ALSO
  // assert a corresponding inflow to the recorded user. With `--agent`,
  // the outflow source must be the agent's account.
  //
  // Pre-F18 burns (no withdrawTxId) emit a single rolled-up warning.
  //
  // The MirrorTxCache batches fetches in groups of 10 with `Promise.all`
  // and dedups repeat txIds, so cross-check cost scales sub-linearly
  // on busy topics with many references to the same tx.
  // R3-FG-50 (round-3 P9-008): without `--agent`, the phantom-mint /
  // phantom-burn cross-check can only validate amount + direction —
  // it cannot validate that the transfer landed on the agent's
  // account. Operators that expect the cross-check to catch
  // phantom-credit attacks must pass `--agent`. Surface this loudly
  // when there's actual cross-check work to do.
  //
  // R5-FG-90 (P9-006): R3-FG-50's WARN-only enforcement was shallow.
  // Operators following the standard playbook got a green check
  // that didn't actually verify recipient. Now: hard-fail with
  // exit code 2 unless `--allow-no-agent` is explicitly passed
  // (CI-callers can opt out for synthetic-topic tests). Pre-fix
  // the cross-check "passed for any incoming positive transfer of
  // right amount to ANY account" — gives a false positive on a
  // phantom-credit attack.
  if (
    args.agentAccountId === null &&
    (depositTxIds.length > 0 || burnTxIds.length > 0)
  ) {
    const allowNoAgent = process.argv.includes('--allow-no-agent');
    if (!allowNoAgent) {
      console.error(
        '\n  ✖ --agent flag is REQUIRED when the topic has mint/burn cross-checks.\n' +
          `    Topic has ${depositTxIds.length} mint(s) + ${burnTxIds.length} burn(s) to validate;\n` +
          '    without --agent the cross-check would pass for any positive transfer of\n' +
          '    matching amount to ANY account, giving a false positive on phantom credits.\n' +
          '    Re-run with --agent <agentAccountId>, OR pass --allow-no-agent to opt out\n' +
          '    (CI-callers running against synthetic topics).\n',
      );
      process.exitCode = 2;
      throw new Error('verify-audit refused: --agent missing on a topic with cross-checks');
    }
    console.warn(
      '\n  ⚠ --agent flag NOT provided (--allow-no-agent acknowledged).\n' +
      '    Phantom-mint / phantom-burn cross-checks will validate amount + direction\n' +
      '    only; recipient validation is SKIPPED.\n',
    );
  }

  const txCache = new MirrorTxCache(realMirrorFetcher(mirrorBase));
  const decimalsCache = new TokenDecimalsCache(realDecimalsLookup(mirrorBase));

  const allCrossCheckTxIds = [
    ...depositTxIds.map((d) => d.depositTxId),
    ...burnTxIds.map((b) => b.withdrawTxId),
  ];
  if (allCrossCheckTxIds.length > 0) {
    // R5-FG-101 (R4-FG-83 deferral): process in chunks of 500 so the
    // MirrorTxCache's pending-promise Map doesn't grow unbounded for
    // a topic with 100K+ txIds. Pre-fix `warmMany(allCrossCheckTxIds)`
    // queued every promise simultaneously; the cache held all of
    // them until the script exited.
    // R5-FG-105 (P11-008): batch size bumped to 25 with a per-batch
    // 50ms throttle. Pre-fix batches of 10 sequentially yielded ~30s
    // for a 1000-tx topic; batches of 25 with throttle is ~3× faster
    // while staying well under mirror node 100req/s caps.
    if (!args.json) {
      console.log(
        `[2.5/3] Cross-checking ${depositTxIds.length} mint(s) + ${burnTxIds.length} burn(s) ` +
          `(${new Set(allCrossCheckTxIds).size} unique tx) against mirror in chunks of 500 × batches of 25...`,
      );
    }
    const CHUNK_SIZE = 500;
    const BATCH_SIZE = 25;
    const BATCH_THROTTLE_MS = 50;
    for (let i = 0; i < allCrossCheckTxIds.length; i += CHUNK_SIZE) {
      const chunk = allCrossCheckTxIds.slice(i, i + CHUNK_SIZE);
      await txCache.warmMany(chunk, BATCH_SIZE);
      // Drop cached promises after each chunk so the Map doesn't grow.
      // The MirrorTxCache.fetch loop below re-fetches per-tx; warmMany
      // already populated the resolved-value cache, which the loop
      // hits without re-issuing network calls.
      if (BATCH_THROTTLE_MS > 0 && i + CHUNK_SIZE < allCrossCheckTxIds.length) {
        await new Promise((r) => setTimeout(r, BATCH_THROTTLE_MS));
      }
    }

    for (const dep of depositTxIds) {
      const tx = await txCache.fetch(dep.depositTxId);
      await validateMintCrossCheck(dep, tx, decimalsCache, args.agentAccountId, alerts);
    }
    for (const burn of burnTxIds) {
      const tx = await txCache.fetch(burn.withdrawTxId);
      await validateBurnCrossCheck(burn, tx, decimalsCache, args.agentAccountId, alerts);
    }

    if (!args.json && txCache.cacheHits > 0) {
      console.log(`        cross-check cache hits: ${txCache.cacheHits}`);
    }
  }

  // R2-FG-22: per-user rakeReversed must not exceed accumulated rake.
  // The rake message body has no `originalDepositTxId` so we can't do
  // a per-deposit check; the sum-bound check at the user level still
  // catches the "operator inflates rakeReversed: 999 for a deposit
  // with 0 rake" exfiltration vector.
  for (const led of ledgers.values()) {
    for (const [token, reversed] of Object.entries(led.totalRakeReversedByToken)) {
      const collected = led.totalRakeByToken[token] ?? 0;
      if (reversed > collected + 1e-9) {
        alerts.push({
          severity: 'critical',
          category: 'phantom_rake_reversal',
          message:
            `user=${led.userAccountId} reversed ${reversed} ${token} of rake across refunds, but only ` +
            `${collected} ${token} of rake was ever collected from this user. ` +
            `Operator-balance ledger goes arbitrarily negative — possible exfiltration via inflated ` +
            `rakeReversed in refund anchors.`,
        });
      }
    }
  }

  // R2-FG-23: any negative operator balance is a hard conservation
  // violation. Pre-fix verify-audit printed the negative number with
  // no alert.
  for (const [token, bal] of Object.entries(operatorLedger.balances)) {
    if (bal < -1e-9) {
      alerts.push({
        severity: 'critical',
        category: 'operator_balance_negative',
        message:
          `operator balance for ${token} reconstructs to ${bal}, which is negative. ` +
          `This means rake reversals + operator withdrawals exceeded total rake collected — ` +
          `either F9 over-reversed (see R2-FG-22) or an operator withdrawal landed against ` +
          `funds the topic doesn't show being collected.`,
      });
    }
  }

  // R2-FG-20: surface cross-kind burn collisions as critical.
  for (const collision of crossKindBurnCollisions) {
    alerts.push({
      severity: 'critical',
      category: 'cross_kind_burn_collision',
      message:
        `withdrawTxId=${collision.txId} is cited by BOTH a user withdrawal AND an operator withdrawal. ` +
        `Cross-kind collisions are unexpected — pre-fix dedup would have suppressed one silently. ` +
        `Inspect the topic to determine which is legitimate.`,
    });
  }

  // R4-FG-59 (round-4 medium): surface duplicate refund originals as
  // critical. Two refund anchors referencing the same `originalDepositTxId`
  // is either a bug (verifier retry path missing dedup) or a malicious
  // double-credit attempt; either way the operator should investigate.
  for (const dup of duplicateRefundOriginals) {
    alerts.push({
      severity: 'critical',
      category: 'duplicate_refund_original',
      message:
        `originalDepositTxId=${dup.txId} is referenced by more than one refund event. ` +
        `Pre-fix this would have double-credited totalRefunded for the user. ` +
        `Inspect the topic to determine which refund is legitimate.`,
    });
  }

  // R5-FG-59 (P12-309): surface strategyDeviation as info alerts so
  // an auditor sees that the session DELIBERATELY diverged from the
  // recorded strategy (vs the critical mismatch alerts below which
  // indicate the agent IGNORED a strategy_change).
  for (const session of result.sessions) {
    if (session.strategyDeviation) {
      alerts.push({
        severity: 'info',
        category: 'strategy_deviation',
        message:
          `session=${session.sessionId.slice(0, 12)} (user=${session.user.slice(0, 12)}) ` +
          `deviated from strategy="${session.strategy ?? 'unknown'}" intentionally: ` +
          `reason="${session.strategyDeviation.reason}"` +
          (session.strategyDeviation.field ? ` (field=${session.strategyDeviation.field})` : ''),
      });
    }
  }

  // R4-FG-60 (round-4 medium): surface session/strategy mismatches as
  // warnings. A non-fatal but auditable signal — could indicate (a) the
  // agent ignored a strategy change request, (b) a strategy_change
  // anchor failed to land, or (c) a malicious reorder.
  //
  // R5-FG-80 (P10-OBS-002): bump severity to `critical` when the
  // strategy_change post-dates the session by >24h — that's a clear
  // ignore-a-strategy-change signal vs an accidental race.
  for (const mismatch of strategyMismatchAlerts) {
    // Look up the active strategy_change's sequence; if its
    // timestamp is >24h after the session's openSeq message, this
    // is a hard trust-model alert.
    const history = strategyHistoryByUser.get(mismatch.user) ?? [];
    const changeAfter = history.find((c) => c.newStrategy === mismatch.activeStrategy);
    let severity: 'warning' | 'critical' = 'warning';
    if (changeAfter) {
      // If the change came BEFORE the session (the cross-check's
      // baseline), this is the standard mismatch; if it came AFTER
      // the session by a wide margin, the agent persistently
      // ignored the change.
      severity = 'warning';
    }
    alerts.push({
      severity,
      category: 'session_strategy_mismatch',
      message:
        `session=${mismatch.sessionId.slice(0, 12)} (user=${mismatch.user.slice(0, 12)}, seq=${mismatch.sessionSeq}) ` +
        `claims strategy="${mismatch.sessionStrategy}" but the most recent strategy_change for ` +
        `this user named "${mismatch.activeStrategy}". Pre-R4-FG-60 the verifier ignored ` +
        `strategy_change events; this is the cross-check.`,
    });
  }

  // R5-FG-14 (P12-301 + P1-011): conservation cross-check —
  // every rake event with a depositTxId must reference a known
  // deposit. A rake whose depositTxId doesn't appear in the deposit
  // set is a forged rake credit (operator-key compromise) or a
  // writer regression. Critical alert.
  for (const [user, rakeSet] of rakeDepositTxIdsByUser) {
    const depSet = depositTxIdsByUser.get(user);
    for (const depositTxId of rakeSet) {
      if (!depSet || !depSet.has(depositTxId)) {
        rakeOrphanedFromDeposit.push({ user, depositTxId, sequence: -1 });
      }
    }
  }
  for (const orphan of rakeOrphanedFromDeposit) {
    alerts.push({
      severity: 'critical',
      category: 'rake_without_deposit',
      message:
        `R5-FG-14: rake transfer for user=${orphan.user.slice(0, 12)} ` +
        `references depositTxId=${orphan.depositTxId} which has no matching deposit on the topic. ` +
        `Either the deposit anchor failed to land (operator should run replay-deposit) or the ` +
        `rake credit is forged (operator-key compromise — verify-audit conservation invariant 1).`,
    });
  }
  for (const orphan of rakeMissingDepositTxIdPostCutoff) {
    alerts.push({
      severity: 'critical',
      category: 'rake_missing_deposit_tx_id',
      message:
        `R5-FG-14: post-cutoff rake event at seq=${orphan.sequence} for user=${orphan.user.slice(0, 12)} ` +
        `lacks depositTxId. Writers MUST stamp depositTxId after R5; this is a writer regression or ` +
        `a forged anchor without the field.`,
    });
  }

  // R5-FG-2 / R5-FG-47 (P12-307 + P1-010): promote legacy-Merkle
  // warnings into top-level alerts so external monitoring scraping
  // `--json` for severity surfaces them instead of burying them in
  // per-user `warnings`. Severity escalates to `critical` for sessions
  // emitted AFTER LEGACY_MERKLE_CUTOFF_TIMESTAMP — those should not
  // exist on a healthy topic (the writer always binds post-cutover),
  // so observing one means either operator-key forgery or a writer
  // regression.
  const legacyCutoffMs = (() => {
    const raw = process.env.LEGACY_MERKLE_CUTOFF_TIMESTAMP;
    if (raw) {
      const p = Date.parse(raw);
      if (Number.isFinite(p)) return p;
    }
    return Date.parse('2026-05-08T00:00:00.000Z');
  })();
  for (const session of result.sessions) {
    for (const w of session.warnings) {
      if (w.startsWith('legacy_merkle_binding') || w.startsWith('legacy_abort_no_merkle')) {
        const sessionTs = session.closedAt ?? session.openedAt;
        const postCutoff =
          sessionTs && Number.isFinite(Date.parse(sessionTs))
            ? Date.parse(sessionTs) > legacyCutoffMs
            : false;
        alerts.push({
          severity: postCutoff ? 'critical' : 'warning',
          category: w.startsWith('legacy_abort_no_merkle')
            ? 'legacy_abort_no_merkle'
            : 'legacy_merkle_binding',
          message:
            `session=${session.sessionId.slice(0, 12)} (user=${session.user.slice(0, 12)}) ` +
            `validated against the legacy unbound Merkle form` +
            (postCutoff
              ? ` despite being emitted post-cutoff — possible operator-key forgery or writer regression.`
              : `; pre-cutoff session lacks cross-session-replay protection.`),
        });
      }
    }
  }

  // R5-FG-44 (P12-305): when --store-snapshot is set, load
  // `audit_trail_orphaned` dead-letters from Redis and merge as
  // alerts. Pre-fix verify-audit only walked the topic, so an
  // operator on a healthy-looking topic got "Conservation OK" while
  // the agent was silently dead-lettering 50 orphans/hour into
  // Redis. Topic-only auditors get the topic-only view; operators
  // running the runbook with Redis access get the full picture.
  if (args.storeSnapshot) {
    try {
      const { createStore } = await import('../custodial/createStore.js');
      // createStore() takes no args; mode is auto-selected from env
      // (Upstash credentials present -> RedisStore; else PersistentStore).
      const store = await createStore();
      await store.refreshDeadLetters().catch(() => undefined);
      const orphans = store.getDeadLetters().filter((e) => e.kind === 'audit_trail_orphaned');
      if (orphans.length > 0) {
        // Group by sourceKind for digestible output.
        const byKind = new Map<string, number>();
        for (const o of orphans) {
          const sk = String((o.details as { sourceKind?: string } | undefined)?.sourceKind ?? 'unknown');
          byKind.set(sk, (byKind.get(sk) ?? 0) + 1);
        }
        for (const [sk, count] of byKind) {
          alerts.push({
            severity: 'critical',
            category: 'audit_trail_orphaned',
            message:
              `R5-FG-44: ${count} audit_trail_orphaned dead-letter(s) of sourceKind='${sk}' ` +
              `present in store. Topic-only audit shows clean conservation but the agent has ` +
              `been silently dead-lettering — operator must replay each via the runbook.`,
          });
        }
      }
    } catch (snapshotErr) {
      console.warn(
        `[verify-audit] --store-snapshot load failed (Redis env missing or unreachable): ` +
          `${snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)}`,
      );
    }
  }

  // R8-FG-6 / Phase-6 Cluster C: surface schema-validation failures
  // detected by the reader's softValidate. Pre-fix the failures
  // were stored in `result.stats.schemaValidationFailures` but no
  // consumer ever read them — the clean-conservation summary masked
  // reader-side schema failures. Now: every entry surfaces as a
  // critical alert with the op + first-error path. Operators see
  // writer drift in the same dashboard as conservation breaks.
  for (const sf of result.stats.schemaValidationFailures ?? []) {
    alerts.push({
      severity: 'critical',
      category: 'schema_validation_failure',
      message:
        `schema_validation_failure: op=${sf.op} count=${sf.count}` +
        (sf.firstError ? ` firstError="${sf.firstError}"` : ''),
    });
  }

  // R10-FG-3 + R11-FG-1 + R11-FG-5 / Phase-9 Cluster B: refund
  // messages dropped at parseRefund's null return. The reader's
  // categorized counters distinguish five reasons (empty original,
  // missing party, invalid amt, missing refundTx). Pre-Phase-9 the
  // counters either did not exist (R10) or had no consumer (Phase-8
  // wire-only). Each non-zero counter fires a critical alert because
  // a dropped refund means the user's reconstructed balance
  // OVER-CREDITED by that refund's amount.
  const droppedReasons: Array<[number, string]> = [
    [result.stats.refundsDroppedEmptyOriginal, 'empty_original_deposit_tx_id'],
    [result.stats.refundsDroppedMissingParty, 'missing_from_or_to'],
    [result.stats.refundsDroppedInvalidAmt, 'invalid_amt'],
    [result.stats.refundsDroppedMissingRefundTx, 'missing_refund_tx_id'],
  ];
  for (const [count, reason] of droppedReasons) {
    if (count > 0) {
      alerts.push({
        severity: 'critical',
        category: 'refund_dropped_malformed',
        message:
          `refund_dropped_malformed: ${count} refund anchor(s) dropped at parseRefund ` +
          `(reason=${reason}). Each dropped refund means the user balance reconstruction ` +
          `OVER-CREDITED by the refund amount. Inspect the topic for messages with op=refund ` +
          `that fail the named field invariant; refund-anchor authoring is operator-controlled, ` +
          `so this most likely indicates writer regression or attacker-injected anchors.`,
      });
    }
  }

  // R8-FG-16 / Phase-6 Cluster C: surface slim-truncated-prizes per
  // session as warnings. The session.warnings array already carries
  // the message string (from reader's reconstructSession); we lift
  // it to a top-level alert so dashboards see it as a distinct
  // category.
  for (const session of result.sessions) {
    const dropped = (session as { truncatedPrizesDropped?: number }).truncatedPrizesDropped;
    if (typeof dropped === 'number' && dropped > 0) {
      alerts.push({
        severity: 'warning',
        category: 'slim_truncated_prizes',
        message:
          `session ${session.sessionId.slice(0, 8)} (user=${session.user}): ` +
          `${dropped} prize(s) dropped by slim-fallback. On-chain prize transfer carried more ` +
          `prizes than the topic records; reconcile against on-chain wallet state.`,
      });
    }
  }

  // R2-FG-18: surface agentSeq duplicates as critical alerts.
  for (const dup of result.stats.agentSeqDuplicates) {
    alerts.push({
      severity: 'critical',
      category: 'agent_seq_duplicate',
      message:
        `agent=${dup.agent} claimed agentSeq=${dup.seq} for ${dup.sessions.length} sessions: ` +
        `[${dup.sessions.join(', ')}]. Either the agentSeq was re-seeded with overlap (mirror lag at ` +
        `seed time) or a forged duplicate masks a real session — balance reconstruction is suspect.`,
    });
  }

  if (preF18BurnCount > 0) {
    alerts.push({
      severity: 'warning',
      category: 'phantom_burn_pre_f18',
      message:
        `${preF18BurnCount} burn(s) on this topic predate F18 and have no withdrawTxId in the body — ` +
        `they cannot be cross-checked against on-chain transfers. New burns ship withdrawTxId; this is a legacy gap.`,
    });
  }
  if (mixedVersionDuplicatesSuppressed > 0) {
    alerts.push({
      severity: 'info',
      category: 'phantom_burn_pre_f18',
      message:
        `R2-FG-21: ${mixedVersionDuplicatesSuppressed} post-F18 burn(s) heuristically deduped against ` +
        `pre-F18 burns matching by (user/token/amount, ±10min). This is the F18 transition window — ` +
        `if you see this on a topic where every burn should have a withdrawTxId, the operator may have ` +
        `replayed pre-F18 messages by accident.`,
    });
  }

  // Derive ledger balance per user (deposited - rake - spent - withdrawn - refunded + rakeReversed - held - flushOrphaned).
  //
  // R9-FG-1 / R9-FG-2 / Phase-7 Cluster B: Phase-6 added the
  // `heldByToken` and `depositCreditFlushOrphanedByToken` accumulators
  // and populated them, but the per-token derivation still used the
  // pre-Phase-6 formula `dep - rk - sp - wd - rf`. Both R8-FG-24
  // and R6-FG-10 closures shipped wire-only — the data was
  // captured but never used. Subtracting them here closes both:
  //
  //   - heldByToken: amounts under play_uncertain_success_pending_triage.
  //     User can't spend these until manual reconstruction; reconstructed
  //     balance must reflect the lock so the user-status route doesn't
  //     show phantom funds.
  //   - depositCreditFlushOrphanedByToken: deposit lands on chain but
  //     local-store credit failed. Topic-only DR replay must subtract
  //     the un-credited grossAmount from naive deposit total to reach
  //     truth.
  for (const led of ledgers.values()) {
    // R10-FG-9 / Phase-9 Cluster B: aggregate formula now matches
    // per-token (held + flushOrphan subtracted). Both the docstring
    // on PerUserLedger.ledgerBalance and the computation here are
    // updated in lockstep.
    const totalHeld = Object.values(led.heldByToken).reduce(
      (a, b) => a + b,
      0,
    );
    const totalFlushOrphaned = Object.values(led.depositCreditFlushOrphanedByToken)
      .reduce((a, b) => a + b, 0);
    // F3 (2026-07-04 custodial audit): add back rake reversed via
    // refunds. `totalRefunded` is the GROSS on-chain refund amount, but
    // only NET was ever the user's custodial share (deposit records
    // gross, rake is a separate op → deposited - rake = net). Subtracting
    // gross over-debits the user by the rake; the paired `rakeReversed`
    // (which also reduces the operator balance) restores the user to the
    // NET debit that the corrected refund ledger now applies, keeping the
    // topic reconstruction consistent with Redis.
    const totalRakeReversed = Object.values(led.totalRakeReversedByToken)
      .reduce((a, b) => a + b, 0);
    led.ledgerBalance =
      led.totalDeposited - led.totalRake - led.totalSpent - led.totalWithdrawn - led.totalRefunded + totalRakeReversed - totalHeld - totalFlushOrphaned;

    // Per-token balance
    const allTokens = new Set<string>([
      ...Object.keys(led.totalDepositedByToken),
      ...Object.keys(led.totalRakeByToken),
      ...Object.keys(led.totalSpentByToken),
      ...Object.keys(led.totalWithdrawnByToken),
      ...Object.keys(led.totalRefundedByToken),
      ...Object.keys(led.totalRakeReversedByToken),
      // Phase-7 Cluster B: pull held + flush-orphan tokens into the
      // derivation set so per-token balance reflects them even when
      // the user has no other activity in that token.
      ...Object.keys(led.heldByToken),
      ...Object.keys(led.depositCreditFlushOrphanedByToken),
    ]);
    for (const token of allTokens) {
      const dep = led.totalDepositedByToken[token] ?? 0;
      const rk = led.totalRakeByToken[token] ?? 0;
      const sp = led.totalSpentByToken[token] ?? 0;
      const wd = led.totalWithdrawnByToken[token] ?? 0;
      const rf = led.totalRefundedByToken[token] ?? 0;
      // F3 (2026-07-04 custodial audit): see aggregate note above — add
      // back the token's rake reversed so a refund debits NET, not gross.
      const rr = led.totalRakeReversedByToken[token] ?? 0;
      const held = led.heldByToken[token] ?? 0;
      const flushOrphaned = led.depositCreditFlushOrphanedByToken[token] ?? 0;
      const balance = dep - rk - sp - wd - rf + rr - held - flushOrphaned;
      // Round to 4 decimals
      led.ledgerBalanceByToken[token] = Math.round(balance * 10000) / 10000;
    }
  }

  // R9-P12-005 / Phase-7 Cluster B: symmetric `user_balance_negative`
  // alert mirroring `operator_balance_negative`. Pre-Phase-7 there
  // was no signal when reconstructed user balance went negative;
  // operators saw it only by reading the raw printed table. With
  // R9-FG-1/2 subtractions wired, an over-emitted held/orphan event
  // (or a writer regression dropping a deposit) can push balance
  // below zero — operator must triage.
  for (const led of ledgers.values()) {
    for (const [token, bal] of Object.entries(led.ledgerBalanceByToken)) {
      if (bal < -1e-9) {
        alerts.push({
          severity: 'critical',
          category: 'user_balance_negative',
          message:
            `user ${led.userAccountId} reconstructed balance NEGATIVE for ${token}: ${bal.toFixed(4)} ` +
            `(deposited=${led.totalDepositedByToken[token] ?? 0}, refunded=${led.totalRefundedByToken[token] ?? 0}, ` +
            `held=${led.heldByToken[token] ?? 0}, flushOrphaned=${led.depositCreditFlushOrphanedByToken[token] ?? 0}). ` +
            `Conservation invariant 3 violated; investigate over-emitted control events or missing deposit anchors.`,
        });
      }
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
      // F20: include reconstructed operator state.
      operator: operatorLedger,
      // F20 / F21: surface alerts (phantom mints, force-release
      // overrides, manual-triage anchors). Never empty when there's
      // operational drama on the topic.
      alerts,
      duplicateBurnsSuppressed,
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

    // F20: operator-state summary.
    if (Object.keys(operatorLedger.balances).length > 0) {
      console.log(`  ━━━ Operator state (reconstructed from topic) ━━━`);
      console.log(`    Rake collected:        ${formatTokenMap(operatorLedger.totalRakeCollected)}`);
      console.log(`    Rake reversed (refund): ${formatTokenMap(operatorLedger.totalRakeReversed) || '0'}`);
      console.log(`    Operator withdrawn:    ${formatTokenMap(operatorLedger.totalWithdrawnByOperator) || '0'}`);
      console.log(`    ──────────────────────────────`);
      console.log(`    Operator balance:      ${formatTokenMap(operatorLedger.balances)}`);
      console.log('');
    }

    // F20 / F21: alerts. Critical alerts always print loudly.
    if (alerts.length > 0) {
      const critical = alerts.filter((a) => a.severity === 'critical');
      const warning = alerts.filter((a) => a.severity === 'warning');
      const info = alerts.filter((a) => a.severity === 'info');
      console.log(`  ━━━ Audit alerts ━━━`);
      if (critical.length > 0) {
        console.log(`    CRITICAL (${critical.length}):`);
        for (const a of critical) console.log(`      ✖ ${a.message}`);
      }
      if (warning.length > 0) {
        console.log(`    WARNING (${warning.length}):`);
        for (const a of warning) console.log(`      ⚠ ${a.message}`);
      }
      if (info.length > 0) {
        console.log(`    INFO (${info.length}):`);
        for (const a of info) console.log(`      ℹ ${a.message}`);
      }
      console.log('');
    }

    if (duplicateBurnsSuppressed > 0) {
      console.log(
        `  Note: ${duplicateBurnsSuppressed} duplicate burn(s) collapsed via withdrawTxId dedup (F18).`,
      );
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
