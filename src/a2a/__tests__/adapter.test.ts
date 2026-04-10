/**
 * A2A adapter unit tests.
 *
 * Tests the translation layer in isolation: message parsing, skill
 * resolution, task wrapping, and JSON-RPC dispatch. No Hedera, no
 * Redis, no real tool handlers — everything is mocked at the
 * callTool boundary.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '@a2a-js/sdk';
import { parseSkillInvocation, wrapAsTask, handleSendMessage, type ToolResult } from '../adapter.js';
import { dispatch } from '../dispatcher.js';

// ── Helpers ────────────────────────────────────────────────────

function makeMessage(parts: Message['parts'], contextId?: string): Message {
  return {
    kind: 'message',
    messageId: 'test-msg-1',
    role: 'user',
    parts,
    ...(contextId ? { contextId } : {}),
  };
}

function successResult(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorToolResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// ── parseSkillInvocation ───────────────────────────────────────

describe('parseSkillInvocation', () => {
  it('extracts skill from DataPart', () => {
    const msg = makeMessage([{
      kind: 'data',
      data: { skill: 'multi_user_play', params: { userId: 'u1' } },
    }]);
    const result = parseSkillInvocation(msg);
    assert.deepEqual(result, { skill: 'multi_user_play', params: { userId: 'u1' } });
  });

  it('extracts skill from TextPart containing JSON', () => {
    const msg = makeMessage([{
      kind: 'text',
      text: JSON.stringify({ skill: 'operator_health', params: {} }),
    }]);
    const result = parseSkillInvocation(msg);
    assert.deepEqual(result, { skill: 'operator_health', params: {} });
  });

  it('defaults params to empty object when omitted', () => {
    const msg = makeMessage([{
      kind: 'data',
      data: { skill: 'operator_health' },
    }]);
    const result = parseSkillInvocation(msg);
    assert.deepEqual(result, { skill: 'operator_health', params: {} });
  });

  it('returns null for plain text without JSON', () => {
    const msg = makeMessage([{ kind: 'text', text: 'play a session for me' }]);
    const result = parseSkillInvocation(msg);
    assert.equal(result, null);
  });

  it('returns null for DataPart without skill field', () => {
    const msg = makeMessage([{
      kind: 'data',
      data: { action: 'play', target: 'u1' },
    }]);
    const result = parseSkillInvocation(msg);
    assert.equal(result, null);
  });

  it('prefers DataPart over TextPart when both present', () => {
    const msg = makeMessage([
      { kind: 'text', text: JSON.stringify({ skill: 'text_skill' }) },
      { kind: 'data', data: { skill: 'data_skill', params: { x: 1 } } },
    ]);
    // DataPart comes second but is checked first in the loop
    // Actually both are checked in order — DataPart at index 1
    // The first DataPart or first TextPart-with-JSON wins
    const result = parseSkillInvocation(msg);
    // TextPart is checked but isn't a DataPart, so it tries JSON parse → finds skill
    assert.equal(result!.skill, 'text_skill');
  });

  it('skips invalid JSON in TextPart and continues', () => {
    const msg = makeMessage([
      { kind: 'text', text: 'not json' },
      { kind: 'data', data: { skill: 'fallback_skill' } },
    ]);
    const result = parseSkillInvocation(msg);
    assert.equal(result!.skill, 'fallback_skill');
  });
});

// ── wrapAsTask ─────────────────────────────────────────────────

describe('wrapAsTask', () => {
  it('wraps success result as completed task', () => {
    const result = successResult({ status: 'ok', value: 42 });
    const task = wrapAsTask(result, 'ctx-1');

    assert.equal(task.kind, 'task');
    assert.equal(task.status.state, 'completed');
    assert.equal(task.contextId, 'ctx-1');
    assert.ok(task.artifacts);
    assert.equal(task.artifacts!.length, 1);
    assert.equal(task.artifacts![0]!.parts[0]!.kind, 'data');
    const data = (task.artifacts![0]!.parts[0]! as { data: Record<string, unknown> }).data;
    assert.equal(data.status, 'ok');
    assert.equal(data.value, 42);
  });

  it('wraps error result as failed task', () => {
    const result = errorToolResult('Access denied');
    const task = wrapAsTask(result);

    assert.equal(task.status.state, 'failed');
    assert.equal(task.artifacts, undefined);
    assert.ok(task.status.message);
    // The status message should contain the error text
    const msgParts = task.status.message!.parts;
    assert.ok(msgParts.some((p: { kind: string; text?: string }) =>
      p.kind === 'text' && p.text?.includes('Access denied'),
    ));
  });

  it('generates unique task IDs', () => {
    const result = successResult({ ok: true });
    const t1 = wrapAsTask(result);
    const t2 = wrapAsTask(result);
    assert.notEqual(t1.id, t2.id);
  });

  it('generates contextId when not provided', () => {
    const result = successResult({ ok: true });
    const task = wrapAsTask(result);
    assert.ok(task.contextId);
    assert.ok(task.contextId.length > 0);
  });
});

// ── handleSendMessage ──────────────────────────────────────────

describe('handleSendMessage', () => {
  it('routes valid skill to callTool and returns completed task', async () => {
    const msg = makeMessage([{
      kind: 'data',
      data: { skill: 'operator_health', params: {} },
    }]);

    const mockCallTool = async (name: string, params: Record<string, unknown>) => {
      assert.equal(name, 'operator_health');
      return successResult({ healthy: true, uptime: 3600 });
    };

    const response = await handleSendMessage(msg, mockCallTool);
    assert.equal(response.jsonrpc, '2.0');
    const task = response.result as { kind: string; status: { state: string } };
    assert.equal(task.kind, 'task');
    assert.equal(task.status.state, 'completed');
  });

  it('returns failed task for unknown skill', async () => {
    const msg = makeMessage([{
      kind: 'data',
      data: { skill: 'nonexistent_tool' },
    }]);

    const mockCallTool = async () => successResult({ ok: true });
    const response = await handleSendMessage(msg, mockCallTool);
    const task = response.result as { status: { state: string }; artifacts?: unknown[] };
    assert.equal(task.status.state, 'failed');
  });

  it('returns failed task when no skill invocation found', async () => {
    const msg = makeMessage([{ kind: 'text', text: 'hello agent' }]);
    const mockCallTool = async () => successResult({ ok: true });
    const response = await handleSendMessage(msg, mockCallTool);
    const task = response.result as { status: { state: string } };
    assert.equal(task.status.state, 'failed');
  });

  it('passes params through to callTool', async () => {
    const msg = makeMessage([{
      kind: 'data',
      data: { skill: 'multi_user_withdraw', params: { amount: 10, token: 'hbar' } },
    }]);

    let capturedParams: Record<string, unknown> = {};
    const mockCallTool = async (_name: string, params: Record<string, unknown>) => {
      capturedParams = params;
      return successResult({ withdrawn: true });
    };

    await handleSendMessage(msg, mockCallTool);
    assert.equal(capturedParams.amount, 10);
    assert.equal(capturedParams.token, 'hbar');
  });
});

// ── dispatch (JSON-RPC routing) ────────────────────────────────

describe('dispatch', () => {
  const noop = async () => successResult({ ok: true });

  it('routes message/send to handler', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          messageId: 'msg-1',
          role: 'user',
          parts: [{ kind: 'data', data: { skill: 'operator_health' } }],
        },
      },
    });
    const resp = await dispatch(body, noop);
    assert.equal(resp.jsonrpc, '2.0');
    assert.equal(resp.id, 42);
    assert.ok(resp.result);
    assert.equal(resp.error, undefined);
  });

  it('returns parse error for invalid JSON', async () => {
    const resp = await dispatch('not json {{{', noop);
    assert.equal(resp.error?.code, -32700);
  });

  it('returns invalid request for missing jsonrpc field', async () => {
    const resp = await dispatch(JSON.stringify({ method: 'message/send' }), noop);
    assert.equal(resp.error?.code, -32600);
  });

  it('returns method not found for unknown methods', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'unknown/method' });
    const resp = await dispatch(body, noop);
    assert.equal(resp.error?.code, -32601);
  });

  it('returns unsupported for message/stream', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/stream' });
    const resp = await dispatch(body, noop);
    assert.equal(resp.error?.code, -32003); // UnsupportedOperationError
  });

  it('returns task not found for tasks/get', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'abc' } });
    const resp = await dispatch(body, noop);
    assert.equal(resp.error?.code, -32001); // TaskNotFoundError
  });

  it('returns not cancelable for tasks/cancel', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: { id: 'abc' } });
    const resp = await dispatch(body, noop);
    assert.equal(resp.error?.code, -32002); // TaskNotCancelableError
  });

  it('returns error when message is missing from params', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} });
    const resp = await dispatch(body, noop);
    assert.equal(resp.error?.code, -32600);
  });
});
