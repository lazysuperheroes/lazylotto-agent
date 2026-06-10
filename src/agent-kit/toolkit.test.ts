import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Strip comments so the guards check actual CODE, not documentation. (toolkit.ts
// deliberately *names* the forbidden plugins in a comment to explain why they
// are excluded — that mention must not trip these tests.)
const codeOnly = readFileSync(join(import.meta.dirname, 'toolkit.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
  .replace(/\/\/[^\n]*/g, ''); // line comments

// revert-proof: the chat toolkit must NEVER load a MUTATING core plugin (nor
// `allCorePlugins`). That exclusion is the structural guarantee that the chat
// LLM has no Agent Kit tool able to move value — all value movement goes
// through the custodial MCP plugin (the audited path). Source-level guard so it
// can't be silently defeated by a future edit.
test('chat toolkit loads NO mutating Hedera Agent Kit plugins', () => {
  const forbidden = [
    'coreAccountPlugin',
    'coreTokenPlugin',
    'coreConsensusPlugin',
    'coreEVMPlugin',
    'allCorePlugins',
  ];
  for (const name of forbidden) {
    // Word boundary: `coreAccountPlugin` must not match the read-only
    // `coreAccountQueryPlugin`.
    const re = new RegExp(`\\b${name}\\b`);
    assert.ok(!re.test(codeOnly), `toolkit.ts code must not reference ${name}`);
  }
});

// revert-proof: the toolkit MUST load the custodial plugin (so the chat can act
// for the signed-in user) plus the read-only account/token query plugins.
test('chat toolkit loads the custodial plugin + read-only query plugins', () => {
  assert.ok(/createLazyLottoPlugin\(/.test(codeOnly), 'must load custodial plugin');
  assert.ok(/\bcoreAccountQueryPlugin\b/.test(codeOnly), 'must load account query plugin');
  assert.ok(/\bcoreTokenQueryPlugin\b/.test(codeOnly), 'must load token query plugin');
});
