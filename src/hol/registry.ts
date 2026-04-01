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

function buildAgentProfile(hcs11: any) {
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
      'routes prizes to user EOAs, and provides full on-chain HCS-20 accounting.'
    : 'Autonomous agent that plays LazyLotto on Hedera. Evaluates pools by expected value, ' +
      'buys entries, rolls for prizes, and transfers winnings to the owner wallet.';

  // Use createAIAgentProfile which produces the correct HCS-11 schema
  // (AgentBuilder.build() produces a flat structure that fails validation)
  return hcs11.createAIAgentProfile(
    'LazyLotto Player Agent',   // display_name
    1,                           // AIAgentType.AUTONOMOUS
    capabilities,
    'rule-based/ev-scoring',     // autonomous EV engine, optionally controlled by LLM via MCP
    {
      alias: 'lazylotto-player',
      bio,
      creator: 'Lazy Superheroes',
      socials: [{ platform: 'website', handle: 'https://lazylotto.app' }],
      properties: {
        game: 'LazyLotto',
        chain: 'hedera',
      },
    }
  );
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

  // Build profile using HCS11Client's createAIAgentProfile (produces valid HCS-11 schema)
  const profile = buildAgentProfile(hcs11);

  // If profile already inscribed but broker registration failed, skip inscription
  if (existing?.profileTopicId && !existing?.uaid && existing.network === network) {
    log(`HOL: Profile already inscribed (${existing.profileTopicId}). Retrying broker registration...`);
    return await registerWithBroker(hcs11, profile, existing, network, accountId, log);
  }

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

  if (!inscribed?.success) {
    const detail = inscribed?.error ?? JSON.stringify(inscribed);
    throw new Error(`Profile inscription failed: ${detail}`);
  }

  log(`  Profile topic: ${inscribed.profileTopicId}`);
  if (inscribed.totalCostHbar) {
    log(`  Inscription cost: ${inscribed.totalCostHbar} HBAR`);
  }

  // Save partial config immediately so we don't re-inscribe on retry
  const partialConfig: AgentConfig = {
    profileTopicId: inscribed.profileTopicId,
    uaid: null,
    inboundTopicId: inscribed.inboundTopicId ?? null,
    outboundTopicId: inscribed.outboundTopicId ?? null,
    registeredAt: new Date().toISOString(),
    updatedAt: null,
    network,
    accountId,
  };
  saveAgentConfig(partialConfig);
  log(`  Saved partial config (profile inscribed, broker pending)`);

  // Step 2: Register with broker (reuses the partial config)
  return await registerWithBroker(hcs11, profile, partialConfig, network, accountId, log);
}

async function registerWithBroker(
  hcs11: InstanceType<typeof HCS11Client>,
  profile: any,
  partialConfig: AgentConfig,
  network: string,
  accountId: string,
  log: (...args: unknown[]) => void
): Promise<AgentConfig> {
  const apiKey = process.env.HOL_API_KEY ?? process.env.REGISTRY_BROKER_API_KEY;
  if (!apiKey) {
    log('  WARNING: No API key set. Broker registration requires authentication.');
    log('  Run: npx @hol-org/registry claim');
    log('  Then set HOL_API_KEY=rbk_... in .env and re-run --register');
    return partialConfig;
  }

  const brokerClient = new RegistryBrokerClient({
    apiKey,
    accountId,
  });

  const profileJson = (hcs11 as any).profileToJSONString(profile);

  log('  Registering with HOL registry broker...');

  let uaid: string;
  try {
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
      uaid = (registration as any).uaid;
    }
  } catch (e: any) {
    // The SDK's Zod schema may not handle all broker response shapes (e.g., 'pending' status).
    // Extract the UAID from the raw response if available.
    const raw = e?.rawValue;
    if (raw?.success && raw?.uaid) {
      log(`  Broker returned non-standard response (${raw.status}), but registration succeeded.`);
      uaid = raw.uaid;
    } else {
      throw e;
    }
  }

  log(`  Registered! UAID: ${uaid}`);

  const config: AgentConfig = {
    ...partialConfig,
    uaid,
    registeredAt: new Date().toISOString(),
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

