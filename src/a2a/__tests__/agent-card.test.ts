/**
 * Agent Card validation tests.
 *
 * Ensures the Agent Card is structurally valid and that every MCP
 * tool the serverless endpoint exposes has a corresponding A2A skill.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentCard, getSkillIds } from '../agent-card.js';

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

  it('includes all multi-user tools', () => {
    const ids = getSkillIds();
    const multiUserTools = [
      'multi_user_status',
      'multi_user_register',
      'multi_user_deposit_info',
      'multi_user_play',
      'multi_user_withdraw',
      'multi_user_deregister',
      'multi_user_play_history',
    ];
    for (const tool of multiUserTools) {
      assert.ok(ids.has(tool), `Missing multi-user skill: ${tool}`);
    }
  });

  it('includes all operator tools', () => {
    const ids = getSkillIds();
    const operatorTools = [
      'operator_balance',
      'operator_withdraw_fees',
      'operator_reconcile',
      'operator_dead_letters',
      'operator_refund',
      'operator_recover_stuck_prizes',
      'operator_health',
    ];
    for (const tool of operatorTools) {
      assert.ok(ids.has(tool), `Missing operator skill: ${tool}`);
    }
  });

  it('has exactly 14 skills (7 multi-user + 7 operator)', () => {
    assert.equal(card.skills.length, 14);
  });
});
