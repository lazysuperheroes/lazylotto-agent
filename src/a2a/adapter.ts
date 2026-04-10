/**
 * A2A ↔ MCP Adapter
 *
 * Thin translation layer that:
 * 1. Parses an A2A SendMessageRequest to extract skill + params
 * 2. Calls the SAME tool handlers the MCP server uses (via McpServer
 *    internal dispatch — NOT duplicated handler code)
 * 3. Wraps the MCP ToolResult as an A2A Task with artifacts
 *
 * The adapter introduces ZERO new business logic. Every operation
 * flows through the identical code path as an MCP tools/call request.
 * The parity test suite in __tests__/parity.test.ts verifies this
 * by calling each tool via both protocols and comparing outputs.
 *
 * ── How skill invocation works ────────────────────────────────
 *
 * A2A is message-oriented: clients send a Message with Parts. For
 * structured tool invocation, we expect a DataPart with:
 *   { skill: "multi_user_play", params: { userId: "..." } }
 *
 * Or a TextPart containing JSON with the same shape. The skill ID
 * maps 1:1 to the MCP tool name. If the message contains no
 * recognizable skill invocation, we return a helpful error listing
 * available skills.
 */

import { randomUUID } from 'node:crypto';
import type {
  Message,
  Part,
  Task,
  TaskState,
  Artifact,
  DataPart,
  SendMessageSuccessResponse,
} from '@a2a-js/sdk';
import { getSkillIds } from './agent-card.js';

// ── Types ──────────────────────────────────────────────────────

/** Extracted invocation from an A2A message. */
export interface SkillInvocation {
  skill: string;
  params: Record<string, unknown>;
}

/** MCP-compatible tool result (matches the shape from src/mcp/tools/types.ts). */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: true;
}

/** Adapter's call-tool function — injected by the route handler. */
export type CallToolFn = (
  toolName: string,
  params: Record<string, unknown>,
) => Promise<ToolResult>;

// ── Message parsing ────────────────────────────────────────────

/**
 * Extract a skill invocation from an A2A message.
 *
 * Checks parts in order:
 * 1. DataPart with { skill, params? } — preferred structured format
 * 2. TextPart containing JSON with { skill, params? } — fallback
 *
 * Returns null if no valid invocation is found.
 */
export function parseSkillInvocation(message: Message): SkillInvocation | null {
  for (const part of message.parts) {
    // DataPart (kind: "data")
    if (part.kind === 'data') {
      const data = (part as DataPart).data as Record<string, unknown>;
      if (typeof data.skill === 'string') {
        return {
          skill: data.skill,
          params: (data.params as Record<string, unknown>) ?? {},
        };
      }
    }

    // TextPart containing JSON (kind: "text")
    if (part.kind === 'text') {
      const textPart = part as { kind: 'text'; text: string };
      try {
        const parsed = JSON.parse(textPart.text) as Record<string, unknown>;
        if (typeof parsed.skill === 'string') {
          return {
            skill: parsed.skill,
            params: (parsed.params as Record<string, unknown>) ?? {},
          };
        }
      } catch {
        // Not JSON — skip
      }
    }
  }

  return null;
}

// ── Task wrapping ──────────────────────────────────────────────

/**
 * Wrap an MCP ToolResult as a completed (or failed) A2A Task.
 *
 * The tool result's JSON content becomes a DataPart in the first
 * artifact. Error results get TaskState "failed" with the error
 * message in the status message.
 */
export function wrapAsTask(
  toolResult: ToolResult,
  contextId?: string,
): Task {
  const taskId = randomUUID();
  const isError = toolResult.isError === true;
  const text = toolResult.content[0]?.text ?? '{}';

  let resultData: Record<string, unknown>;
  try {
    resultData = JSON.parse(text) as Record<string, unknown>;
  } catch {
    resultData = { raw: text };
  }

  const state: TaskState = isError ? 'failed' : 'completed';

  const artifacts: Artifact[] = [
    {
      artifactId: randomUUID(),
      name: 'result',
      parts: [
        {
          kind: 'data' as const,
          data: resultData,
        },
      ],
    },
  ];

  const statusMessage: Message | undefined = isError
    ? {
        kind: 'message' as const,
        messageId: randomUUID(),
        role: 'agent' as const,
        parts: [{ kind: 'text' as const, text: resultData.error as string ?? text }],
      }
    : undefined;

  return {
    kind: 'task' as const,
    id: taskId,
    contextId: contextId ?? randomUUID(),
    status: {
      state,
      timestamp: new Date().toISOString(),
      ...(statusMessage ? { message: statusMessage } : {}),
    },
    artifacts: isError ? undefined : artifacts,
  };
}

// ── Main handler ───────────────────────────────────────────────

/**
 * Handle an A2A message/send request.
 *
 * Parses the message, validates the skill exists, calls the MCP
 * tool handler via the injected callTool function, and wraps the
 * result as an A2A Task.
 */
export async function handleSendMessage(
  message: Message,
  callTool: CallToolFn,
): Promise<SendMessageSuccessResponse> {
  // 1. Parse skill invocation
  const invocation = parseSkillInvocation(message);

  if (!invocation) {
    const skills = Array.from(getSkillIds()).join(', ');
    const errorResult: ToolResult = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'No skill invocation found in message. Send a DataPart with { skill, params }.',
          availableSkills: skills,
        }),
      }],
      isError: true,
    };
    return {
      jsonrpc: '2.0',
      id: null,
      result: wrapAsTask(errorResult, message.contextId),
    };
  }

  // 2. Validate skill exists
  if (!getSkillIds().has(invocation.skill)) {
    const skills = Array.from(getSkillIds()).join(', ');
    const errorResult: ToolResult = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: `Unknown skill: ${invocation.skill}`,
          availableSkills: skills,
        }),
      }],
      isError: true,
    };
    return {
      jsonrpc: '2.0',
      id: null,
      result: wrapAsTask(errorResult, message.contextId),
    };
  }

  // 3. Call the MCP tool
  const toolResult = await callTool(invocation.skill, invocation.params);

  // 4. Wrap as A2A Task
  return {
    jsonrpc: '2.0',
    id: null,
    result: wrapAsTask(toolResult, message.contextId),
  };
}
