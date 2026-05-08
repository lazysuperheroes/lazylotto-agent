#!/usr/bin/env tsx
/**
 * One-shot operator recovery script for prizes that got stranded in the
 * agent wallet because the in-flight transferPendingPrizes call failed.
 *
 * Background: LottoAgent.safeTransferPrizes used to swallow contract
 * errors silently and the session record hardcoded prizesTransferred:true
 * regardless of outcome. The first reproducible failure mode found in
 * production was INSUFFICIENT_GAS — gas was sized as 500K base + 0 per
 * prize, which fits a 1-prize session but blows up on anything bigger.
 *
 * This script:
 *   1. Reads the agent wallet's currently pending prizes via the dApp MCP
 *   2. Compares with the target user's local play history (informational)
 *   3. Calls transferPendingPrizes(userEvm, MaxUint256) with the new
 *      escalating-gas retry ladder (225K → 300K → 400K per prize)
 *   4. Records an HCS-20 prize_recovery message on the audit topic
 *
 * Usage:
 *   npx tsx src/scripts/recover-stuck-prizes.ts <userAccountId> [--execute] [--reason "..."]
 *
 *   --execute        actually perform the transfer (default is dry-run)
 *   --reason "..."   free-text reason recorded in the HCS-20 audit entry
 *
 * Safety:
 *   - Default mode is dry-run; --execute is required to send the tx
 *   - The script logs every action to stdout so the operator can verify
 *   - The HCS-20 audit topic gets a permanent record of every recovery
 *   - WARNING: this transfers ALL of the agent wallet's pending prizes
 *     to the target user. If multiple users have stranded prizes, run
 *     the diagnostic at the top of this script first to confirm the
 *     pending prize set belongs only to the target user.
 */

import 'dotenv/config';
import { createClient, getOperatorAccountId } from '../hedera/wallet.js';
import { toEvmAddress } from '../utils/format.js';
import { transferAllPrizesWithRetry } from '../hedera/contracts.js';
import { getUserState, getSystemInfo } from '../mcp/client.js';
import { AccountingService } from '../custodial/AccountingService.js';
import { acquireUserLock, releaseUserLock, startUserLockHeartbeat } from '../lib/locks.js';
import { createStore } from '../custodial/createStore.js';

interface CliArgs {
  userAccountId: string;
  execute: boolean;
  reason: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0]?.startsWith('-')) {
    console.error('Usage: npx tsx src/scripts/recover-stuck-prizes.ts <userAccountId> [--execute] [--reason "..."]');
    console.error('');
    console.error('Default mode is dry-run. Pass --execute to actually transfer prizes.');
    process.exit(1);
  }

  const userAccountId = args[0]!;
  const execute = args.includes('--execute');
  const reasonIdx = args.indexOf('--reason');
  const reason = reasonIdx >= 0 && args[reasonIdx + 1] ? args[reasonIdx + 1]! : 'manual recovery via script';

  if (!/^0\.0\.\d+$/.test(userAccountId)) {
    console.error(`Invalid user account ID: ${userAccountId}. Expected 0.0.X format.`);
    process.exit(1);
  }

  return { userAccountId, execute, reason };
}

