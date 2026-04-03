import 'dotenv/config';
import type { Strategy } from './config/strategy.js';
import { initTokenRegistry } from './utils/math.js';

// Initialize token registry from env (LAZY_TOKEN_ID → 1 decimal)
initTokenRegistry();
import { DEFAULT_STRATEGY } from './config/defaults.js';
import { loadStrategy } from './config/loader.js';
import { LottoAgent } from './agent/LottoAgent.js';
import { startMcpServer } from './mcp/server.js';
import cron from 'node-cron';

/** Wait for Enter then force-exit. Used by one-shot commands on Windows
 *  where open gRPC/MCP connections prevent clean process exit. */
async function exitGracefully(): Promise<never> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('\nPress Enter to exit...');
  rl.close();
  process.exit(0);
}

function printHelp(): void {
  console.log(`
lazylotto-agent — Autonomous LazyLotto lottery player on Hedera

Usage:
  lazylotto-agent [options]

Options:
  --version, -v         Show version number
  --help                Show this help message
  --wizard              Interactive setup wizard (creates .env)
  --setup               First-time wallet setup (associations, approvals)
  --register [--force]  Register/update agent with HOL registry
  --status              Check wallet balances and state
  --audit               Comprehensive configuration audit
  --mcp-server          Start MCP server (stdio for Claude Desktop)
  --http                Use HTTP transport instead of stdio
  --port N              HTTP port (default 3001)
  --dry-run             Show what would be played without executing
  --export-history      Export play history to CSV file
  --scheduled           Run play sessions on cron schedule
  --multi-user          Start multi-user custodial agent
    --deploy-accounting   Deploy HCS-20 accounting topic
    --mcp-server          MCP server with multi-user tools

With no options, runs a single play session.

Environment:
  HEDERA_NETWORK        testnet or mainnet
  HEDERA_ACCOUNT_ID     Agent's Hedera account
  HEDERA_PRIVATE_KEY    Agent's private key (DER hex)
  STRATEGY              balanced (default), conservative, aggressive, or file path
  OWNER_EOA             Owner wallet for prize transfers

See README.md for full documentation.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  if (args.includes('--version') || args.includes('-v')) {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version: string };
    console.log(`lazylotto-agent v${pkg.version}`);
    return;
  }

  const strategyName = process.env.STRATEGY ?? 'balanced';

  let strategy: Strategy;
  try {
    strategy = loadStrategy(strategyName);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`\n  ERROR: Strategy "${strategyName}" failed to load: ${detail}`);

    // For play modes (default, scheduled, multi-user), refuse to proceed with defaults
    // to prevent accidentally spending real money with an unintended strategy.
    const playMode = !args.length || args.includes('--scheduled') || args.includes('--multi-user');
    if (playMode && !args.includes('--force')) {
      console.error('  Fix the strategy error above, or use --force to proceed with defaults.\n');
      process.exit(1);
    }

    console.error('  Falling back to default strategy (HBAR-only budget).\n');
    strategy = DEFAULT_STRATEGY;
  }

  if (args.includes('--wizard')) {
    const { runWizard } = await import('./cli/wizard.js');
    await runWizard();
    return;
  }

  // Mainnet safety check — warn before spending real money
  if (process.env.HEDERA_NETWORK === 'mainnet') {
    const playModes = !args.length || args.includes('--scheduled') || args.includes('--multi-user');
    if (playModes && !args.includes('--mcp-server')) {
      console.log('\n  *** WARNING: Running on MAINNET with real funds ***');
      console.log('  Ensure agent wallet has limited funding.\n');
    }
  }

  // Validate credentials before constructing agent
  if (!process.env.HEDERA_ACCOUNT_ID || !process.env.HEDERA_PRIVATE_KEY) {
    const { existsSync } = await import('node:fs');
    const envExists = existsSync('.env');
    console.error('\n  ERROR: Missing HEDERA_ACCOUNT_ID or HEDERA_PRIVATE_KEY.');
    if (!envExists) {
      console.error('  No .env file found. Run: lazylotto-agent --wizard\n');
    } else {
      console.error('  Check your .env file for missing or empty values.\n');
    }
    process.exit(1);
  }

  // Validate OWNER_EOA format before constructing agent (catches bad addresses early)
  const ownerEoa = process.env.OWNER_EOA;
  if (ownerEoa && !/^(0\.0\.\d+|0x[0-9a-fA-F]{40})$/.test(ownerEoa)) {
    console.error(`\n  ERROR: OWNER_EOA "${ownerEoa}" is not a valid Hedera account ID (0.0.X) or EVM address (0x...).`);
    console.error('  Fix OWNER_EOA in your .env file.\n');
    process.exit(1);
  }

  const agent = new LottoAgent(strategy);

  if (args.includes('--register')) {
    const { ensureRegistered } = await import('./hol/registry.js');
    await ensureRegistered({ forceUpdate: args.includes('--force') });
    await exitGracefully();
  }

  if (args.includes('--setup')) {
    await agent.setup();
    await exitGracefully();
  }

  if (args.includes('--status')) {
    await agent.status();
    await exitGracefully();
  }

  if (args.includes('--audit')) {
    const { AuditReport } = await import('./agent/AuditReport.js');
    const audit = new AuditReport(agent.getClient(), strategy);
    const result = await audit.generate();
    audit.print(result);
    await exitGracefully();
  }

  // In MCP stdio mode, stdout is the JSON-RPC transport — redirect all
  // console.log to stderr BEFORE any subsystem starts writing output.
  if (args.includes('--mcp-server')) {
    console.log = console.error;
  }

  if (args.includes('--multi-user')) {
    // Validate multi-user prerequisites
    if (!process.env.OPERATOR_WITHDRAW_ADDRESS) {
      console.warn(
        '[MultiUser] WARNING: OPERATOR_WITHDRAW_ADDRESS not set. ' +
          'Any address can be used for operator fee withdrawals. ' +
          'Set this in .env for production deployments.'
      );
    }

    const { MultiUserAgent } = await import('./custodial/MultiUserAgent.js');
    const { loadCustodialConfig } = await import('./custodial/types.js');
    const config = loadCustodialConfig();
    const multiAgent = new MultiUserAgent(config);
    await multiAgent.initialize();

    if (args.includes('--deploy-accounting')) {
      const topicId = await multiAgent.deployAccounting();
      console.log(`HCS-20 deployed. Topic: ${topicId}`);
      console.log(`Add to .env: HCS20_TOPIC_ID=${topicId}`);
      await exitGracefully();
    }

    // Start the deposit watcher and agent loop regardless of MCP mode
    multiAgent.start();

    if (args.includes('--mcp-server')) {
      const httpMode = args.includes('--http');
      const portIdx = args.indexOf('--port');
      const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 3001;
      await startMcpServer(agent, multiAgent, httpMode ? { http: true, port } : undefined);
      return;
    }

    const cronExpr = strategy.schedule.cron;
    cron.schedule(cronExpr, async () => {
      try {
        const results = await multiAgent.playForAllEligible();
        console.log(`Played for ${results.length} user(s)`);
      } catch (e) {
        console.error('Scheduled play cycle failed:', e);
      }
    });

    console.log('Multi-user agent running. Ctrl+C to stop.');

    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      await multiAgent.stop();
      process.exit(0);
    });

    return;
  }

  if (args.includes('--mcp-server')) {
    const httpMode = args.includes('--http');
    const portIdx = args.indexOf('--port');
    const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 3001;
    await startMcpServer(agent, undefined, httpMode ? { http: true, port } : undefined);
    return;
  }

  if (args.includes('--scheduled')) {
    if (!strategy.schedule.enabled) {
      console.log('Note: schedule.enabled is false in strategy, but --scheduled flag overrides.');
    }
    const cronExpr = strategy.schedule.cron;
    console.log(`Scheduling play sessions: ${cronExpr}`);
    let sessionsToday = 0;
    const maxSessions = strategy.schedule.maxSessionsPerDay;

    cron.schedule(cronExpr, async () => {
      if (sessionsToday >= maxSessions) {
        console.log(`Max sessions (${maxSessions}) reached for today. Skipping.`);
        return;
      }
      sessionsToday++;
      console.log(`\n--- Scheduled session #${sessionsToday} ---`);
      try {
        await agent.play();
      } catch (e) {
        console.error('Session failed:', e);
      }
    });

    cron.schedule('0 0 * * *', () => {
      sessionsToday = 0;
    });

    console.log('Agent running. Press Ctrl+C to stop.');

    let shuttingDown = false;
    process.on('SIGINT', async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\nStopping... (waiting for any active session to complete)');
      // Wait for active session to finish (simple poll)
      const start = Date.now();
      while (agent.isPlaying() && Date.now() - start < 300_000) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      process.exit(0);
    });

    return;
  }

  if (args.includes('--export-history')) {
    const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
    // Check both multi-user and single-user history paths
    const multiPath = '.custodial-data/plays.json';
    const singlePath = '.session-history/sessions.json';
    let playsPath = '';
    if (existsSync(multiPath)) playsPath = multiPath;
    else if (existsSync(singlePath)) playsPath = singlePath;
    if (!playsPath) {
      console.log('No play history found. Play a session first.');
      await exitGracefully();
    }
    const raw = JSON.parse(readFileSync(playsPath, 'utf-8'));
    const plays = (Array.isArray(raw) ? raw : raw.sessions ?? []) as Array<Record<string, unknown>>;
    if (plays.length === 0) {
      console.log('Play history is empty.');
      await exitGracefully();
    }
    const headers = Object.keys(plays[0]);
    const csv = [
      headers.join(','),
      ...plays.map((p) =>
        headers.map((h) => {
          const val = p[h];
          if (typeof val === 'object') return JSON.stringify(val).replace(/,/g, ';');
          return String(val ?? '');
        }).join(',')
      ),
    ].join('\n');
    const outPath = `play-history-${Date.now()}.csv`;
    writeFileSync(outPath, csv, 'utf-8');
    console.log(`Exported ${plays.length} session(s) to ${outPath}`);
    await exitGracefully();
  }

  if (args.includes('--dry-run')) {
    console.log('\n[DRY RUN] Showing what would be played without executing transactions.\n');
    // Run discover + evaluate only, then print results
    const { listPools, calculateEv, closeMcpClient } = await import('./mcp/client.js');
    const { StrategyEngine } = await import('./agent/StrategyEngine.js');
    const engine = new StrategyEngine(strategy);

    try {
      const allPools = await listPools(strategy.poolFilter.type);
      const filtered = engine.filterPools(allPools);
      console.log(`Found ${allPools.length} pools, ${filtered.length} match strategy filters.\n`);

      const accountId = process.env.HEDERA_ACCOUNT_ID!;
      const evResults: Awaited<ReturnType<typeof calculateEv>>[] = [];
      for (const pool of filtered.slice(0, 10)) {
        try {
          const ev = await calculateEv(pool.poolId, accountId);
          evResults.push(ev);
          console.log(
            `  Pool #${pool.poolId} (${pool.name}): ` +
            `EV=${ev.expectedValue.toFixed(2)}, ` +
            `winRate=${(ev.effectiveWinRate * 100).toFixed(1)}%, ` +
            `fee=${pool.entryFee} ${pool.feeTokenSymbol}`
          );
        } catch {
          console.log(`  Pool #${pool.poolId} (${pool.name}): EV calc failed`);
        }
      }

      const scored = engine.scorePools(filtered, evResults);
      console.log(`\n${scored.length} pool(s) would be played (above EV threshold).`);
      console.log('No transactions executed.\n');
    } finally {
      try { await closeMcpClient(); } catch { /* */ }
    }
    await exitGracefully();
  }

  // Default: single play session
  await agent.play();
  await exitGracefully();
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
