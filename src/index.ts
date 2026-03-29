import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StrategySchema, type Strategy } from './config/strategy.js';
import { DEFAULT_STRATEGY } from './config/defaults.js';
import { LottoAgent } from './agent/LottoAgent.js';
import { startMcpServer } from './mcp/server.js';
import cron from 'node-cron';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadStrategy(name: string): Strategy {
  const builtIn = ['conservative', 'balanced', 'aggressive'];

  if (builtIn.includes(name)) {
    const path = resolve(__dirname, '..', 'strategies', `${name}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return StrategySchema.parse(raw);
  }

  // Treat as file path (resolve from cwd for user-provided paths)
  const raw = JSON.parse(readFileSync(resolve(name), 'utf-8'));
  return StrategySchema.parse(raw);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const strategyName = process.env.STRATEGY ?? 'balanced';

  let strategy: Strategy;
  try {
    strategy = loadStrategy(strategyName);
  } catch {
    console.log(`Strategy "${strategyName}" not found or invalid, using defaults.`);
    strategy = DEFAULT_STRATEGY;
  }

  if (args.includes('--wizard')) {
    const { runWizard } = await import('./cli/wizard.js');
    await runWizard();
    return;
  }

  const agent = new LottoAgent(strategy);

  if (args.includes('--register')) {
    const { ensureRegistered } = await import('./hol/registry.js');
    await ensureRegistered({ forceUpdate: args.includes('--force') });
    return;
  }

  if (args.includes('--setup')) {
    await agent.setup();
    return;
  }

  if (args.includes('--status')) {
    await agent.status();
    return;
  }

  if (args.includes('--audit')) {
    const { AuditReport } = await import('./agent/AuditReport.js');
    const audit = new AuditReport(agent.getClient(), strategy);
    const result = await audit.generate();
    audit.print(result);
    return;
  }

  if (args.includes('--multi-user')) {
    const { MultiUserAgent } = await import('./custodial/MultiUserAgent.js');
    const { loadCustodialConfig } = await import('./custodial/types.js');
    const config = loadCustodialConfig();
    const multiAgent = new MultiUserAgent(config);
    await multiAgent.initialize();

    if (args.includes('--deploy-accounting')) {
      const topicId = await multiAgent.deployAccounting();
      console.log(`HCS-20 deployed. Topic: ${topicId}`);
      console.log(`Add to .env: HCS20_TOPIC_ID=${topicId}`);
      return;
    }

    if (args.includes('--mcp-server')) {
      await startMcpServer(agent, multiAgent);
      return;
    }

    // Start custodial agent with deposit watching + scheduled plays
    multiAgent.start();

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
    await startMcpServer(agent);
    return;
  }

  if (args.includes('--scheduled')) {
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

    // Reset daily counter at midnight
    cron.schedule('0 0 * * *', () => {
      sessionsToday = 0;
    });

    console.log('Agent running. Press Ctrl+C to stop.');
    return;
  }

  // Default: single play session
  await agent.play();
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
