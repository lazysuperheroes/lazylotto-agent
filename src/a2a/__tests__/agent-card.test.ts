/**
 * Agent Card validation tests.
 *
 * Ensures the Agent Card is structurally valid and that every MCP
 * tool the serverless endpoint exposes has a corresponding A2A skill,
 * with the canonical tool-name list (`src/mcp/tool-names.ts`) as the
 * single source of truth.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentCard, getSkillIds } from '../agent-card.js';
import {
  MULTI_USER_TOOL_NAMES,
  OPERATOR_TOOL_NAMES,
  ALL_REMOTE_TOOL_NAMES,
} from '../../mcp/tool-names.js';

describe('buildAgentCard', () => {
  const card = buildAgentCard();

  it('has required top-level fields', () => {
    assert.ok(card.name);
    assert.ok(card.description);
    assert.ok(card.url);
    assert.ok(card.version);
    assert.ok(card.protocolVersion);
    assert.ok(card.capabilities);
    assert.ok(card.skills);
    assert.ok(Array.isArray(card.skills));
    assert.ok(card.skills.length > 0);
  });

  it('declares JSON input/output modes', () => {
    assert.ok(card.defaultInputModes.includes('application/json'));
    assert.ok(card.defaultOutputModes.includes('application/json'));
  });

  it('declares Bearer auth security scheme', () => {
    assert.ok(card.securitySchemes);
    assert.ok(card.securitySchemes!.bearer);
    const bearer = card.securitySchemes!.bearer as { type: string; scheme: string };
    assert.equal(bearer.type, 'http');
    assert.equal(bearer.scheme, 'bearer');
  });

  it('does not advertise streaming (Phase 1)', () => {
    assert.equal(card.capabilities.streaming, false);
  });

  it('does not advertise push notifications (Phase 1)', () => {
    assert.equal(card.capabilities.pushNotifications, false);
  });

  it('has a valid provider', () => {
    assert.ok(card.provider);
    assert.ok(card.provider!.organization);
    assert.ok(card.provider!.url);
  });

  it('url points to /api/a2a', () => {
    assert.ok(card.url.endsWith('/api/a2a'));
  });
});

describe('Agent Card skills', () => {
  const card = buildAgentCard();

  it('every skill has required fields', () => {
    for (const skill of card.skills) {
      assert.ok(skill.id, `skill missing id`);
      assert.ok(skill.name, `skill ${skill.id} missing name`);
      assert.ok(skill.description, `skill ${skill.id} missing description`);
      assert.ok(Array.isArray(skill.tags), `skill ${skill.id} missing tags`);
      assert.ok(skill.tags.length > 0, `skill ${skill.id} has empty tags`);
    }
  });

  it('skill IDs are unique', () => {
    const ids = card.skills.map((s) => s.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, `Duplicate skill IDs: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
  });

  it('includes every multi-user tool from the canonical list', () => {
    const ids = getSkillIds();
    for (const tool of MULTI_USER_TOOL_NAMES) {
      assert.ok(ids.has(tool), `Missing multi-user skill: ${tool}`);
    }
  });

  it('includes every operator tool from the canonical list', () => {
    const ids = getSkillIds();
    for (const tool of OPERATOR_TOOL_NAMES) {
      assert.ok(ids.has(tool), `Missing operator skill: ${tool}`);
    }
  });

  // Strict drift-prevention test. If a new MCP tool ships, the canonical
  // list must be updated AND the A2A skill must be added; if a skill is
  // removed without removing the tool (or vice versa) this fires loudly.
  // This is the test that should have caught the multi_user_set_strategy
  // gap in the original c0fa099 commit.
  it('A2A skill set EQUALS the canonical MCP tool list (no drift in either direction)', () => {
    const skillIds = Array.from(getSkillIds()).sort();
    const expected = [...ALL_REMOTE_TOOL_NAMES].sort();
    assert.deepEqual(
      skillIds,
      expected,
      `A2A skills drifted from src/mcp/tool-names.ts. ` +
        `If you added an MCP tool, also add the matching skill in src/a2a/agent-card.ts. ` +
        `If you removed one, remove it from both places.`,
    );
  });

  it('skill count matches the canonical list', () => {
    assert.equal(card.skills.length, ALL_REMOTE_TOOL_NAMES.length);
  });
});
