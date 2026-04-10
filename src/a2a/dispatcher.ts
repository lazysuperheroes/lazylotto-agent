/**
 * A2A JSON-RPC 2.0 Dispatcher
 *
 * Routes incoming JSON-RPC requests to the appropriate handler.
 * Only `message/send` is fully supported (synchronous task completion).
 * Other methods return spec-compliant errors.
 *
 * Method names follow the A2A spec:
 *   - message/send     → handleSendMessage (the one we implement)
 *   - message/stream   → UnsupportedOperationError (Phase 2)
 *   - tasks/get        → TaskNotFoundError (stateless, tasks not persisted)
 *   - tasks/cancel     → TaskNotCancelableError (tasks complete synchronously)
 *   - *                → MethodNotFoundError
 */

import type { Message } from '@a2a-js/sdk';
import { handleSendMessage, type CallToolFn } from './adapter.js';

// ── Types ──────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── Standard A2A error codes ───────────────────────────────────

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
// const ERR_INVALID_PARAMS = -32602;
const ERR_TASK_NOT_FOUND = -32001;
const ERR_TASK_NOT_CANCELABLE = -32002;
const ERR_UNSUPPORTED_OPERATION = -32003;

// ── Dispatcher ─────────────────────────────────────────────────

/**
 * Parse and dispatch a raw request body to the appropriate A2A handler.
 *
 * Accepts the raw string (from request.text()) so we can handle
 * JSON parse errors with the correct JSON-RPC error code.
 */
export async function dispatch(
  rawBody: string,
  callTool: CallToolFn,
): Promise<JsonRpcResponse> {
  // 1. Parse JSON
  let body: JsonRpcRequest;
  try {
    body = JSON.parse(rawBody) as JsonRpcRequest;
  } catch {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: ERR_PARSE, message: 'Invalid JSON' },
    };
  }

  // 2. Validate JSON-RPC envelope
  if (body.jsonrpc !== '2.0' || !body.method) {
    return {
      jsonrpc: '2.0',
      id: body.id ?? null,
      error: { code: ERR_INVALID_REQUEST, message: 'Invalid JSON-RPC 2.0 request' },
    };
  }

  const id = body.id ?? null;

  // 3. Route to handler
  switch (body.method) {
    case 'message/send': {
      const params = body.params as { message?: Message } | undefined;
      if (!params?.message) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: ERR_INVALID_REQUEST, message: 'Missing params.message' },
        };
      }

      const response = await handleSendMessage(params.message, callTool);
      // handleSendMessage returns a SendMessageSuccessResponse with its own
      // jsonrpc + id fields. Override the id to match the request.
      return { jsonrpc: '2.0', id, result: response.result };
    }

    case 'message/stream':
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: ERR_UNSUPPORTED_OPERATION,
          message: 'Streaming is not supported. Use message/send for synchronous responses.',
        },
      };

    case 'tasks/get':
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: ERR_TASK_NOT_FOUND,
          message: 'Tasks are not persisted in stateless mode. Results are returned inline from message/send.',
        },
      };

    case 'tasks/cancel':
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: ERR_TASK_NOT_CANCELABLE,
          message: 'Tasks complete synchronously and cannot be canceled.',
        },
      };

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: ERR_METHOD_NOT_FOUND,
          message: `Method "${body.method}" is not supported. Use "message/send" to invoke agent skills.`,
        },
      };
  }
}
