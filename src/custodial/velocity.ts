/**
 * Withdrawal velocity helpers.
 *
 * Reads the per-user 24h withdrawal counter from Redis. Lives in its
 * own module so the dashboard's /api/user/status route can read velocity
 * state without instantiating the full MultiUserAgent — that init pulls
 * in the deposit watcher, ledger, and accounting service, which are
 * heavyweight and have nothing to do with reporting "remaining today".
 *
 * The cap and key naming convention exactly mirror the original
 * MultiUserAgent.getWithdrawalVelocityState method (which now delegates
 * here so there's a single source of truth).
 */

import { HBAR_TOKEN_KEY } from '../config/strategy.js';

export interface VelocityState {
  cap: number | null;
  usedToday: number;
  remaining: number | null;
}

/**
 * Resolve the daily cap for a token from env vars. HBAR has a default
 * of 1000; everything else defaults to "no cap" (Infinity → null).
 *
 * Env var convention:
 *   WITHDRAWAL_DAILY_CAP_HBAR=1000
 *   WITHDRAWAL_DAILY_CAP_LAZY=10000
 *
 * Returns null when the resolved cap is non-finite or non-positive,
 * which the caller treats as "no enforcement".
 */
function resolveCap(token: string): number | null {
  const normalized = token.toLowerCase();
  const isHbar = normalized === 'hbar' || normalized === HBAR_TOKEN_KEY;
  const capEnvKey = isHbar
    ? 'WITHDRAWAL_DAILY_CAP_HBAR'
    : `WITHDRAWAL_DAILY_CAP_${normalized.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
  const capDefault = isHbar ? 1000 : Number.POSITIVE_INFINITY;
  const cap = Number(process.env[capEnvKey] ?? capDefault);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  return cap;
}

/**
 * Read the current 24h withdrawal volume for one user/token from Redis.
 * Standalone — no MultiUserAgent dependency.
 *
 * Failure mode: on any Redis error, return the cap with usedToday=0 so
 * the UI shows the full daily allowance rather than blocking the user.
 * (Velocity is informational on the read path; the actual enforcement
 * happens during the withdrawal write inside MultiUserAgent.)
 */
export async function readVelocityState(
  userId: string,
  token: string,
): Promise<VelocityState> {
  const cap = resolveCap(token);
  if (cap === null) {
    return { cap: null, usedToday: 0, remaining: null };
  }

  try {
    const { getRedis, KEY_PREFIX } = await import('../auth/redis.js');
    const redis = await getRedis();
    const normalized = token.toLowerCase();
    const key = `${KEY_PREFIX.velocity}${normalized}:${userId}`;
    const currentRaw = await redis.get<string>(key);
    const usedToday = currentRaw ? Number(currentRaw) || 0 : 0;
    return { cap, usedToday, remaining: Math.max(0, cap - usedToday) };
  } catch {
    return { cap, usedToday: 0, remaining: cap };
  }
}

/**
 * Batch read of velocity state for multiple tokens at once. Uses
 * Promise.all so the round-trips fan out in parallel. The status
 * endpoint calls this so adding a token to a user's balance doesn't
 * linearly slow down the dashboard.
 */
export async function readVelocityStates(
  userId: string,
  tokens: string[],
): Promise<Record<string, VelocityState>> {
  const pairs = await Promise.all(
    tokens.map(async (t): Promise<[string, VelocityState]> => [
      t,
      await readVelocityState(userId, t),
    ]),
  );
  return Object.fromEntries(pairs);
}
