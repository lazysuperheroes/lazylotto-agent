#!/usr/bin/env -S tsx
/**
 * Phase-4 R7: orphan-claim reconciler CLI entrypoint.
 *
 * Walks every fenced-claim namespace registered in
 * `src/lib/orphanReconciler.ts` and prints a structured report of
 * stale claims (held > 50% of expected TTL by default).
 *
 * Usage:
 *   npm run reconcile:orphans                       # default 0.5 ratio
 *   npm run reconcile:orphans -- --ratio 0.75       # tighter threshold
 *   npm run reconcile:orphans -- --json             # machine-readable
 *
 * SAFETY: passive observer. Does NOT release any claim. The
 * operator's decision to manually clear a claim must be informed
 * by on-chain state (mirror-node check, audit-trail walk), not by
 * the reconciler's report alone — releasing a claim whose holder
 * still has a successful on-chain action mid-flight reopens the
 * very double-spend windows the fence exists to close.
 */

import { reconcileOrphans } from '../lib/orphanReconciler.js';

function parseArgs(): { ratio: number; json: boolean } {
  const argv = process.argv.slice(2);
  let ratio = 0.5;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ratio') {
      const next = argv[++i];
      const parsed = next ? Number(next) : NaN;
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1) {
        ratio = parsed;
      } else {
        console.error(`[reconcile-orphans] invalid --ratio "${next}", expected 0 < x <= 1`);
        process.exit(1);
      }
    } else if (a === '--json') {
      json = true;
    } else if (a === '--help' || a === '-h') {
      console.log(
        `usage:\n` +
          `  npm run reconcile:orphans                # default ratio 0.5\n` +
          `  npm run reconcile:orphans -- --ratio N   # 0 < N <= 1\n` +
          `  npm run reconcile:orphans -- --json      # machine-readable output\n`,
      );
      process.exit(0);
    }
  }
  return { ratio, json };
}

async function main(): Promise<void> {
  const { ratio, json } = parseArgs();
  const { count, orphans } = await reconcileOrphans({ staleThresholdRatio: ratio });
  if (json) {
    console.log(JSON.stringify({ count, orphans }, null, 2));
    process.exit(count > 0 ? 1 : 0);
    return;
  }
  if (count === 0) {
    console.log(`[reconcile-orphans] OK — no stale claims (ratio=${ratio})`);
    process.exit(0);
  }
  console.log(
    `[reconcile-orphans] WARN — ${count} stale claim(s) (held > ${(ratio * 100).toFixed(0)}% of expected TTL):\n`,
  );
  for (const o of orphans) {
    console.log(`  ${o.kind.padEnd(20)} ${o.key}`);
    console.log(`    fence:    ${o.fence}`);
    console.log(`    ttlSec:   ${o.ttlSec}`);
  }
  console.log(
    `\nNext step: cross-check each key against on-chain state before any manual\n` +
      `release. The reconciler does NOT release claims unilaterally — see the\n` +
      `module docstring at src/lib/orphanReconciler.ts.\n`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error('[reconcile-orphans] fatal:', err);
  process.exit(2);
});
