/**
 * Agent Discovery Response Builder
 *
 * Public, read-only, cacheable endpoint data that tells connecting agents and
 * users everything they need to know about this LazyLotto Agent instance
 * BEFORE authenticating.  Think of it as the "agent handshake" -- analogous
 * to a well-known configuration endpoint (.well-known/openid-configuration).
 *
 * Used by:
 *   - Next.js API route  (app/api/discover/route.ts)
 *   - Self-hosted HTTP server  (src/mcp/server.ts /discover)
 */

import { loadFeatureConfig, isX402Active } from './config/features.js';

/**
 * x402 "agentic commerce" advertisement. Present ONLY when the x402 gate is
 * active (flag on + payTo configured). Tells a connecting agent it can pay
 * programmatically for a capability, which endpoint, the price, and the
 * accepted assets — everything needed to drive the 402 → pay → settle loop
 * without reading our docs first.
 */
export interface CommerceAdvertisement {
  protocol: 'x402';
  /** CAIP-2 network id (e.g. "hedera:testnet"). */
  network: string;
  /** Facilitator base URL (verify + settle). */
  facilitator: string;
  description: string;
  capabilities: Array<{
    id: string;
    endpoint: string;
    method: 'POST';
    description: string;
    price: { usd: string; assets: string[] };
    auth: string;
  }>;
}

export interface DiscoveryResponse {
  // Identity
  name: string;
  description: string;
  version: string;
  operator: string;
  uaid: string | null;

  // Network
  network: string;
  chain: string;

  // Endpoints
  endpoints: Record<string, string>;

  // Auth
  auth: {
    method: string;
    description: string;
    flow: string[];
    supportedKeyTypes: string[];
    sessionDuration: string;
    lockable: boolean;
  };

  // Fees
  fees: {
    rakePercent: { default: number; min: number; max: number };
    volumeTiers: { minDeposit: number; rakePercent: number }[];
    negotiable: boolean;
    description: string;
  };

  // Strategies
  strategies: {
    available: string[];
    default: string;
    description: string;
  };

  // Capabilities
  capabilities: Record<string, boolean>;

  // Agentic commerce (x402). Omitted when the gate is inactive.
  commerce?: CommerceAdvertisement;

  // Deposits
  deposits: {
    acceptedTokens: string[];
    minDeposit: number;
    maxBalance: number;
    description: string;
  };

  // Links
  links: Record<string, string>;
}

/**
 * Build the full discovery payload from environment variables and static
 * configuration.  Pure function -- no side-effects, safe to cache.
 *
 * @param baseUrl  The public base URL of this agent instance
 *                 (e.g. "https://testnet-agent.lazysuperheroes.com" or
 *                 "http://localhost:3001").
 */
