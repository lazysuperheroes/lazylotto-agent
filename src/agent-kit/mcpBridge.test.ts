import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callMcpTool } from './mcpBridge.js';

/** A fake fetch that records the JSON-RPC body and returns a canned response. */
function fakeFetch(
  captured: { url?: string; body?: any },
  responseJson: unknown,
): typeof fetch {
  return (async (url: unknown, init: { body: string }) => {
    captured.url = String(url);
    captured.body = JSON.parse(init.body);
    return { json: async () => responseJson } as Response;
  }) as unknown as typeof fetch;
}

// revert-proof: the chat→MCP bridge MUST strip a caller/LLM-supplied auth_token
// and inject the trusted server-derived token (R3-FG-60). Reverting this would
// let a prompt-injected tool argument smuggle a victim's session token.
test('callMcpTool strips a caller-supplied auth_token and injects the trusted one (R3-FG-60)', async () => {
  const captured: { body?: any } = {};
  await callMcpTool({
    origin: 'https://x.test',
    toolName: 'multi_user_deposit_info',
    args: { auth_token: 'sk_ATTACKER', userId: 'victim' },
    authToken: 'sk_TRUSTED',
    fetchImpl: fakeFetch(captured, {
      result: { content: [{ type: 'text', text: '{}' }] },
    }),
  });
  const args = captured.body.params.arguments;
  assert.equal(args.auth_token, 'sk_TRUSTED'); // trusted token wins
  assert.equal(args.userId, 'victim'); // non-auth args preserved
});

// revert-proof: with no trusted token, NO auth_token may reach the MCP call —
// an LLM-supplied one must not pass through unauthenticated.
test('callMcpTool omits auth_token entirely when none is provided (no smuggling)', async () => {
  const captured: { body?: any } = {};
  await callMcpTool({
    origin: 'https://x.test',
    toolName: 'multi_user_play_history',
    args: { auth_token: 'sk_SMUGGLED' },
    fetchImpl: fakeFetch(captured, {
      result: { content: [{ type: 'text', text: '{}' }] },
    }),
  });
  assert.equal('auth_token' in captured.body.params.arguments, false);
});

// revert-proof: the bridge must call our OWN /api/mcp endpoint with a JSON-RPC
// tools/call — this is what gives parity-by-construction with every other MCP
// caller (auth tiers, idempotency, HCS-20). Don't bypass it with an in-process
// call.
test('callMcpTool targets /api/mcp at the given origin with a tools/call', async () => {
  const captured: { url?: string; body?: any } = {};
  await callMcpTool({
    origin: 'https://x.test',
    toolName: 'multi_user_play_history',
    args: { limit: 5 },
    fetchImpl: fakeFetch(captured, { result: { content: [] } }),
  });
  assert.equal(captured.url, 'https://x.test/api/mcp');
  assert.equal(captured.body.method, 'tools/call');
  assert.equal(captured.body.params.name, 'multi_user_play_history');
  assert.equal(captured.body.params.arguments.limit, 5);
});

// revert-proof: JSON tool output must be parsed so the LLM receives structured
// data, not an opaque string.
test('callMcpTool parses JSON text content into .json', async () => {
  const captured: { body?: any } = {};
  const r = await callMcpTool({
    origin: 'https://x.test',
    toolName: 'multi_user_deposit_info',
    args: {},
    fetchImpl: fakeFetch(captured, {
      result: { content: [{ type: 'text', text: '{"balances":{"hbar":5}}' }] },
    }),
  });
  assert.deepEqual(r.json, { balances: { hbar: 5 } });
  assert.equal(r.isError, false);
});

// revert-proof: JSON-RPC transport errors must surface as isError=true so the
// chat agent never treats a failure as success.
test('callMcpTool surfaces MCP JSON-RPC errors', async () => {
  const captured: { body?: any } = {};
  const r = await callMcpTool({
    origin: 'https://x.test',
    toolName: 'multi_user_deposit_info',
    args: {},
    fetchImpl: fakeFetch(captured, { error: { message: 'boom' } }),
  });
  assert.equal(r.isError, true);
  assert.deepEqual(r.json, { error: 'boom' });
});

// revert-proof: a tool-level isError (e.g. "Access denied" from tier
// enforcement) must propagate as isError=true, not be swallowed.
test('callMcpTool flags a tool-level isError result', async () => {
  const captured: { body?: any } = {};
  const r = await callMcpTool({
    origin: 'https://x.test',
    toolName: 'multi_user_play_history',
    args: {},
    fetchImpl: fakeFetch(captured, {
      result: { content: [{ type: 'text', text: 'Access denied' }], isError: true },
    }),
  });
  assert.equal(r.isError, true);
  assert.equal(r.text, 'Access denied');
});
