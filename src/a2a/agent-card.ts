/**
 * A2A Agent Card builder.
 *
 * Generates the /.well-known/agent-card.json document that A2A clients
 * fetch to discover what this agent can do, where to reach it, and how
 * to authenticate. Each MCP tool maps 1:1 to an A2A skill with a
 * matching `id`, so callers can invoke skills by the same name they'd
 * use for MCP tools/call.
 *
 * The Agent Card is served from two routes:
 *   - GET /.well-known/agent-card.json  (standard A2A discovery path)
 *   - GET /api/a2a                      (convenience, same payload)
 */

import type { AgentCard, AgentSkill } from '@a2a-js/sdk';
// R4-FG-56 (round-4 medium): import package.json's version field
// directly. Pre-fix the chain `NEXT_PUBLIC_APP_VERSION ?? npm_package_version
// ?? '0.2.0'` left production stuck on the '0.2.0' fallback because
// neither env var is reliably set at runtime on Vercel. Both tsconfigs
// have `resolveJsonModule: true`. Cast to a typed snippet so we don't
// pull the entire package.json into the type signature.
import packageJson from '../../package.json' with { type: 'json' };
const PACKAGE_VERSION = (packageJson as { version: string }).version;

// ── Skills derived from MCP tools ──────────────────────────────
//
// Each entry maps directly to a registered MCP tool. The `id` field
// is the tool name (multi_user_play, operator_health, etc.) so the
// A2A adapter can resolve skill → tool without a lookup table.
//
// R4-FG-39 (round-4 medium): single-user CLI tools (the `agent_*`
// family in `src/mcp/tools/single-user.ts`) are deliberately ABSENT
// from this card. They are only registered in the stdio CLI server
// (`src/mcp/server.ts`), NOT in the hosted serverless deployment
// (`app/api/_lib/mcp.ts`) that the A2A endpoint adapts to. Listing
// them on the card would advertise capabilities the deployed agent
// doesn't expose, breaking discovery semantics for any agent that
// dispatches by skill id. The parity smoke test
// (`npm run check-protocols`) and the `agent-card.test.ts` drift
// gate both source their expected set from `ALL_REMOTE_TOOL_NAMES`,
// which intentionally excludes the single-user surface.
//
// If you add `agent_*` tools to the hosted surface, add the tool to
// `ALL_REMOTE_TOOL_NAMES` in `src/mcp/tool-names.ts` first, then add
// matching skill entries here. Don't add them in isolation — drift
// breaks the parity gate.

const MULTI_USER_SKILLS: AgentSkill[] = [
  {
    id: 'multi_user_status',
    name: 'List all users',
    description: 'List all registered users with balances and last activity. Requires admin/operator tier.',
    tags: ['users', 'admin', 'status'],
    examples: ['Show me all registered users'],
  },
  {
    id: 'multi_user_register',
    name: 'Register a new user',
    description: 'Register a new user account. Returns a unique deposit memo for funding. Params: eoaAddress (required), strategy (conservative|balanced|aggressive), rakePercent.',
    tags: ['register', 'onboarding'],
    examples: ['Register account 0.0.12345 with balanced strategy'],
  },
  {
    id: 'multi_user_deposit_info',
    name: 'Get deposit info',
    description: 'Get deposit memo and funding instructions for an existing user. Params: userId (optional, auto-resolved for user tier).',
    tags: ['deposit', 'funding'],
    examples: ['How do I deposit HBAR?'],
  },
  {
    id: 'multi_user_play',
    name: 'Play a lottery session',
    description: 'Trigger a play session for a user. The agent evaluates pools, buys entries, and rolls for prizes. Params: userId (optional). Requires sufficient balance.',
    tags: ['play', 'lottery', 'game'],
    examples: ['Play a session for me', 'Run the lottery'],
  },
  {
    id: 'multi_user_withdraw',
    name: 'Withdraw funds',
    description: 'Withdraw funds to the user\'s Hedera account. Params: amount (required), token (default: hbar), userId (optional).',
    tags: ['withdraw', 'funds'],
    examples: ['Withdraw 10 HBAR'],
  },
  {
    id: 'multi_user_deregister',
    name: 'Deactivate account',
    description: 'Deactivate a user account. The user can still withdraw remaining balance. Params: userId (optional).',
    tags: ['deregister', 'account'],
    examples: ['Deactivate my account'],
  },
  {
    id: 'multi_user_play_history',
    name: 'View play history',
    description: 'View play session history for a user. Params: userId (optional), limit (default: 20).',
    tags: ['history', 'sessions', 'plays'],
    examples: ['Show my last 5 play sessions'],
  },
  {
    id: 'multi_user_set_strategy',
    name: 'Change strategy preset',
    description: 'Change a user\'s play strategy preset. Takes effect on the next play session. Params: strategy (conservative|balanced|aggressive, required), userId (optional, auto-resolved for user tier).',
    tags: ['strategy', 'preferences'],
    examples: ['Switch me to aggressive', 'Set strategy to conservative'],
  },
];

