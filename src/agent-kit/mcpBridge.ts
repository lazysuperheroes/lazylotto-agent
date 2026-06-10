/**
 * Bridge from the Hedera Agent Kit chat tools to LazyLotto's existing MCP
 * tools — by calling our OWN /api/mcp endpoint over HTTP, exactly like the
 * A2A adapter does (app/api/a2a/route.ts).
 *
 * Routing chat tool calls through /api/mcp (rather than calling the custodial
 * handlers in-process) means they inherit every auth-tier check, idempotency
 * guard, Redis lock, and HCS-20 write BY CONSTRUCTION — no new value-path code,
 * no new audit surface. This is the same parity-by-construction guarantee that
 * makes the A2A surface safe today.
 *
 * Security (R3-FG-60): a caller-supplied `auth_token` is stripped from the
 * arguments BEFORE the trusted, server-derived token is injected. The chat LLM
 * never sees or controls the session token — it cannot smuggle a victim's
 * token in via a tool argument.
 */

export interface McpToolResult {
  /** Concatenated text content from the MCP tool result. */
  text: string;
  /** Whether the MCP tool reported an error. */
  isError: boolean;
  /** Parsed JSON of `text` when it parses, else the raw `text` string. */
  json: unknown;
}

interface McpJsonRpcResponse {
  result?: { content?: { type: string; text: string }[]; isError?: boolean };
  error?: { message: string };
}

export interface CallMcpToolOptions {
  /** Origin of the deployment, e.g. https://testnet-agent.lazysuperheroes.com */
  origin: string;
  /** MCP tool name, e.g. 'multi_user_deposit_info'. */
  toolName: string;
  /** Tool arguments the LLM supplied (any `auth_token` here is stripped). */
  args: Record<string, unknown>;
  /** Trusted session token injected server-side; never sourced from the LLM. */
  authToken?: string;
  /** Injectable fetch for testing; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export async function callMcpTool(opts: CallMcpToolOptions): Promise<McpToolResult> {
  const doFetch = opts.fetchImpl ?? fetch;

  // R3-FG-60: strip any caller-supplied auth_token, then inject the trusted one.
  const sanitized = Object.fromEntries(
    Object.entries(opts.args ?? {}).filter(([k]) => k !== 'auth_token'),
  );
  const argumentsWithAuth = opts.authToken
    ? { ...sanitized, auth_token: opts.authToken }
    : sanitized;

  const res = await doFetch(`${opts.origin}/api/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: opts.toolName, arguments: argumentsWithAuth },
    }),
  });

  const body = (await res.json()) as McpJsonRpcResponse;

  if (body.error) {
    const text = body.error.message;
    return { text, isError: true, json: { error: text } };
  }

  const text = (body.result?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON — leave `json` as the raw text string.
  }

  return { text, isError: body.result?.isError ?? false, json };
}
