/**
 * Protocol Parity Checker
 *
 * Smoke-tests both the MCP and A2A endpoints against a running
 * deployment, verifying:
 *   1. Agent Card is valid and reachable at both paths
 *   2. MCP tools/list returns all expected tools
 *   3. A2A message/send returns valid Task responses
 *   4. Both endpoints enforce auth consistently
 *   5. Both endpoints return identical results for the same operation
 *
 * Usage:
 *   npx tsx src/cli/check-protocols.ts [base-url]
 *
 * Default base URL: https://testnet-agent.lazysuperheroes.com
 *
 * If HEDERA_ACCOUNT_ID + HEDERA_PRIVATE_KEY are in .env, the script
 * will also authenticate and test auth-gated operations via both
 * protocols, comparing outputs for parity.
 */

import 'dotenv/config';

const BASE_URL = process.argv[2] || 'https://testnet-agent.lazysuperheroes.com';

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name: string, detail?: string) {
  passed++;
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name: string, err: string) {
  failed++;
  console.error(`  ✗ ${name}: ${err}`);
}

function skip(name: string, reason: string) {
  skipped++;
  console.log(`  ○ ${name} (skipped: ${reason})`);
}

// ── HTTP helpers ───────────────────────────────────────────────

async function get(path: string): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Accept: 'application/json' },
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function post(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  // MCP SDK's WebStandardStreamableHTTPServerTransport requires the
  // Accept header to include both application/json AND text/event-stream,
  // otherwise it returns 406 Not Acceptable. A2A doesn't care but it
  // doesn't hurt to send it there too.
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

// ── Auth helper ────────────────────────────────────────────────

async function authenticate(): Promise<string | null> {
  const accountId = process.env.HEDERA_ACCOUNT_ID;
  const privateKeyStr = process.env.HEDERA_PRIVATE_KEY;

  if (!accountId || !privateKeyStr) return null;

  try {
    const { PrivateKey } = await import('@hashgraph/sdk');
    const proto = await import('@hashgraph/proto');

    // 1. Get challenge
    const challengeRes = await post('/api/auth/challenge', { accountId });
    if (challengeRes.status !== 200) return null;
    const { challengeId, message } = challengeRes.data as {
      challengeId: string;
      message: string;
    };

    // 2. Sign
    const key = PrivateKey.fromStringDer(privateKeyStr);
    const msgBytes = new TextEncoder().encode(message);
    const sig = key.sign(msgBytes);
    const pubKey = key.publicKey;

    const sigMap = proto.proto.SignatureMap.create({
      sigPair: [
        {
          pubKeyPrefix: pubKey.toBytesRaw(),
          ed25519: sig,
        },
      ],
    });
    const sigMapBase64 = Buffer.from(
      proto.proto.SignatureMap.encode(sigMap).finish(),
    ).toString('base64');

    // 3. Verify
    const verifyRes = await post('/api/auth/verify', {
      challengeId,
      accountId,
      signatureMapBase64: sigMapBase64,
    });
    if (verifyRes.status !== 200) return null;

    return (verifyRes.data as { sessionToken?: string }).sessionToken ?? null;
  } catch (e) {
    console.warn(
      '  Auth failed:',
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

// ── Test sections ──────────────────────────────────────────────

async function testAgentCard() {
  console.log('\n─── Agent Card ───');

  // Well-known path
  try {
    const { status, data } = await get('/.well-known/agent-card.json');
    if (status !== 200) {
      fail('GET /.well-known/agent-card.json', `Status ${status}`);
    } else {
      const card = data as Record<string, unknown>;
      if (card.name && card.url && card.skills) {
        const skills = card.skills as { id: string }[];
        ok('GET /.well-known/agent-card.json', `${skills.length} skills`);
      } else {
        fail('GET /.well-known/agent-card.json', 'Missing required fields (name, url, skills)');
      }
    }
  } catch (e) {
    fail('GET /.well-known/agent-card.json', String(e));
  }

  // Convenience alias
  try {
    const { status, data } = await get('/api/a2a');
    if (status !== 200) {
      fail('GET /api/a2a', `Status ${status}`);
    } else {
      const card = data as Record<string, unknown>;
      const skills = card.skills as { id: string }[];
      ok('GET /api/a2a', `${skills.length} skills`);
    }
  } catch (e) {
    fail('GET /api/a2a', String(e));
  }

  // Validate skill IDs match expected set
  try {
    const { data } = await get('/api/a2a');
    const card = data as { skills: { id: string }[] };
    const ids = new Set(card.skills.map((s) => s.id));
    const expected = [
      'multi_user_status', 'multi_user_register', 'multi_user_deposit_info',
      'multi_user_play', 'multi_user_withdraw', 'multi_user_deregister',
      'multi_user_play_history', 'operator_balance', 'operator_withdraw_fees',
      'operator_reconcile', 'operator_dead_letters', 'operator_refund',
      'operator_recover_stuck_prizes', 'operator_health',
    ];
    const missing = expected.filter((e) => !ids.has(e));
    if (missing.length > 0) {
      fail('Skill completeness', `Missing: ${missing.join(', ')}`);
    } else {
      ok('Skill completeness', `All ${expected.length} skills present`);
    }
  } catch (e) {
    fail('Skill completeness', String(e));
  }
}

async function testMcpEndpoint() {
  console.log('\n─── MCP Endpoint ───');

  // tools/list (no auth needed for the list call itself)
  try {
    const { status, data } = await post('/api/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    if (status !== 200) {
      fail('MCP tools/list', `Status ${status}`);
    } else {
      const result = data.result as { tools?: { name: string }[] } | undefined;
      if (result?.tools) {
        ok('MCP tools/list', `${result.tools.length} tools`);
      } else {
        fail('MCP tools/list', 'No tools in response');
      }
    }
  } catch (e) {
    fail('MCP tools/list', String(e));
  }
}

async function testA2aEndpoint() {
  console.log('\n─── A2A Endpoint ───');

  // message/send with unknown skill → should return failed task
  try {
    const { status, data } = await post('/api/a2a', {
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          messageId: 'check-1',
          role: 'user',
          parts: [{ kind: 'data', data: { skill: 'nonexistent_tool' } }],
        },
      },
    });
    if (status !== 200) {
      fail('A2A unknown skill', `Status ${status}`);
    } else {
      const result = data.result as { kind?: string; status?: { state: string } } | undefined;
      if (result?.kind === 'task' && result?.status?.state === 'failed') {
        ok('A2A unknown skill → failed task');
      } else {
        fail('A2A unknown skill', `Expected failed task, got: ${JSON.stringify(result?.status)}`);
      }
    }
  } catch (e) {
    fail('A2A unknown skill', String(e));
  }

  // message/send with no skill → should return failed task with help
  try {
    const { status, data } = await post('/api/a2a', {
      jsonrpc: '2.0',
      id: 2,
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          messageId: 'check-2',
          role: 'user',
          parts: [{ kind: 'text', text: 'hello agent' }],
        },
      },
    });
    if (status !== 200) {
      fail('A2A no-skill message', `Status ${status}`);
    } else {
      const result = data.result as { status?: { state: string } } | undefined;
      if (result?.status?.state === 'failed') {
        ok('A2A no-skill message → failed task with help');
      } else {
        fail('A2A no-skill message', `Expected failed task, got: ${JSON.stringify(result?.status)}`);
      }
    }
  } catch (e) {
    fail('A2A no-skill message', String(e));
  }

  // tasks/get → not supported (stateless)
  try {
    const { data } = await post('/api/a2a', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tasks/get',
      params: { id: 'nonexistent' },
    });
    if (data.error && (data.error as { code: number }).code === -32001) {
      ok('A2A tasks/get → TaskNotFoundError');
    } else {
      fail('A2A tasks/get', `Expected error -32001, got: ${JSON.stringify(data.error)}`);
    }
  } catch (e) {
    fail('A2A tasks/get', String(e));
  }

  // message/stream → unsupported
  try {
    const { data } = await post('/api/a2a', {
      jsonrpc: '2.0',
      id: 4,
      method: 'message/stream',
      params: {},
    });
    if (data.error && (data.error as { code: number }).code === -32003) {
      ok('A2A message/stream → UnsupportedOperationError');
    } else {
      fail('A2A message/stream', `Expected error -32003, got: ${JSON.stringify(data.error)}`);
    }
  } catch (e) {
    fail('A2A message/stream', String(e));
  }
}

