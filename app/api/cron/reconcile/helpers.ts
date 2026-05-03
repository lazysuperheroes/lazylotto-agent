/**
 * Pure helpers for the cron/reconcile route. Lifted out of route.ts so
 * vitest can unit-test them without dragging in the Hedera SDK, store,
 * or agent context that route.ts pulls at module-load time.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Bearer-token comparison against `CRON_SECRET`, using a constant-time
 * compare on SHA-256 hashes of both values.
 *
 * Why hash before compare: `timingSafeEqual` requires equal-length
 * inputs and throws on length mismatch — that throw itself would leak
 * length information through differing exception timing. Hashing
 * normalizes both sides to 32 bytes regardless of secret length, so
 * the comparison is always 32-vs-32 and a wrong-length attacker
 * learns nothing.
 *
 * Returns false when `CRON_SECRET` is unset (endpoint disabled),
 * when the Authorization header is missing, when the scheme is wrong,
 * or when the provided value's hash doesn't match.
 */
export function isAuthorizedCron(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // No secret configured = endpoint disabled. Better than allowing
    // unauthenticated access by accident.
    return false;
  }
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const provided = header.slice(7);

  const expectedHash = createHash('sha256').update(expected).digest();
  const providedHash = createHash('sha256').update(provided).digest();
  return timingSafeEqual(expectedHash, providedHash);
}

/**
 * Escape characters that Slack and Discord interpret as mrkdwn
 * formatting. Use this on ANY string that may contain user-influenced
 * input (memo fields, token names, error messages) before
 * concatenating it into a webhook body.
 *
 * Why: a future depositor-controlled string (e.g. a memo that ends up
 * in a reconcile warning) could otherwise inject Slack mrkdwn —
 * `<https://attacker.example|click here>` rendered as a clickable
 * link, `*urgent*` rendered as bold, mentions like `<!channel>`
 * triggering pings. Today the warnings come from internal logic so
 * the risk is theoretical, but the escape costs nothing and forecloses
 * the attack class.
 *
 * Strategy: replace `<` `>` `&` with HTML entities (Slack's documented
 * literal-rendering form), and escape `\` `*` `_` `~` `` ` `` `|` with
 * a leading backslash. Slack treats backslash-escaped characters as
 * literal. Discord works the same way for the punctuation; the HTML
 * entities are passed through harmlessly on Discord.
 */
export function escapeMrkdwn(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\*_~`|]/g, (ch) => `\\${ch}`);
}