const OPERATOR_SKILLS: AgentSkill[] = [
  {
    id: 'operator_balance',
    name: 'View operator balance',
    description: 'View operator platform balance: rake collected, gas spent, net profit. Requires admin/operator tier.',
    tags: ['operator', 'balance', 'admin'],
    examples: ['Show the operator balance sheet'],
  },
  {
    id: 'operator_withdraw_fees',
    name: 'Withdraw operator fees',
    description: 'Withdraw accumulated rake fees. Params: amount (required), to (required), token (HBAR|LAZY). Requires admin/operator.',
    tags: ['operator', 'withdraw', 'admin'],
    examples: ['Withdraw 50 HBAR in fees to 0.0.12345'],
  },
  {
    id: 'operator_reconcile',
    name: 'Run reconciliation',
    description: 'Compare on-chain wallet balances against internal ledger. Reports per-token deltas and solvency status. Requires admin/operator.',
    tags: ['operator', 'reconcile', 'audit', 'admin'],
    examples: ['Run a solvency check'],
  },
  {
    id: 'operator_dead_letters',
    name: 'View dead letters',
    description: 'View dead-letter queue: deposits that failed processing. Requires admin/operator.',
    tags: ['operator', 'dead-letters', 'admin'],
    examples: ['Show failed deposits'],
  },
  {
    id: 'operator_refund',
    name: 'Refund a transaction',
    description: 'Refund a transaction by looking up sender on mirror node and transferring amount back. Params: transactionId (required). Requires admin/operator.',
    tags: ['operator', 'refund', 'admin'],
    examples: ['Refund transaction 0.0.1234-1234567890-123456789'],
  },
  {
    id: 'operator_recover_stuck_prizes',
    name: 'Recover stuck prizes',
    description: 'Recover prizes stranded in agent wallet due to failed transfers. Params: userId (required), execute (default: false for dry-run), reason. Requires admin/operator.',
    tags: ['operator', 'recovery', 'prizes', 'admin'],
    examples: ['Dry-run prize recovery for user abc123'],
  },
  {
    id: 'operator_health',
    name: 'Agent health check',
    description: 'Health check: uptime, deposit watcher status, error count, active users, pending reserves. Requires admin/operator.',
    tags: ['operator', 'health', 'admin'],
    examples: ['Is the agent healthy?'],
  },
];

// ── Agent Card builder ──────────────────────────────────────────

/**
 * Build the A2A Agent Card for this deployment.
 *
 * The card is network-aware (testnet vs mainnet) and includes all
 * registered skills. Capabilities are conservative for Phase 1:
 * no streaming, no push notifications.
 */
export function buildAgentCard(): AgentCard {
  const network = process.env.HEDERA_NETWORK ?? 'testnet';
  const baseUrl =
    network === 'mainnet'
      ? 'https://agent.lazysuperheroes.com'
      : 'https://testnet-agent.lazysuperheroes.com';

  // R4-FG-56 (round-4 medium): version sourced from the imported
  // package.json so it can never drift. Env var fallback retained for
  // bespoke deployments that override (e.g., a fork running its own
  // build pipeline).
  const version =
    process.env.NEXT_PUBLIC_APP_VERSION ??
    process.env.npm_package_version ??
    PACKAGE_VERSION;

  return {
    name: 'LazyLotto Agent',
    description:
      'Autonomous lottery agent on Hedera by Lazy Superheroes. ' +
      'Plays LazyLotto pools on behalf of users — evaluates expected value, ' +
      'buys entries, rolls for prizes, and transfers winnings. ' +
      'Accepts deposits via memo-tagged transfers with configurable strategies ' +
      'and full on-chain HCS-20 accounting.',
    url: `${baseUrl}/api/a2a`,
    version,
    protocolVersion: '0.2.5',
    provider: {
      organization: 'Lazy Superheroes',
      url: 'https://docs.lazysuperheroes.com',
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    securitySchemes: {
      bearer: {
        type: 'http' as const,
        scheme: 'bearer',
        description:
          'Session token obtained from /api/auth/verify after Hedera signature challenge. ' +
          'Pass as Authorization: Bearer sk_...',
      },
    },
    security: [{ bearer: [] }],
    skills: [...MULTI_USER_SKILLS, ...OPERATOR_SKILLS],
  };
}

/**
 * Get all skill IDs (tool names) this agent exposes via A2A.
 * Used by the adapter to validate incoming skill references.
 */
export function getSkillIds(): Set<string> {
  return new Set([
    ...MULTI_USER_SKILLS.map((s) => s.id),
    ...OPERATOR_SKILLS.map((s) => s.id),
  ]);
}