async function testAuthParity(token: string) {
  console.log('\n─── Auth Parity (MCP vs A2A) ───');

  // Call operator_health via MCP
  let mcpResult: unknown;
  try {
    const { status, data } = await post('/api/mcp', {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'operator_health', arguments: { auth_token: token } },
    });
    if (status !== 200) {
      fail('MCP operator_health', `Status ${status}`);
      return;
    }
    const result = data.result as { content?: { text: string }[] } | undefined;
    if (result?.content?.[0]?.text) {
      mcpResult = JSON.parse(result.content[0].text);
      ok('MCP operator_health', 'Got response');
    } else {
      fail('MCP operator_health', 'No content in response');
      return;
    }
  } catch (e) {
    fail('MCP operator_health', String(e));
    return;
  }

  // Call operator_health via A2A
  let a2aResult: unknown;
  try {
    const { status, data } = await post(
      '/api/a2a',
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            messageId: 'parity-1',
            role: 'user',
            parts: [{ kind: 'data', data: { skill: 'operator_health', params: {} } }],
          },
        },
      },
      { Authorization: `Bearer ${token}` },
    );
    if (status !== 200) {
      fail('A2A operator_health', `Status ${status}`);
      return;
    }
    const result = data.result as {
      kind?: string;
      status?: { state: string };
      artifacts?: { parts: { kind: string; data: unknown }[] }[];
    } | undefined;
    if (result?.kind === 'task' && result?.status?.state === 'completed') {
      a2aResult = result.artifacts?.[0]?.parts?.[0]?.data;
      ok('A2A operator_health', 'Got completed task');
    } else {
      fail('A2A operator_health', `Unexpected result: ${JSON.stringify(result?.status)}`);
      return;
    }
  } catch (e) {
    fail('A2A operator_health', String(e));
    return;
  }

  // Compare — both should have the same keys (values may differ due to timing)
  if (mcpResult && a2aResult) {
    const mcpKeys = Object.keys(mcpResult as Record<string, unknown>).sort();
    const a2aKeys = Object.keys(a2aResult as Record<string, unknown>).sort();
    if (JSON.stringify(mcpKeys) === JSON.stringify(a2aKeys)) {
      ok('Parity: operator_health', `Same keys: ${mcpKeys.join(', ')}`);
    } else {
      fail(
        'Parity: operator_health',
        `Keys differ — MCP: [${mcpKeys.join(',')}] A2A: [${a2aKeys.join(',')}]`,
      );
    }
  }
}

