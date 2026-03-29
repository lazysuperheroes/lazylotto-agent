/**
 * HOL Registry integration — registers the agent as an HCS-11 profile
 * so other HOL-connected agents can discover it.
 *
 * State persisted in .agent-config.json alongside .env.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// CJS interop — standards-sdk types don't resolve cleanly under Node16 ESM
const esmRequire = createRequire(import.meta.url);
const {
  AgentBuilder,
  HCS11Client,
  RegistryBrokerClient,
  AIAgentCapability,
  InboundTopicType,
} = esmRequire('@hashgraphonline/standards-sdk') as {
  AgentBuilder: any;
  HCS11Client: any;
  RegistryBrokerClient: any;
  AIAgentCapability: Record<string, number>;
  InboundTopicType: Record<string, string>;
};

// ── Config persistence ────────────────────────────────────────

export interface AgentConfig {
  profileTopicId: string | null;
  uaid: string | null;
  inboundTopicId: string | null;
  outboundTopicId: string | null;
  registeredAt: string | null;
  updatedAt: string | null;
  network: string;
  accountId: string;
}

const CONFIG_FILE = '.agent-config.json';

function configPath(): string {
  return resolve(process.cwd(), CONFIG_FILE);
}

export function loadAgentConfig(): AgentConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AgentConfig;
  } catch {
    return null;
  }
}

function saveAgentConfig(config: AgentConfig): void {
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

// ── Profile builder ───────────────────────────────────────────

function buildAgentProfile(network: string) {
  const builder = new AgentBuilder();
  const isMultiUser = process.env.MULTI_USER_ENABLED === 'true';

  const capabilities = [
    AIAgentCapability.TRANSACTION_ANALYTICS,
    AIAgentCapability.WORKFLOW_AUTOMATION,
    AIAgentCapability.MARKET_INTELLIGENCE,
  ];

  if (isMultiUser) {
    capabilities.push(AIAgentCapability.MULTI_AGENT_COORDINATION);
  }

  const bio = isMultiUser
    ? 'Multi-user custodial agent that plays LazyLotto on Hedera on behalf of multiple users. ' +
      'Accepts deposits via memo-tagged transfers, plays with configurable strategies, ' +
      'routes prizes to user EOAs, and provides full on-chain HCS-20 accounting. ' +
      'Negotiable rake fee. Shared NFT boost benefits all users.'
    : 'Autonomous agent that plays LazyLotto on Hedera. Evaluates pools by expected value, ' +
      'buys entries, rolls for prizes, and transfers winnings to the owner wallet. ' +
      'Configurable strategy with budget controls and win rate boost via NFT delegation.';

  builder
    .setName('LazyLotto Player Agent')
    .setAlias('lazylotto-player')
    .setBio(bio)
    .setType('autonomous')
    .setCapabilities(capabilities)
    .setModel('claude-opus-4')
    .setCreator('Lazy Superheroes')
    .addSocial('website', 'https://lazylotto.app')
    .addSocial('twitter', '@LazySuperhero')
    .addProperty('game', 'LazyLotto')
    .addProperty('chain', 'hedera')
    .addProperty('protocol', 'HCS-10')
    .setNetwork(network);

  if (isMultiUser) {
    builder.setInboundTopicType(InboundTopicType.FEE_BASED);
    builder.addProperty('multiUser', true);
    builder.addProperty('rakePercent', Number(process.env.RAKE_DEFAULT_PERCENT ?? 1));
  } else {
    builder.setInboundTopicType(InboundTopicType.PUBLIC);
  }

  // Use existing account (the agent's wallet)
  const accountId = process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_PRIVATE_KEY;
  if (accountId && privateKey) {
    builder.setExistingAccount(accountId, privateKey);
  }

  return builder.build();
}

// ── Registration flow ─────────────────────────────────────────

export async function ensureRegistered(opts?: {
  forceUpdate?: boolean;
  silent?: boolean;
}): Promise<AgentConfig> {
  const { forceUpdate = false, silent = false } = opts ?? {};
  const log = silent ? (..._args: unknown[]) => {} : console.log;
  const network = process.env.HEDERA_NETWORK ?? 'testnet';
  const accountId = process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_PRIVATE_KEY;

  if (!accountId || !privateKey) {
    throw new Error(
      'HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY required for HOL registration'
    );
  }

  // Check existing config
  const existing = loadAgentConfig();
  if (
    existing?.uaid &&
    existing.network === network &&
    existing.accountId === accountId &&
    !forceUpdate
  ) {
    log(`HOL: Already registered (UAID: ${existing.uaid})`);
    return existing;
  }

  // Initialize HCS-11 client
  const hcs11 = new HCS11Client({
    network,
    auth: { operatorId: accountId, privateKey },
  });

  // Build profile
  const profile = buildAgentProfile(network);

  // If we have an existing registration but need to update
  if (existing?.uaid && forceUpdate) {
    log('HOL: Updating agent profile...');
    return await updateRegistration(hcs11, existing, profile, network, accountId, log);
  }

  // New registration
  log('HOL: Registering agent with HOL registry...');
  return await newRegistration(hcs11, profile, network, accountId, log);
}

async function newRegistration(
  hcs11: InstanceType<typeof HCS11Client>,
  profile: ReturnType<typeof buildAgentProfile>,
  network: string,
  accountId: string,
  log: (...args: unknown[]) => void
): Promise<AgentConfig> {
  // Step 1: Inscribe profile to Hedera (creates HCS topic)
  log('  Inscribing HCS-11 profile...');
  const inscribed = await (hcs11 as any).createAndInscribeProfile(profile, true);

  if (!inscribed.success) {
    throw new Error(`Profile inscription failed: ${inscribed.error}`);
  }

  log(`  Profile topic: ${inscribed.profileTopicId}`);
  if (inscribed.totalCostHbar) {
    log(`  Inscription cost: ${inscribed.totalCostHbar} HBAR`);
  }

  // Step 2: Register with Registry Broker
  const apiKey = process.env.HOL_API_KEY;
  const brokerClient = new RegistryBrokerClient({
    ...(apiKey ? { apiKey } : {}),
    accountId,
  });

  const profileJson = (hcs11 as any).profileToJSONString(profile);

  log('  Registering with HOL registry broker...');

  const registration = await brokerClient.registerAgent({
    profile: JSON.parse(profileJson),
    metadata: {
      category: 'gaming',
      provider: 'lazy-superheroes',
      openConvAICompatible: true,
      customFields: {
        game: 'lazylotto',
        chain: 'hedera',
      },
    },
  });

  let uaid: string;
  if (registration.status === 'success') {
    uaid = registration.uaid;
  } else if (registration.status === 'pending') {
    log('  Waiting for registration confirmation...');
    const completed = await brokerClient.waitForRegistrationCompletion(
      registration.attemptId,
      {
        timeoutMs: 60_000,
        onProgress: (p: any) => log(`  Progress: ${p.status}`),
      }
    );
    uaid = completed.uaid;
  } else {
    // partial
    uaid = registration.uaid;
  }

  log(`  Registered! UAID: ${uaid}`);

  const config: AgentConfig = {
    profileTopicId: inscribed.profileTopicId,
    uaid,
    inboundTopicId: inscribed.inboundTopicId ?? null,
    outboundTopicId: inscribed.outboundTopicId ?? null,
    registeredAt: new Date().toISOString(),
    updatedAt: null,
    network,
    accountId,
  };

  saveAgentConfig(config);
  log(`  Saved to ${CONFIG_FILE}`);

  return config;
}

async function updateRegistration(
  hcs11: InstanceType<typeof HCS11Client>,
  existing: AgentConfig,
  profile: ReturnType<typeof buildAgentProfile>,
  network: string,
  accountId: string,
  log: (...args: unknown[]) => void
): Promise<AgentConfig> {
  const apiKey = process.env.HOL_API_KEY;
  const brokerClient = new RegistryBrokerClient({
    ...(apiKey ? { apiKey } : {}),
    accountId,
  });

  const profileJson = (hcs11 as any).profileToJSONString(profile);

  await brokerClient.updateAgent(existing.uaid!, {
    profile: JSON.parse(profileJson),
    metadata: {
      category: 'gaming',
      provider: 'lazy-superheroes',
      openConvAICompatible: true,
    },
  });

  log(`  Profile updated (UAID: ${existing.uaid})`);

  const config: AgentConfig = {
    ...existing,
    updatedAt: new Date().toISOString(),
    network,
    accountId,
  };

  saveAgentConfig(config);
  return config;
}

// ── Lookup ────────────────────────────────────────────────────

export async function resolveAgent(uaid: string): Promise<unknown> {
  const brokerClient = new RegistryBrokerClient({
    apiKey: process.env.HOL_API_KEY,
  });
  return brokerClient.resolveUaid(uaid);
}
