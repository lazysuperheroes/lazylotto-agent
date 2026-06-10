/**
 * Feature flags for the opt-in surfaces added for the Hedera Commerce Agent
 * work: the AI chat interface (Hedera Agent Kit) and the x402 HBAR/USDC payment
 * gate.
 *
 * Mirrors `loadCustodialConfig` in src/custodial/types.ts — pure `process.env`
 * reads with safe defaults, no file I/O — so it behaves identically in the CLI
 * and in serverless (Vercel). No inline-for-serverless duplication needed
 * (unlike strategy files in src/config/loader.ts, which need disk access).
 *
 * EVERYTHING DEFAULTS OFF. Production runs with these unset until each surface
 * is ready; flipping a single env flag enables it, with no code removal. This
 * file imports nothing heavy and is CLI-safe (no kit / ai / x402 imports), so
 * it stays in the published CLI bundle without pulling web-only dependencies.
 */

export type ChatModelProvider = 'anthropic';

export interface ChatFeatureConfig {
  /** Master switch for the /chat page + /api/chat route. */
  enabled: boolean;
  /** LLM provider behind the chat agent. Only 'anthropic' today. */
  provider: ChatModelProvider;
  /** Model id passed to the AI SDK provider, e.g. 'claude-sonnet-4-6'. */
  model: string;
  // ── Cost guardrails (keep the demo within budget; all configurable) ──
  /** Max model output tokens per turn. */
  maxOutputTokens: number;
  /** Max characters accepted in a single user message (longer → 400). */
  maxInputChars: number;
  /** Max prior messages kept as context (older are dropped to bound input). */
  maxHistoryMessages: number;
  /** Max tool-call steps per turn (bounds fan-out / model round-trips). */
  maxSteps: number;
  /** Max chat messages per identity per rolling 24h (volume cost cap). */
  dailyMessageLimit: number;
  /**
   * Allow the chat agent to START A PLAY SESSION — the ONE mutating chat tool,
   * gated behind an explicit two-step confirmation (preview, then play only on
   * the user's clear "yes"). Default OFF: chat is read-only unless this is set,
   * preserving the "no chat tool moves value without explicit confirm" posture.
   * The play still flows through the audited MCP → custodial path; the kit's own
   * mutating plugins are never loaded.
   */
  allowPlay: boolean;
}

export interface RakeHolidayConfig {
  /**
   * Price in USD cents (e.g. 500 = $5.00). The holiday is priced in USD and
   * payable in USDC (1:1) or the live HBAR equivalent (see X402FeatureConfig).
   */
  priceUsdCents: number;
  /** Holiday length in days. */
  durationDays: number;
  /**
   * Minimum fraction of the USD price a payment must cover, to absorb HBAR/USD
   * rate drift between quote and settlement. 0.97 = accept a payment worth at
   * least 97% of the target (3% slippage tolerance). USDC payments need no
   * rate check. Config-driven via X402_PRICE_MIN_ACCEPTED_FRACTION.
   */
  minAcceptedFraction: number;
}

export interface X402FeatureConfig {
  /**
   * Master switch for the x402 payment gate. When false, gated capabilities
   * are served transparently via the normal (custodial / read) path — no 402,
   * no payment. x402 is an ALTERNATIVE payment channel, NEVER a replacement
   * for the deposit-time rake.
   */
  enabled: boolean;
  /** x402 facilitator base URL (verify + settle). */
  facilitatorUrl: string;
  /** CAIP-2 network id for the Hedera x402 scheme. */
  network: 'hedera:testnet' | 'hedera:mainnet';
  /** Hedera account id (0.0.x) that receives payments. */
  payTo: string;
  /** Facilitator fee-payer account that co-signs gas. Must match the facilitator. */
  feePayer: string;
  /** x402 payment validity window, in seconds. */
  maxTimeoutSeconds: number;
  /**
   * Mirror node base URL for the HBAR<->USD exchange rate
   * (GET /api/v1/network/exchangerate).
   *
   * Rate definition: `hbar_equivalent` HBAR is worth `cent_equivalent` cents, so
   *   USD per HBAR = cent_equivalent / hbar_equivalent / 100
   *   tinybars(N cents) = round(N * hbar_equivalent / cent_equivalent * 1e8)
   * Worked example at cent_equivalent=243159, hbar_equivalent=30000
   * (≈ $0.081 / HBAR): $5.00 (500c) ≈ 500 * 30000 / 243159 ≈ 61.7 HBAR
   * ≈ 6.17e9 tinybars. (Note the /100: cents→dollars, not dollars directly.)
   */
  mirrorNodeUrl: string;
  /** HTS token id used for USDC payments (network-specific). */
  usdcTokenId: string;
  /** Optionally record x402 payments to the HCS-20 trail (additive event). */
  recordToHcs20: boolean;
  /** The "rake holiday" gated capability — pay USD (USDC/HBAR) → 0% rake. */
  rakeHoliday: RakeHolidayConfig;
}

