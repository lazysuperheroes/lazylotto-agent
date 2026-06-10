import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@hashgraph/hedera-agent-kit';
import type { Client } from '@hiero-ledger/sdk';
import { createLazyLottoPlugin } from './plugin.js';

const OPTS = { origin: 'http://localhost:3000', authToken: 'sk_test' };
const CTX = {} as Context;
const CLIENT = {} as Client;

function methodsFor(allowPlay?: boolean): string[] {
  const plugin = createLazyLottoPlugin({ ...OPTS, allowPlay });
  // `tools` is a (context) => Tool[] factory on the kit Plugin shape.
  return (plugin.tools as (c: Context) => Array<{ method: string }>)(CTX).map(
    (t) => t.method,
  );
}

// revert-proof: the chat plugin is READ-ONLY by default. If the `allowPlay`
// gate around the play tool is removed, multi_user_play would always be present
// and this assertion fails.
test('plugin omits multi_user_play by default (read-only chat)', () => {
  const methods = methodsFor(/* allowPlay */ undefined);
  assert.ok(!methods.includes('multi_user_play'), 'play absent without allowPlay');
  assert.ok(methods.includes('multi_user_deposit_info'));
  assert.ok(methods.includes('multi_user_play_history'));
});

test('plugin includes multi_user_play only when allowPlay is set', () => {
  assert.ok(methodsFor(true).includes('multi_user_play'), 'play present when allowPlay');
});

// revert-proof: the play tool MUST refuse to play unless confirm===true. If the
// two-step confirm gate is removed, execute() with confirm:false would fall
// through to callMcpTool (a network call to /api/mcp). Asserting the synchronous
// `confirmation_required` return both proves the gate AND that no MCP call fires
// (there is no server in this unit test).
test('multi_user_play returns confirmation_required without confirm=true', async () => {
  const plugin = createLazyLottoPlugin({ ...OPTS, allowPlay: true });
  const tools = (plugin.tools as (c: Context) => Array<{
    method: string;
    execute: (
      client: Client,
      ctx: Context,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
  }>)(CTX);
  const play = tools.find((t) => t.method === 'multi_user_play');
  assert.ok(play, 'play tool present');

  const explicitFalse = (await play!.execute(CLIENT, CTX, { confirm: false })) as {
    status?: string;
  };
  assert.equal(explicitFalse.status, 'confirmation_required');

  const missing = (await play!.execute(CLIENT, CTX, {})) as { status?: string };
  assert.equal(missing.status, 'confirmation_required');
});
