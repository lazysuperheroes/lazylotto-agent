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
    process.exit(2);
  }

  console.log(`  ✓ Transfer succeeded on attempt ${txResult.attempt}`);
  console.log(`      Tx ID: ${txResult.result.transactionId}`);
  console.log(`      Gas used: ${txResult.gasUsed}`);
  console.log(`      Status: ${txResult.result.status.toString()}`);

  // ── Step 5: record on HCS-20 audit topic ────────────────
  console.log('');
  console.log('[5/5] Recording prize_recovery on HCS-20 audit topic...');
  const hcs20TopicId = process.env.HCS20_TOPIC_ID;
  if (!hcs20TopicId) {
    console.warn('      ⚠ HCS20_TOPIC_ID not set in env — skipping audit log entry.');
    console.warn('      The contract transfer succeeded, but the audit trail will not show this recovery.');
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
  process.exit(0);
}

main().catch((err) => {
  console.error('');
  console.error('Fatal error:', err);
  process.exit(1);
});
