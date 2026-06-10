import { z } from 'zod3';
import type { Plugin, Tool, Context } from '@hashgraph/hedera-agent-kit';
import type { Client } from '@hiero-ledger/sdk';
import { callMcpTool } from './mcpBridge.js';

/**
 * A Hedera Agent Kit plugin that surfaces LazyLotto's existing, audited MCP
 * tools to the chat LLM. Each tool's `execute` routes through callMcpTool →
 * /api/mcp, so user-tier auth scoping and every settlement guarantee hold
 * unchanged — the kit never moves value itself.
 *
 * The plugin is built PER REQUEST with the caller's origin + session token
 * closed over, so the kit's (untyped) `context` never has to carry the secret.
 *
 * Tool parameter schemas use `zod3` (npm-aliased zod@3.25.76) to match the
 * kit's own bundled zod major — the app at large is on zod@4, and mixing the
 * two ZodObject identities would break both compile-time typing and the kit's
 * runtime zod-to-json-schema conversion. Keep kit-facing schemas on zod3.
 *
 * Wraps READ-only, user-scoped tools by default. The value-moving
 * `multi_user_play` is included ONLY when `allowPlay` is set (CHAT_ALLOW_PLAY),
 * and even then behind a two-step confirmation (see the play tool below).
 * `multi_user_status` is NOT wrapped — it is admin/operator-only (lists all
 * users). `multi_user_withdraw` is intentionally never wrapped — withdrawals
 * stay on the dashboard.
 */
export interface LazyLottoPluginOptions {
  /** Deployment origin used to reach our own /api/mcp endpoint. */
  origin: string;
  /** The signed-in user's session token, threaded into every tool call. */
  authToken: string;
  /**
   * Include the confirmed `multi_user_play` tool (the only mutating chat tool).
   * Default false — chat is read-only unless the operator opts in.
   */
  allowPlay?: boolean;
}

export function createLazyLottoPlugin(opts: LazyLottoPluginOptions): Plugin {
  const tool = (
    method: string,
    name: string,
    description: string,
    parameters: z.ZodObject<any, any>,
  ): Tool => ({
    method,
    name,
    description,
    parameters,
    // The kit hands us (client, context, params); value movement does NOT go
    // through the kit — we forward to our audited MCP tool with the trusted
    // session token. client/context are unused here by design.
    execute: async (
      _client: Client,
      _context: Context,
      params: Record<string, unknown>,
    ) => {
      const result = await callMcpTool({
        origin: opts.origin,
        toolName: method,
        args: params ?? {},
        authToken: opts.authToken,
      });
      return result.json;
    },
  });

  // The confirmed play tool. Two-step by construction: it REFUSES to play
  // unless `confirm === true`, returning a confirmation prompt instead. The
  // system prompt instructs the model to set confirm=true ONLY after the user
  // explicitly says yes. The actual play routes through the audited MCP path
  // (callMcpTool → /api/mcp → multi_user_play) with the user's session token —
  // all per-user reservation/settlement/ownership guarantees hold unchanged.
  const playTool: Tool = {
    method: 'multi_user_play',
    name: 'Play a lottery session (requires explicit confirmation)',
    description:
      'Starts a lottery play session for the signed-in user, spending from ' +
      'their balance per their active strategy and rolling for prizes. This ' +
      'MOVES money, so it is TWO-STEP: first call with confirm=false to show ' +
      'the user what will happen and ask them to confirm; call with ' +
      'confirm=true ONLY after the user clearly says yes in their latest ' +
      'message. Never set confirm=true on your own initiative.',
    parameters: z.object({
      confirm: z
        .boolean()
        .optional()
        .describe(
          'Must be true to actually play. Omitted/false returns a ' +
            'confirmation prompt WITHOUT playing.',
        ),
    }),
    execute: async (
      _client: Client,
      _context: Context,
      params: Record<string, unknown>,
    ) => {
      if (params?.confirm !== true) {
        return {
          status: 'confirmation_required',
          message:
            'A play session will spend from your balance according to your ' +
            'active strategy and roll for prizes. Reply "yes, play" to ' +
            'confirm — or you can play from the dashboard.',
        };
      }
      const result = await callMcpTool({
        origin: opts.origin,
        toolName: 'multi_user_play',
        // userId auto-resolves from the session token for user tier.
        args: {},
        authToken: opts.authToken,
      });
      return result.json;
    },
  };

  return {
    name: 'lazylotto-custodial',
    version: '1.0.0',
    description: 'LazyLotto custodial tools, routed through the audited MCP path.',
    tools: (_context: Context): Tool[] => [
      tool(
        'multi_user_deposit_info',
        'Get my balance and funding info',
        "Returns the signed-in user's token balances plus their deposit address " +
          'and memo (how to add funds). Use for questions like "what is my ' +
          'balance" or "how do I deposit".',
        z.object({}),
      ),
      tool(
        'multi_user_play_history',
        'Get my play history',
        "Lists the signed-in user's recent lottery play sessions and results.",
        z.object({
          limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Max sessions to return (default 20).'),
        }),
      ),
      // Mutating tool — included ONLY when the operator opts in (CHAT_ALLOW_PLAY).
      ...(opts.allowPlay ? [playTool] : []),
    ],
  };
}