async function main() {
  const { userAccountId, execute, reason } = parseArgs();

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  LazyLotto Stuck Prize Recovery');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Mode:    ${execute ? '🔴 EXECUTE (will modify chain state)' : '🟡 dry-run'}`);
  console.log(`  Target:  ${userAccountId}`);
  console.log(`  Reason:  ${reason}`);
  console.log('');

  const client = createClient();
  const agentAccountId = getOperatorAccountId(client);
  console.log(`  Agent wallet: ${agentAccountId}`);

  // ── Step 1: read agent's pending prizes ─────────────────
  console.log('');
  console.log('[1/5] Reading agent pending prizes via dApp MCP...');
  const agentState = await getUserState(agentAccountId);
  console.log(`      Pending count: ${agentState.pendingPrizesCount}`);

  if (agentState.pendingPrizesCount === 0) {
    console.log('');
    console.log('  ✓ Nothing to recover. Exiting.');
    process.exit(0);
  }

  // Group by token + count NFTs for the human-readable summary
  const fungibleByToken: Record<string, number> = {};
  let nftCount = 0;
  for (const p of agentState.pendingPrizes) {
    if (p.fungiblePrize?.amount > 0) {
      const tk = p.fungiblePrize.token;
      fungibleByToken[tk] = (fungibleByToken[tk] ?? 0) + p.fungiblePrize.amount;
    }
    for (const n of p.nfts) {
      nftCount += n.serials.length;
    }
  }
  console.log('      Breakdown:');
  for (const [tk, amt] of Object.entries(fungibleByToken)) {
    console.log(`        - ${amt} ${tk}`);
  }
  if (nftCount > 0) {
    console.log(`        - ${nftCount} NFT(s)`);
  }

  // ── Step 2: also check what the user currently has (sanity) ─
  console.log('');
  console.log(`[2/5] Checking ${userAccountId} current pending prizes (sanity)...`);
  const userState = await getUserState(userAccountId);
  console.log(`      User pending count: ${userState.pendingPrizesCount}`);
  if (userState.pendingPrizesCount > 0) {
    console.log('      ⚠ User already has prizes pending. Recovery will add to these.');
  }

  // ── Step 3: get contract id ─────────────────────────────
  console.log('');
  console.log('[3/5] Resolving LazyLotto contract via dApp MCP...');
  const sys = await getSystemInfo();
  const contractId = sys.contractAddresses.lazyLotto;
  console.log(`      Contract: ${contractId}`);
  console.log(`      Network:  ${sys.network}`);

  const userEvm = toEvmAddress(userAccountId);
  console.log(`      User EVM: ${userEvm}`);

  // ── Step 4: execute or dry-run ──────────────────────────
  console.log('');
  console.log(`[4/5] ${execute ? 'Executing' : 'Would execute'} transferPendingPrizes...`);
  console.log(`      Prize count for gas sizing: ${agentState.pendingPrizesCount}`);
  console.log('      Gas ladder (retries on INSUFFICIENT_GAS):');
  console.log(`        Try 1: 500K + 225K × ${agentState.pendingPrizesCount} = ${500_000 + 225_000 * agentState.pendingPrizesCount}`);
  console.log(`        Try 2: 500K + 300K × ${agentState.pendingPrizesCount} = ${500_000 + 300_000 * agentState.pendingPrizesCount}`);
  console.log(`        Try 3: 500K + 400K × ${agentState.pendingPrizesCount} = ${500_000 + 400_000 * agentState.pendingPrizesCount}`);
  console.log('        (capped at 14M)');

  if (!execute) {
    console.log('');
    console.log('  ⚠ Dry-run mode. Pass --execute to perform the transfer.');
    process.exit(0);
  }

  // R2-FG-27 (round-2 G-07): unified locking with the MCP path. The
  // pre-fix CLI used `recover-cli:0.0.X` (account-id keyed); MCP
  // uses `lockUser:<internalUserId>` (UUID keyed). Different keys
  // → concurrent runs both proceeded → cross-user prize contamination
  // possible. Resolve the internal userId via the same store the MCP
  // path uses, then acquire `lockUser:<internalUserId>` — the EXACT
  // same key.
  const store = await createStore();
  const userAccount = store.getUserByAccountId(userAccountId);
  if (!userAccount) {
    console.error(
      `  ✗ No registered user found for ${userAccountId}. ` +
        `Cannot recover prizes for an account the agent has no record of.`,
    );
    process.exit(3);
  }
  const recoveryLockKey = userAccount.userId;
  // R4-FG-15 (round-4 high): TTL bumped from 300s → 600s. The
  // transferAllPrizesWithRetry ladder runs up to 3 retries × ~16s
  // receipt ceiling each ≈ 48s on happy path; on slow mainnet day
  // with mirror propagation wait + HCS audit + per-prize re-read,
  // worst case pushed past 5 minutes. A 300s TTL guaranteed
  // mid-flight lock loss; another caller (in-band MCP recover, or
  // parallel CLI) could acquire + submit a SECOND
  // `transferPendingPrizes` call. Contract is idempotent at
  // prize-set level (no double-spend) but two `prize_recovery` HCS
  // messages emit, both claiming success — topic-only auditor sees
  // a phantom recovery.
  const lockToken = await acquireUserLock(recoveryLockKey, 600);
  if (!lockToken) {
    console.error(
      `  ✗ Another op holds lockUser:${recoveryLockKey} for ${userAccountId}. ` +
        `(Could be the MCP recover_stuck_prizes tool, an in-band withdraw, ` +
        `or another CLI invocation.) Aborting.`,
    );
    process.exit(3);
  }

  // R5-FG-27 (P6-009): wrap the entire post-acquire body in
  // try/finally so any throw, early-return, or `process.exit` from
  // a nested helper releases the lock instead of leaving it stuck
  // for the full 600s TTL. Pre-fix only two release paths existed
  // (transfer-fail catch + happy-path tail); every other failure
  // mode (audit-write throw, getUserState throw, mirror propagation
  // setTimeout error) silently held the lock.
  //
  // R5-FG-28 (P6-003): heartbeat the lock so a slow mainnet round
  // (transferAllPrizesWithRetry: 3×~16s + 5s mirror wait + 2× MCP
  // getUserState + recordPrizeRecovery + verification) doesn't
  // exceed the 600s TTL. Mirrors R4-FG-66's reconcile heartbeat.
  const recoveryLockHeartbeat = startUserLockHeartbeat(
    recoveryLockKey,
    lockToken,
    600,
    60_000,
  );
  let exitCode = 0;
  try {
    console.log('');
    console.log('  → Calling contract...');
    let txResult;
    try {
      txResult = await transferAllPrizesWithRetry(
        client,
        contractId,
        userEvm,
        agentState.pendingPrizesCount,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attemptsLog = (err as Error & { attemptsLog?: unknown[] }).attemptsLog;
      console.error('');
      console.error(`  ✗ Transfer failed: ${message}`);
      if (attemptsLog) {
        console.error('  Attempts:');
        console.error(JSON.stringify(attemptsLog, null, 2));
      }
      exitCode = 2;
      return;
    }

    console.log(`  ✓ Transfer succeeded on attempt ${txResult.attempt}`);
    console.log(`      Tx ID: ${txResult.result.transactionId}`);
    console.log(`      Gas used: ${txResult.gasUsed}`);
    console.log(`      Status: ${txResult.result.status.toString()}`);

    // ── Step 5: record on HCS-20 audit topic ────────────────
    console.log('');
    console.log('[5/5] Recording prize_recovery on HCS-20 audit topic...');
    const hcs20TopicId = process.env.HCS20_TOPIC_ID;
    // R4-FG-18 (round-4 high): exit code 4 when the audit log fails.
    // Pre-fix the script printed a warning and exited 0; cron / ops
    // runbook scripts saw "success" even though the topic is missing
    // a `prize_recovery` anchor — defeats the very purpose of the
    // audit trail. Track the failure and exit non-zero before the
    // final `process.exit(0)`.
    let auditWriteFailed = false;
    if (!hcs20TopicId) {
      console.warn('      ⚠ HCS20_TOPIC_ID not set in env — skipping audit log entry.');
      console.warn('      The contract transfer succeeded, but the audit trail will not show this recovery.');
      auditWriteFailed = true;
    } else {
      const tick = process.env.HCS20_TICK ?? 'LLCRED';
      const accounting = new AccountingService({ client, tick, topicId: hcs20TopicId });
      try {
        await accounting.recordPrizeRecovery({
          userAccountId,
          agentAccountId,
          prizesTransferred: agentState.pendingPrizesCount,
          prizesByToken: fungibleByToken,
          contractTxId: txResult.result.transactionId,
          reason,
          performedBy: agentAccountId, // script runs as agent operator
          attempts: txResult.attempt,
          gasUsed: txResult.gasUsed,
        });
        console.log('      ✓ Audit entry submitted');
      } catch (err) {
        console.error(`      ✗ Audit log failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error('      Recovery itself succeeded; only the audit log entry failed.');
        auditWriteFailed = true;
      }
    }

    // ── Verification ────────────────────────────────────────
    console.log('');
    console.log('Post-recovery verification:');
    // Mirror node propagation delay
    console.log('  Waiting 5s for mirror node propagation...');
    await new Promise((r) => setTimeout(r, 5000));
    const agentAfter = await getUserState(agentAccountId);
    const userAfter = await getUserState(userAccountId);
    console.log(`  Agent pending after: ${agentAfter.pendingPrizesCount} (was ${agentState.pendingPrizesCount})`);
    console.log(`  User pending after:  ${userAfter.pendingPrizesCount} (was ${userState.pendingPrizesCount})`);

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Recovery complete.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    // R4-FG-18: exit non-zero when audit log failed so monitoring shells
    // surface the missing anchor.
    if (auditWriteFailed) {
      console.error('  ⚠ EXIT 4: audit log entry missing — prize_recovery anchor absent from topic.');
      exitCode = 4;
    }
  } finally {
    recoveryLockHeartbeat.cancel();
    await releaseUserLock(recoveryLockKey, lockToken);
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('');
  console.error('Fatal error:', err);
  process.exit(1);
});
