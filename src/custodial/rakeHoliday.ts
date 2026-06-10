/**
 * Rake holiday — the x402-gated "pay USD → 0% rake for N days" capability.
 *
 * This module is the ONLY thing that knows about rake holidays. The audited
 * settlement path (`UserLedger.creditDeposit`) is UNCHANGED: the deposit watcher
 * resolves the effective rake through `getEffectiveRakePercent` and passes the
 * result (0 during an active holiday, else the user's base rate) into the
 * unchanged `creditDeposit`. So a holiday is purely "which rate is passed in",
 * never a change to how rake is computed/recorded.
 *
 * State lives in the auth Redis (in-memory fallback for local dev), NOT on the
 * audited UserAccount:
 *   - `rakeHoliday:<userId>` — the active grant, TTL = the holiday window.
 * Grant idempotency (dedup of a replayed settlement tx) rides the canonical
 * `withIdempotency` primitive rather than a hand-rolled SADD claim — keeping
 * all atomic claim primitives in the approved primitive layer (CLAUDE.md #13).
 */

import { getRedis, KEY_PREFIX } from '../auth/redis.js';
import { withIdempotency } from '../lib/idempotency.js';

export interface RakeHolidayGrant {
  userId: string;
  grantedAtMs: number;
  untilMs: number;
  /** On-chain x402 settlement tx id that paid for this holiday. */
  settlementTxId: string;
  priceUsdCents: number;
  /** 'hbar' or the USDC token id that was paid. */
  asset: string;
  /** Atomic units paid (tinybars for HBAR, base units for USDC). */
  amount: string;
}

export interface GrantResult {
  grant: RakeHolidayGrant;
  /** True if this settlement tx was already processed (replay) — no re-grant. */
  alreadyProcessed: boolean;
}

function holidayKey(userId: string): string {
  return `${KEY_PREFIX.rakeHoliday}${userId}`;
}

/** True iff the user currently has an active (unexpired) paid rake holiday. */
export async function isRakeHolidayActive(userId: string): Promise<boolean> {
  const redis = await getRedis();
  const v = await redis.get(holidayKey(userId));
  return v !== null && v !== undefined;
}

/**
 * The user's effective rake percent: 0 during an active holiday, else the base
 * rate. This is the single seam wired into the deposit-credit path.
 */
export async function getEffectiveRakePercent(
  userId: string,
  baseRakePercent: number,
): Promise<number> {
  return (await isRakeHolidayActive(userId)) ? 0 : baseRakePercent;
}

/** Read the active grant (or null if none / expired). */
export async function getRakeHoliday(
  userId: string,
): Promise<RakeHolidayGrant | null> {
  const redis = await getRedis();
  const v = await redis.get<unknown>(holidayKey(userId));
  if (v === null || v === undefined) return null;
  try {
    // Upstash REST auto-deserializes JSON values, so `get` may return the
    // ALREADY-PARSED object; the in-memory fallback returns the raw string we
    // stored. Guard with `typeof` so we never JSON.parse an object (which
    // throws SyntaxError → would silently swallow an active holiday and show
    // the base rate). Same hazard documented in src/lib/idempotency.ts.
    return (typeof v === 'string' ? JSON.parse(v) : v) as RakeHolidayGrant;
  } catch {
    return null;
  }
}

/**
 * Grant a rake holiday for a user, idempotent per settlement tx id. The tx id is
 * claimed in a permanent SADD set; a replay of the same on-chain payment returns
 * `alreadyProcessed: true` WITHOUT re-granting or extending.
 */
export async function grantRakeHoliday(params: {
  userId: string;
  durationDays: number;
  settlementTxId: string;
  priceUsdCents: number;
  asset: string;
  amount: string;
  /** Caller-supplied wall clock (Date.now()) — passed in for testability. */
  nowMs: number;
}): Promise<GrantResult> {
  const ttlSec = params.durationDays * 86_400;
  const untilMs = params.nowMs + params.durationDays * 86_400_000;
  const grant: RakeHolidayGrant = {
    userId: params.userId,
    grantedAtMs: params.nowMs,
    untilMs,
    settlementTxId: params.settlementTxId,
    priceUsdCents: params.priceUsdCents,
    asset: params.asset,
    amount: params.amount,
  };

  // Idempotent per settlement tx via the canonical claim primitive. The body
  // (set the active-holiday key) runs once; a replay of the same on-chain
  // payment returns the cached grant without re-granting.
  const outcome = await withIdempotency<RakeHolidayGrant>(
    'rake-holiday',
    params.settlementTxId,
    async () => {
      const redis = await getRedis();
      await redis.set(holidayKey(params.userId), JSON.stringify(grant), {
        ex: ttlSec,
      });
      return grant;
    },
    { ttlSec },
  );

  if (outcome.kind === 'fresh') {
    return { grant: outcome.result, alreadyProcessed: false };
  }
  if (outcome.kind === 'duplicate') {
    return { grant: outcome.result, alreadyProcessed: true };
  }
  // 'in-flight': a concurrent grant for the same settlement tx is running.
  return { grant, alreadyProcessed: true };
}
