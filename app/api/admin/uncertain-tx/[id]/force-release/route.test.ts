/**
 * Unit tests for pure helpers extracted from the force-release route.
 * The full route handler couples Next.js + withStore + getAgentContext +
 * requireTier + checkRateLimit + getRedis + lookupMirrorOutcome, which
 * is a lot of mocking surface. The audit-fix work extracts pure helpers
 * that encode the safety-critical rules; those are tested here in
 * isolation.
 */

import { describe, it, expect } from 'vitest';
import { requiresAckOverride, type MirrorOutcome } from './route';

describe('requiresAckOverride — F3 strict-boolean ack guard', () => {
  // Audit I-02: the previous check `!body.acknowledgeDoubleSpendRisk`
  // accepted any truthy value including the string "false" (truthy).
  // A buggy admin UI sending form-text values could accidentally
  // bypass the SUCCESS double-spend refusal. After F3, ONLY the
  // strict boolean `true` acknowledges the risk.

  const truthyNonBooleans: Array<{ name: string; value: unknown }> = [
    { name: '"false" string', value: 'false' },
    { name: '"true" string', value: 'true' },
    { name: '"yes" string', value: 'yes' },
    { name: 'number 1', value: 1 },
    { name: 'number 0', value: 0 },
    { name: 'empty object', value: {} },
    { name: 'array [true]', value: [true] },
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
    { name: 'boolean false', value: false },
  ];

  for (const { name, value } of truthyNonBooleans) {
    it(`SUCCESS + ack=${name} requires override (rejects)`, () => {
      expect(requiresAckOverride('SUCCESS', value)).toBe(true);
    });
  }

  it('SUCCESS + ack=true does NOT require override (proceeds)', () => {
    expect(requiresAckOverride('SUCCESS', true)).toBe(false);
  });

  it('transient + ack=true does NOT require override (proceeds)', () => {
    expect(requiresAckOverride('transient', true)).toBe(false);
  });

  it('transient + ack="false" requires override (rejects)', () => {
    expect(requiresAckOverride('transient', 'false')).toBe(true);
  });

  for (const safe of ['FAILED', 'NOT_FOUND'] as MirrorOutcome[]) {
    it(`${safe} never requires override regardless of ack`, () => {
      expect(requiresAckOverride(safe, undefined)).toBe(false);
      expect(requiresAckOverride(safe, false)).toBe(false);
      expect(requiresAckOverride(safe, true)).toBe(false);
      expect(requiresAckOverride(safe, 'false')).toBe(false);
    });
  }
});
