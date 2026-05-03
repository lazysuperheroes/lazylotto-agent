/**
 * Canonical MCP tool names for the multi-user / hosted agent surface.
 *
 * These constants are the single source of truth for which tools the
 * agent exposes via its REMOTE protocols (MCP HTTP + A2A). When you add
 * a new MCP tool that should be reachable from the dashboard, Claude.ai,
 * Claude Desktop, Cursor, or any A2A client:
 *
 *   1. Add the tool name to the appropriate list below.
 *   2. Register the tool handler in `src/mcp/tools/multi-user.ts` or
 *      `src/mcp/tools/operator.ts`.
 *   3. Add a matching skill entry in `src/a2a/agent-card.ts`.
 *
 * The drift-prevention test in `src/a2a/__tests__/agent-card.test.ts`
 * asserts that the A2A skill IDs equal these constants exactly. The
 * parity smoke test (`npm run check-protocols`) does the same thing
 * against a deployed URL.
 *
 * Single-user CLI tools (the `agent_*` family in `single-user.ts`) are
 * deliberately NOT included here — they only ship in the stdio CLI
 * deployment, not the hosted multi-user surface.
 */

export const MULTI_USER_TOOL_NAMES = [
  'multi_user_status',
  'multi_user_register',
  'multi_user_deposit_info',
  'multi_user_play',
  'multi_user_withdraw',
  'multi_user_deregister',
  'multi_user_play_history',
  'multi_user_set_strategy',
] as const;

export const OPERATOR_TOOL_NAMES = [
  'operator_balance',
  'operator_withdraw_fees',
  'operator_reconcile',
  'operator_dead_letters',
  'operator_refund',
  'operator_recover_stuck_prizes',
  'operator_health',
] as const;

export const ALL_REMOTE_TOOL_NAMES = [
  ...MULTI_USER_TOOL_NAMES,
  ...OPERATOR_TOOL_NAMES,
] as const;

export type MultiUserToolName = (typeof MULTI_USER_TOOL_NAMES)[number];
export type OperatorToolName  = (typeof OPERATOR_TOOL_NAMES)[number];
export type RemoteToolName    = (typeof ALL_REMOTE_TOOL_NAMES)[number];