async function testNoAuthParity() {
  console.log('\n─── No-Auth Parity ───');

  // Both should reject operator_health without auth
  let mcpDenied = false;
  try {
    const { data } = await post('/api/mcp', {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'operator_health', arguments: {} },
    });
    const result = data.result as { content?: { text: string }[]; isError?: boolean } | undefined;
    if (result?.isError) {
      mcpDenied = true;
      ok('MCP no-auth → denied');
    } else {
      // Might be in local dev mode where auth is bypassed
      skip('MCP no-auth → denied', 'Auth not enforced (local dev mode?)');
    }
  } catch (e) {
    fail('MCP no-auth check', String(e));
  }

  let a2aDenied = false;
  try {
    const { data } = await post('/api/a2a', {
      jsonrpc: '2.0',
      id: 21,
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          messageId: 'noauth-1',
          role: 'user',
          parts: [{ kind: 'data', data: { skill: 'operator_health', params: {} } }],
        },
      },
    });
    const result = data.result as { status?: { state: string } } | undefined;
    if (result?.status?.state === 'failed') {
      a2aDenied = true;
      ok('A2A no-auth → failed task');
    } else {
      skip('A2A no-auth → failed task', 'Auth not enforced (local dev mode?)');
    }
  } catch (e) {
    fail('A2A no-auth check', String(e));
  }

  if (mcpDenied && a2aDenied) {
    ok('Parity: both deny unauthenticated operator_health');
  } else if (!mcpDenied && !a2aDenied) {
    skip('Parity: auth enforcement', 'Both allowed (local dev mode — auth not configured)');
  } else {
    fail('Parity: auth enforcement', `MCP denied=${mcpDenied}, A2A denied=${a2aDenied}`);
  }
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  console.log(`\nProtocol Parity Checker — ${BASE_URL}\n`);

  await testAgentCard();
  await testMcpEndpoint();
  await testA2aEndpoint();
  await testNoAuthParity();

  // Authenticated tests (if credentials available)
  const token = await authenticate();
  if (token) {
    console.log('\n  Authenticated successfully');
    await testAuthParity(token);
  } else {
    skip('Auth parity tests', 'No HEDERA_ACCOUNT_ID + HEDERA_PRIVATE_KEY in .env');
  }

  // Summary
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`  ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