export function buildDiscoveryResponse(baseUrl: string): DiscoveryResponse {
  const network = process.env.HEDERA_NETWORK ?? 'testnet';

  // Opt-in commerce/chat surfaces (default OFF). Pure env reads — CLI-safe.
  const features = loadFeatureConfig();
  const x402Active = isX402Active(features);
  const chatEnabled = features.chat.enabled;

  return {
    // ── Identity ──────────────────────────────────────────────
    name: 'LazyLotto Agent',
    description:
      'Multi-user custodial lottery agent on Hedera by Lazy Superheroes. ' +
      'Plays LazyLotto pools on behalf of users, manages deposits, and transfers prizes.',
    // NEXT_PUBLIC_APP_VERSION is injected from package.json by
    // next.config.mjs at build time. npm_package_version is the
    // CLI fallback (only set when launched via `npm run`).
    version:
      process.env.NEXT_PUBLIC_APP_VERSION ??
      process.env.npm_package_version ??
      '0.1.0',
    operator: 'Lazy Superheroes',
    uaid: process.env.UAID ?? null,

    // ── Network ───────────────────────────────────────────────
    network,
    chain: 'hedera',

    // ── Endpoints ─────────────────────────────────────────────
    endpoints: {
      auth: `${baseUrl}/auth`,
      challenge: `${baseUrl}/api/auth/challenge`,
      verify: `${baseUrl}/api/auth/verify`,
      mcp: `${baseUrl}/api/mcp`,
      a2a: `${baseUrl}/api/a2a`,
      agentCard: `${baseUrl}/.well-known/agent-card.json`,
      dashboard: `${baseUrl}/dashboard`,
      health: `${baseUrl}/api/health`,
      discover: `${baseUrl}/api/discover`,
    },

    // ── Auth ──────────────────────────────────────────────────
    auth: {
      method: 'hedera-signature-challenge',
      description:
        'Sign a server-issued nonce with your Hedera private key to receive a session token.',
      flow: [
        'POST /api/auth/challenge with { accountId }',
        'Sign the returned message with your Hedera key',
        'POST /api/auth/verify with { challengeId, accountId, signatureMapBase64 }',
        'Receive { sessionToken, mcpUrl, expiresAt }',
      ],
      supportedKeyTypes: ['ED25519', 'ECDSA_SECP256K1'],
      sessionDuration: '7 days',
      lockable: true,
    },

    // ── Fees ──────────────────────────────────────────────────
    fees: {
      rakePercent: {
        default: Number(process.env.RAKE_DEFAULT_PERCENT ?? 5),
        min: Number(process.env.RAKE_MIN_PERCENT ?? 2),
        max: Number(process.env.RAKE_MAX_PERCENT ?? 5),
      },
      volumeTiers: [
        { minDeposit: 1000, rakePercent: 3.0 },
        { minDeposit: 500, rakePercent: 3.5 },
        { minDeposit: 200, rakePercent: 4.0 },
        { minDeposit: 50, rakePercent: 5.0 },
      ],
      negotiable: true,
      description:
        'Rake is charged on deposits, not wins. Lower rates for higher volume.',
    },

    // ── Strategies ────────────────────────────────────────────
    strategies: {
      available: ['conservative', 'balanced', 'aggressive'],
      default: 'balanced',
      description:
        'Strategies control pool selection, budget, and play style. Set at registration.',
    },

    // ── Capabilities ──────────────────────────────────────────
    capabilities: {
      singleUser: true,
      multiUser: true,
      autoPlay: true,
      prizeTransfer: true,
      depositDetection: true,
      onChainAccounting: true,
      reconciliation: true,
      // Opt-in surfaces (Hedera Commerce Agent work). Advertised only
      // when actually live so discovery never promises a disabled path.
      chat: chatEnabled,
      x402Payments: x402Active,
    },

    // ── Agentic commerce (x402) ───────────────────────────────
    // Only present when the gate is active. JSON.stringify drops the
    // `undefined`, so an x402-off deploy simply has no `commerce` key.
    commerce: x402Active
      ? {
          protocol: 'x402',
          network: features.x402.network,
          facilitator: features.x402.facilitatorUrl,
          description:
            'HTTP-native paid capabilities via x402 on Hedera. A connecting ' +
            'agent can pay programmatically (402 → sign Hedera transfer → ' +
            'facilitator settles) to unlock a capability — no pre-funded ' +
            'custodial balance required.',
          capabilities: [
            {
              id: 'rake_holiday',
              endpoint: `${baseUrl}/api/premium/rake-holiday`,
              method: 'POST',
              description: `Pay a one-off USD price to get 0% rake on deposits for ${features.x402.rakeHoliday.durationDays} days.`,
              price: {
                usd: `$${(features.x402.rakeHoliday.priceUsdCents / 100).toFixed(2)}`,
                assets: ['HBAR', `USDC (${features.x402.usdcTokenId})`],
              },
              auth: 'Bearer session token (identifies whose rake holiday this is)',
            },
          ],
        }
      : undefined,

    // ── Deposits ──────────────────────────────────────────────
    deposits: {
      acceptedTokens: ['HBAR', 'LAZY'],
      minDeposit: 1,
      maxBalance: Number(process.env.MAX_USER_BALANCE ?? 10_000),
      description:
        'Deposit via memo-tagged transfer to the agent wallet. Memo provided at registration.',
    },

    // ── Links ─────────────────────────────────────────────────
    links: {
      website: 'https://lazysuperheroes.com',
      dapp:
        network === 'mainnet'
          ? 'https://dapp.lazysuperheroes.com'
          : 'https://testnet-dapp.lazysuperheroes.com',
      documentation: 'https://github.com/lazysuperheroes/lazylotto-agent',
      brand: 'https://docs.lazysuperheroes.com',
    },
  };
}