export interface FeatureConfig {
  chat: ChatFeatureConfig;
  x402: X402FeatureConfig;
}

const TRUE = 'true';

/** A boolean env flag is on only when set to the exact string 'true'. */
function envFlag(name: string): boolean {
  return process.env[name] === TRUE;
}

/**
 * Read an env var, treating an EMPTY string as unset so `env('X') ?? default`
 * falls back to the default. Plain `process.env.X ?? default` does NOT — `'' ??
 * default` is `''`. A `.env` copied from `.env.example` carries keys like
 * `X402_MIRROR_NODE_URL=` (present but empty), which would otherwise defeat the
 * fallback and yield an empty URL/token (e.g. the relative-URL fetch crash).
 */
function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

export function loadFeatureConfig(): FeatureConfig {
  const isMainnet = (env('HEDERA_NETWORK') ?? 'testnet') === 'mainnet';
  const network: X402FeatureConfig['network'] = isMainnet
    ? 'hedera:mainnet'
    : 'hedera:testnet';

  return {
    chat: {
      enabled: envFlag('CHAT_ENABLED'),
      provider: 'anthropic',
      model: env('CHAT_MODEL') ?? 'claude-haiku-4-5',
      maxOutputTokens: Number(env('CHAT_MAX_OUTPUT_TOKENS') ?? 800),
      maxInputChars: Number(env('CHAT_MAX_INPUT_CHARS') ?? 1200),
      maxHistoryMessages: Number(env('CHAT_MAX_HISTORY_MESSAGES') ?? 10),
      maxSteps: Number(env('CHAT_MAX_STEPS') ?? 4),
      dailyMessageLimit: Number(env('CHAT_DAILY_MESSAGE_LIMIT') ?? 40),
      allowPlay: envFlag('CHAT_ALLOW_PLAY'),
    },
    x402: {
      enabled: envFlag('X402_ENABLED'),
      facilitatorUrl:
        env('X402_FACILITATOR_URL') ?? 'https://api.testnet.blocky402.com',
      network,
      payTo: env('X402_PAY_TO') ?? env('HEDERA_ACCOUNT_ID') ?? '',
      // Blocky402 testnet fee-payer default; set explicitly for mainnet / a
      // self-hosted facilitator.
      feePayer: env('X402_FEE_PAYER') ?? (isMainnet ? '' : '0.0.7162784'),
      maxTimeoutSeconds: Number(env('X402_MAX_TIMEOUT_SECONDS') ?? 120),
      mirrorNodeUrl:
        env('X402_MIRROR_NODE_URL') ??
        (isMainnet
          ? 'https://mainnet.mirrornode.hedera.com'
          : 'https://testnet.mirrornode.hedera.com'),
      // Circle USDC: testnet 0.0.429274, mainnet 0.0.456858.
      usdcTokenId:
        env('X402_USDC_TOKEN_ID') ?? (isMainnet ? '0.0.456858' : '0.0.429274'),
      recordToHcs20: envFlag('X402_RECORD_TO_HCS20'),
      rakeHoliday: {
        priceUsdCents: Number(env('X402_RAKE_HOLIDAY_PRICE_USD_CENTS') ?? 500),
        durationDays: Number(env('X402_RAKE_HOLIDAY_DAYS') ?? 30),
        minAcceptedFraction: Number(
          env('X402_PRICE_MIN_ACCEPTED_FRACTION') ?? 0.97,
        ),
      },
    },
  };
}

/**
 * True iff the x402 gate should actively challenge for payment: the flag is on
 * AND a destination account is configured. When false, gated routes serve the
 * capability transparently (no 402). Callers use this so a half-configured
 * deploy (flag on but no payTo) fails safe to "serve transparently" rather than
 * 402-ing with nowhere to send funds.
 */
export function isX402Active(cfg: FeatureConfig = loadFeatureConfig()): boolean {
  return cfg.x402.enabled && cfg.x402.payTo.length > 0;
}
