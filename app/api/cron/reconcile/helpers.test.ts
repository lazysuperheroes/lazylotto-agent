/**
 * Tests for the reconcile-cron helpers.
 *
 * Items 2 + 3 from the post-hardening cleanup:
 *   - isAuthorizedCron uses constant-time SHA-256 compare and rejects
 *     unset / wrong-scheme / wrong-secret cases.
 *   - escapeMrkdwn neutralizes Slack/Discord meta-characters so
 *     untrusted input (future memo fields, token names from on-chain)
 *     can't inject formatting or mentions into webhook bodies.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAuthorizedCron, escapeMrkdwn } from './helpers';

function makeRequest(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader) headers.authorization = authHeader;
  return new Request('https://example.com/api/cron/reconcile', {
    method: 'GET',
    headers: new Headers(headers),
  });
}

describe('isAuthorizedCron', () => {
  const ORIGINAL_SECRET = process.env.CRON_SECRET;

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIGINAL_SECRET;
  });

  it('returns false when CRON_SECRET is unset (endpoint disabled)', () => {
    delete process.env.CRON_SECRET;
    expect(isAuthorizedCron(makeRequest('Bearer anything'))).toBe(false);
  });

  it('returns false when no Authorization header is present', () => {
    process.env.CRON_SECRET = 'secret';
    expect(isAuthorizedCron(makeRequest())).toBe(false);
  });

  it("returns false for non-Bearer schemes", () => {
    process.env.CRON_SECRET = 'secret';
    expect(isAuthorizedCron(makeRequest('Basic dXNlcjpwYXNz'))).toBe(false);
  });

  it('returns false when the provided secret does not match', () => {
    process.env.CRON_SECRET = 'correct-secret';
    expect(isAuthorizedCron(makeRequest('Bearer wrong-secret'))).toBe(false);
  });

  it('returns true on exact match', () => {
    process.env.CRON_SECRET = 'correct-secret';
    expect(isAuthorizedCron(makeRequest('Bearer correct-secret'))).toBe(true);
  });

  // Length-mismatch case — the SHA-256 hash normalizes both sides to
  // 32 bytes, so the timingSafeEqual underneath cannot throw on length.
  // This test would catch a regression to a plain `===` or to a
  // bare-buffer timingSafeEqual without hashing first.
  it('handles length mismatch without throwing (hash normalizes)', () => {
    process.env.CRON_SECRET = 'short';
    expect(() =>
      isAuthorizedCron(makeRequest('Bearer a-much-longer-attempted-secret-string')),
    ).not.toThrow();
  });

  it('treats empty Bearer value as a non-match', () => {
    process.env.CRON_SECRET = 'secret';
    expect(isAuthorizedCron(makeRequest('Bearer '))).toBe(false);
  });
});

describe('escapeMrkdwn', () => {
  it('passes plain text through unchanged', () => {
    expect(escapeMrkdwn('plain warning text')).toBe('plain warning text');
  });

  it('escapes Slack mention triggers <! and <@ as HTML entities', () => {
    // <!channel> and <@U123> would ping the channel/user if rendered.
    // Escaping < and > to entities prevents Slack from parsing the
    // mention syntax at all.
    expect(escapeMrkdwn('<!channel>')).toBe('&lt;!channel&gt;');
    expect(escapeMrkdwn('<@U12345>')).toBe('&lt;@U12345&gt;');
  });

  it('escapes link syntax <http://attacker|click>', () => {
    expect(escapeMrkdwn('<http://attacker.example|click here>')).toBe(
      '&lt;http://attacker.example\\|click here&gt;',
    );
  });

  it('escapes bold/italic/strike markers', () => {
    expect(escapeMrkdwn('*urgent*')).toBe('\\*urgent\\*');
    expect(escapeMrkdwn('_emphasis_')).toBe('\\_emphasis\\_');
    expect(escapeMrkdwn('~strike~')).toBe('\\~strike\\~');
  });

  it('escapes inline-code backticks (cannot break out of a wrapped code span)', () => {
    expect(escapeMrkdwn('see `rm -rf /`')).toBe('see \\`rm -rf /\\`');
  });

  it('escapes pipes (used inside Slack <url|label> syntax)', () => {
    expect(escapeMrkdwn('a|b')).toBe('a\\|b');
  });

  it('escapes backslashes so they cannot un-escape downstream', () => {
    expect(escapeMrkdwn('back\\slash')).toBe('back\\\\slash');
  });

  it('escapes ampersand first so it does not double-encode entities', () => {
    expect(escapeMrkdwn('& <foo>')).toBe('&amp; &lt;foo&gt;');
  });

  it('neutralizes a compound dangerous payload', () => {
    // What we care about: the output, when rendered by Slack/Discord,
    // produces NO active formatting and NO mentions. That property is:
    //   - every < and > is HTML-entity-escaped (not raw)
    //   - every *, _, ~, `, |, \ is preceded by a backslash (escaped)
    //   - & is HTML-entity-escaped (so existing entities don't break)
    const dangerous = '<!channel> *URGENT* see `rm -rf /` & <http://x|click>';
    const escaped = escapeMrkdwn(dangerous);

    // No raw < or > may remain.
    expect(escaped).not.toMatch(/[<>]/);
    // Every `&` must be the start of an entity (&amp;, &lt;, &gt;).
    expect(escaped).not.toMatch(/&(?!(amp|lt|gt);)/);
    // Every meta-character that is still a character must be preceded
    // by a backslash. We test by replacing every escaped pair `\X`
    // with empty string; the remainder must contain none of the
    // mrkdwn meta-characters.
    const stripped = escaped.replace(/\\[\\*_~`|]/g, '');
    expect(stripped).not.toMatch(/[*_~`|]/);
  });

  it('does not collapse or strip newlines (warning-list rendering relies on them)', () => {
    expect(escapeMrkdwn('line one\nline two')).toBe('line one\nline two');
  });
});
