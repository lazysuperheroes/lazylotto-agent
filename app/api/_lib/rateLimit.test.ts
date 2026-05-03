/**
 * F7 — rate-limit identity keying.
 *
 * Verifies that identityFor() picks the trustworthy edge-set value for
 * x-forwarded-for and that body fields cannot enter the key. The test
 * proves the spoof model: even if a client sends `x-forwarded-for:
 * 1.2.3.4` directly, on Vercel the edge prepends the real client IP
 * so that's what we'd see in practice. We test that the FIRST entry
 * is what's used, mirroring how the edge-set value lands.
 */

import { describe, it, expect } from 'vitest';
import { identityFor } from './rateLimit';

function makeRequest(headers: Record<string, string>): Request {
  return new Request('https://example.com/api/test', {
    method: 'POST',
    headers: new Headers(headers),
  });
}

describe('identityFor', () => {
  it('returns Bearer token prefix when present', () => {
    const req = makeRequest({ authorization: 'Bearer sk_token_abc1234567890extra' });
    // First 16 chars after "Bearer "
    expect(identityFor(req)).toBe('sk_token_abc1234');
  });

  it('falls back to x-forwarded-for[0] when no Bearer token', () => {
    const req = makeRequest({ 'x-forwarded-for': '203.0.113.42' });
    expect(identityFor(req)).toBe('203.0.113.42');
  });

  it('takes only the FIRST entry when x-forwarded-for is a chain', () => {
    // Vercel edge prepends the real client IP; the rest is upstream chain.
    const req = makeRequest({ 'x-forwarded-for': '203.0.113.42, 10.0.0.1, 192.168.1.1' });
    expect(identityFor(req)).toBe('203.0.113.42');
  });

  it('strips whitespace around the first entry', () => {
    const req = makeRequest({ 'x-forwarded-for': '  203.0.113.42  , 10.0.0.1' });
    expect(identityFor(req)).toBe('203.0.113.42');
  });

  it("returns 'unknown' when no header is set", () => {
    const req = makeRequest({});
    expect(identityFor(req)).toBe('unknown');
  });

  it('Bearer token wins over x-forwarded-for', () => {
    const req = makeRequest({
      authorization: 'Bearer sk_real_session_abc1234',
      'x-forwarded-for': '203.0.113.42',
    });
    expect(identityFor(req)).toBe('sk_real_session_');
  });

  // Spoof model: even if a malicious request body claims a different
  // accountId, the rate-limit key never reads the body. This test
  // documents that contract.
  it('does not consider request body fields (accountId-rotation cannot fan out)', async () => {
    const req = new Request('https://example.com/api/test', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.42', 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: '0.0.attacker', spoofedField: '0.0.victim' }),
    });
    // identityFor must not consume the body — it should still be readable downstream.
    expect(identityFor(req)).toBe('203.0.113.42');
    const body = await req.json();
    expect(body.accountId).toBe('0.0.attacker');
  });
});
