/**
 * R4-FG-27 / R4-FG-28 (round-4 high): canonical helper for minting
 * unique audit-orphan dead-letter ids. Pre-fix many call sites used:
 *
 *   - `audit-orphan:<phase>:${sourceTxId}`           (unsalted)
 *   - `audit-orphan:<phase>:${userId}:${Date.now()}`  (millisecond-collision)
 *
 * Both shapes collide via `upsertDeadLetter`'s REPLACE semantics:
 * - Unsalted: every retry of the same source clobbers earlier failure
 *   history.
 * - Date.now(): two concurrent failures on the same userId at the
 *   same millisecond clobber each other.
 *
 * R3-FG-26 fixed six force-release sites with `${randomUUID().slice(0,8)}`
 * suffixes. R4-FG-27/28 generalize the helper so every audit-orphan
 * id minted across the codebase has the same uniqueness guarantee.
 *
 * Format: `<prefix>:<sourceKey>:<timestamp>-<uuid8>`
 *   - `prefix` is human-readable (e.g. `audit-orphan:verifier`,
 *     `audit-orphan:in-band:play-settle`)
 *   - `sourceKey` ties the orphan to the upstream subject (txId,
 *     userId, etc.) so an operator can grep
 *   - `timestamp-uuid8` is the dedup tail (millisecond precision +
 *     8 random hex chars makes practical collision impossible)
 */

import { randomUUID } from 'node:crypto';

export function mintAuditOrphanId(prefix: string, sourceKey: string): string {
  return `${prefix}:${sourceKey}:${Date.now()}-${randomUUID().slice(0, 8)}`;
}
