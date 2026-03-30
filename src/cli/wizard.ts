/**
 * Interactive CLI setup wizard.
 * Walks the user through creating a .env file, validates inputs,
 * and optionally runs --setup + --audit.
 *
 * Works standalone — no Claude, no MCP, no existing config needed.
 *
 * Usage: lazylotto-agent --wizard
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helpers ───────────────────────────────────────────────────

function isValidAccountId(value: string): boolean {
  return /^0\.0\.\d+$/.test(value);
}

function isValidPrivateKey(value: string): boolean {
  return /^(302[0-9a-fA-F]{2}|0x[0-9a-fA-F]+)/.test(value) && value.length >= 20;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// ── Wizard ────────────────────────────────────────────────────

export async function runWizard(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  const ask = async (
    prompt: string,
    opts: { default?: string; validate?: (v: string) => boolean; secret?: boolean } = {}
  ): Promise<string> => {
    const suffix = opts.default ? ` [${opts.default}]` : '';
    while (true) {
      const answer = (await rl.question(`  ${prompt}${suffix}: `)).trim();
      const value = answer || opts.default || '';
      if (!value && !opts.default) {
        console.log('    Required. Please enter a value.');
        continue;
      }
      if (opts.validate && !opts.validate(value)) {
        console.log('    Invalid format. Please try again.');
        continue;
      }
      return value;
    }
  };

  console.log('\n================================================');
  console.log('  LazyLotto Agent — Setup Wizard');
  console.log('================================================\n');

  console.log('This wizard creates a .env file for the agent.');
  console.log('You will need a dedicated Hedera account with');
  console.log('its private key (DER hex format).\n');

  // Check for existing .env
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    const overwrite = await ask('A .env file already exists. Overwrite? (y/n)', { default: 'n' });
    if (overwrite.toLowerCase() !== 'y') {
      console.log('\nWizard cancelled. Existing .env unchanged.');
      rl.close();
      return;
    }
  }

  // ── Step 1: Network ─────────────────────────────────────────

  console.log('\n--- Step 1: Network ---\n');
  console.log('  Choose testnet for testing or mainnet for real play.');
  console.log('  WARNING: mainnet uses real funds.\n');

  let network = await ask('Network (testnet/mainnet)', {
    default: 'testnet',
    validate: (v) => v === 'testnet' || v === 'mainnet',
  });

  if (network === 'mainnet') {
    console.log('\n  !! MAINNET SELECTED !!');
    console.log('  Make sure you are using a DEDICATED wallet');
    console.log('  with LIMITED funding. Never use your treasury.\n');
    const confirm = await ask('Confirm mainnet? (yes/no)', { default: 'no' });
    if (confirm !== 'yes') {
      network = 'testnet';
      console.log('  Switched to testnet.');
    }
  }

  // ── Step 2: Agent Wallet ────────────────────────────────────

  console.log('\n--- Step 2: Agent Wallet ---\n');
  console.log('  The agent needs its own Hedera account.');
  console.log('  This should be a DEDICATED account, NOT your main wallet.');
  console.log('  Fund it with just enough HBAR and LAZY for a few sessions.\n');

  const accountId = await ask('Agent Account ID (e.g., 0.0.12345)', {
    validate: isValidAccountId,
  });

  console.log('\n  NOTE: The key will be visible as you type.');
  console.log('  Alternatively, edit .env manually after the wizard completes.\n');
  const privateKey = await ask('Agent Private Key (DER hex, starts with 302e)', {
    validate: isValidPrivateKey,
  });

  // ── Step 3: Owner Wallet ────────────────────────────────────

  console.log('\n--- Step 3: Owner Wallet ---\n');
  console.log('  YOUR wallet where prizes are transferred.');
  console.log('  The agent never needs this wallet\'s private key.');
  console.log('  You claim prizes from the LazyLotto dApp.\n');

  const ownerEoa = await ask('Owner Account ID (e.g., 0.0.67890)', {
    validate: isValidAccountId,
  });

  // ── Step 4: MCP Endpoint ────────────────────────────────────

  console.log('\n--- Step 4: LazyLotto MCP Endpoint ---\n');

  const mcpUrl = await ask('MCP URL', {
    default: 'https://lazylotto.app/api/mcp',
    validate: isValidUrl,
  });

  const mcpApiKey = await ask('MCP API Key (optional, press Enter to skip)', {
    default: '',
  });

  // ── Step 5: Strategy ────────────────────────────────────────

  console.log('\n--- Step 5: Strategy ---\n');
  console.log('  conservative — Low risk, high win rate pools, small bets');
  console.log('  balanced     — Moderate risk and budget (recommended)');
  console.log('  aggressive   — Higher risk, bigger bets, more entries\n');

  const strategy = await ask('Strategy', {
    default: 'balanced',
    validate: (v) => ['conservative', 'balanced', 'aggressive'].includes(v),
  });

  // ── Step 6: Contract Addresses ──────────────────────────────

  console.log('\n--- Step 6: Contract Addresses ---\n');
  const isTestnet = network === 'testnet';
  if (isTestnet) {
    console.log('  Defaults are testnet addresses.\n');
  } else {
    console.log('  MAINNET: No defaults — you must provide the correct addresses.\n');
  }

  const lazylottoContract = await ask('LazyLotto Contract ID', {
    default: isTestnet ? '0.0.8399255' : undefined,
    validate: isValidAccountId,
  });
  const gasStationId = await ask('GasStation Contract ID', {
    default: isTestnet ? '0.0.8011801' : undefined,
    validate: isValidAccountId,
  });
  const lazyTokenId = await ask('LAZY Token ID', {
    default: isTestnet ? '0.0.8011209' : undefined,
    validate: isValidAccountId,
  });
  const storageId = await ask('Storage Contract ID (optional)', {
    default: '',
  });

  // ── Step 7: Delegation (optional) ───────────────────────────

  console.log('\n--- Step 7: Delegation (optional) ---\n');
  console.log('  If you have LSH NFTs delegated to this agent,');
  console.log('  provide the registry address for --audit checks.\n');

  const delegateRegistryId = await ask('Delegate Registry ID (optional)', { default: '' });
  const lshTokenId = await ask('LSH Token ID (optional)', { default: '' });

  // ── Write .env ──────────────────────────────────────────────

  const lines = [
    '# Generated by lazylotto-agent --wizard',
    `# ${new Date().toISOString()}`,
    '',
    '# Hedera Network',
    `HEDERA_NETWORK=${network}`,
    `HEDERA_ACCOUNT_ID=${accountId}`,
    `HEDERA_PRIVATE_KEY=${privateKey}`,
    '',
    '# LazyLotto MCP Endpoint',
    `LAZYLOTTO_MCP_URL=${mcpUrl}`,
    `LAZYLOTTO_MCP_API_KEY=${mcpApiKey}`,
    '',
    '# LazyLotto Contract Addresses',
    `LAZYLOTTO_CONTRACT_ID=${lazylottoContract}`,
    `LAZYLOTTO_STORAGE_ID=${storageId}`,
    `LAZY_GAS_STATION_ID=${gasStationId}`,
    `LAZY_TOKEN_ID=${lazyTokenId}`,
    '',
    '# Owner wallet — receives prizes and withdrawals',
    `OWNER_EOA=${ownerEoa}`,
    '',
    '# Strategy',
    `STRATEGY=${strategy}`,
    '',
    '# Delegate Registry (optional)',
    `DELEGATE_REGISTRY_ID=${delegateRegistryId}`,
    `LSH_TOKEN_ID=${lshTokenId}`,
    '',
    '# HOL Registry (optional)',
    'HOL_API_KEY=',
    '',
  ];

  writeFileSync(envPath, lines.join('\n'), 'utf-8');

  console.log('\n================================================');
  console.log(`  .env written to: ${envPath}`);
  console.log('================================================\n');

  // ── Summary ─────────────────────────────────────────────────

  console.log('  Configuration Summary:');
  console.log(`    Network:   ${network}`);
  console.log(`    Agent:     ${accountId}`);
  console.log(`    Owner:     ${ownerEoa}`);
  console.log(`    Strategy:  ${strategy}`);
  console.log(`    MCP URL:   ${mcpUrl}`);
  console.log(`    Contract:  ${lazylottoContract}`);
  if (delegateRegistryId) {
    console.log(`    Delegate:  ${delegateRegistryId}`);
  }

  // ── Next steps ──────────────────────────────────────────────

  console.log('\n  Next steps:');
  console.log('    1. Fund the agent wallet with HBAR and LAZY');
  console.log('    2. Run: lazylotto-agent --setup');
  console.log('       (associates tokens, sets approvals)');
  console.log('    3. Run: lazylotto-agent --audit');
  console.log('       (verify everything is configured correctly)');
  console.log('    4. Run: lazylotto-agent');
  console.log('       (play a session!)\n');

  const runSetup = await ask('Run --setup now? (y/n)', { default: 'y' });

  rl.close();

  if (runSetup.toLowerCase() === 'y') {
    console.log('\nLoading .env and running setup...\n');
    // Dynamic import to pick up the freshly-written .env
    const dotenv = await import('dotenv');
    dotenv.config({ path: envPath, override: true });

    const { LottoAgent } = await import('../agent/LottoAgent.js');
    const { StrategySchema } = await import('../config/strategy.js');
    const { DEFAULT_STRATEGY } = await import('../config/defaults.js');

    let strat;
    try {
      const stratPath = resolve(__dirname, '..', '..', 'strategies', `${strategy}.json`);
      const raw = JSON.parse(readFileSync(stratPath, 'utf-8'));
      strat = StrategySchema.parse(raw);
    } catch {
      strat = DEFAULT_STRATEGY;
    }

    const agent = new LottoAgent(strat);
    try {
      await agent.setup();
      console.log('\nSetup complete! Run --audit to verify configuration.');
    } catch (e) {
      console.error('\nSetup failed:', e instanceof Error ? e.message : e);
      console.log('Check your .env values and try again with: lazylotto-agent --setup');
    }
  }
}
