/**
 * killswitch — emergency freeze for write-path operations.
 *
 * Single Redis flag (lla:{network}:killswitch) that, when set, causes
 * the agent to reject new play sessions and new registrations. The
 * intention is "stop creating new financial obligations while we figure
 * out what's wrong" — NOT "lock users out of their money".
 *
 * What it blocks:
 *   - multi_user_play (new lottery sessions)
 *   - multi_user_register (new user sign-ups, creates new ledger state)
 *   - single_user_play_session (the agent's own plays)
 *
 * What it does NOT block:
 *   - Withdrawals: users must always be able to exit
 *   - Deregistration: safe exit for active users
 *   - Reads (status, history, audit): users need visibility
 *   - Admin operations (refund, reconcile): operator still needs tools
 *
 * The flag works in CLI and serverless alike because it uses the same
 * auth/redis.ts getRedis() helper that already has an in-memory fallback
 * for local dev. In local dev without Redis, the kill switch is still
 * functional within a single process — just doesn't persist across restarts.
 */

import { getRedis, KEY_PREFIX } from '../auth/redis.js';
import { logger } from './logger.js';

const KILL_KEY = KEY_PREFIX.session.replace('session:', 'killswitch');

export interface KillSwitchState {
  enabled: boolean;
  reason?: string;
  enabledAt?: string;
  enabledBy?: string;
}

/**
 * Thrown by `assertKillSwitchDisabled()` when the switch is engaged.
 * Callers (HTTP routes, MCP tools) can detect this specifically to
 * translate into a 503 / structured error response with the reason.
 */
export class KillSwitchError extends Error {
  constructor(public reason: string | undefined) {
    const tail = reason ? `: ${reason}` : '';
    super(
      `Operation paused by operator${tail}. ` +
        'Withdrawals and read operations remain available.',
    );
    this.name = 'KillSwitchError';
  }
}

/** Check whether the kill switch is currently engaged. */
export async function isKillSwitchEnabled(): Promise<boolean> {
  try {
    const redis = await getRedis();
    const raw = await redis.get<string>(KILL_KEY);
    return raw !== null && raw !== undefined;
  } catch (err) {
    // If we can't reach Redis, FAIL OPEN. The kill switch is a safety
    // override, not a gate — the normal path (Redis down) should not
    // halt the agent just because we couldn't check a flag.
    logger.warn('killswitch check failed, allowing operation', { error: err });
    return false;
  }
}

/** Read the full kill switch state (including reason + metadata). */
export async function getKillSwitchState(): Promise<KillSwitchState> {
  try {
    const redis = await getRedis();
    const raw = await redis.get<string>(KILL_KEY);
    if (raw === null || raw === undefined) {
      return { enabled: false };
    }
    try {
      const parsed = JSON.parse(raw) as Omit<KillSwitchState, 'enabled'>;
      return { enabled: true, ...parsed };
    } catch {
      // Legacy flag with no metadata
      return { enabled: true };
    }
  } catch (err) {
    logger.warn('killswitch state read failed', { error: err });
    return { enabled: false };
  }
}

/** Engage the kill switch. Provide a reason for the audit trail. */
export async function enableKillSwitch(
  reason: string,
  enabledBy: string,
): Promise<void> {
  const redis = await getRedis();
  const state: Omit<KillSwitchState, 'enabled'> = {
    reason,
    enabledAt: new Date().toISOString(),
    enabledBy,
  };
  await redis.set(KILL_KEY, JSON.stringify(state));
  logger.warn('kill switch ENABLED', { reason, enabledBy });
}

/** Disengage the kill switch. */
export async function disableKillSwitch(disabledBy: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(KILL_KEY);
  logger.warn('kill switch DISABLED', { disabledBy });
}

/**
 * Throws a KillSwitchError if the switch is engaged. Call at the start
 * of any write-path operation that creates new financial obligations.
 *
 * This is the single source of truth — invoke from the domain layer
 * (MultiUserAgent.playForUser, registerUser, playForAllEligible,
 * LottoAgent.play) so that alternative callers (CLI cron, tests, future
 * HCS-10 negotiation handlers) can never bypass the gate by going
 * around the MCP tool layer.
 */
export async function assertKillSwitchDisabled(): Promise<void> {
  const state = await getKillSwitchState();
  if (state.enabled) {
    throw new KillSwitchError(state.reason);
  }
}
