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
import { recordRedisFailure, recordRedisSuccess } from './redisHealth.js';
import { logger } from './logger.js';

const KILL_KEY = KEY_PREFIX.killswitch;

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
    recordRedisSuccess();
    return raw !== null && raw !== undefined;
  } catch (err) {
    // If we can't reach Redis, FAIL OPEN. The kill switch is a safety
    // override, not a gate — halting the agent because we couldn't
    // check a flag would be worse than the rare case the flag was set.
    //
    // F6: but we DO record the failure so the circuit-breaker can
    // catch a sustained outage. While the breaker is open, write-path
    // routes (play, withdraw) fail closed even though this individual
    // guard fails open. That's the trade — defense in depth.
    recordRedisFailure();
    logger.warn('killswitch check failed, allowing operation', { error: err });
    return false;
  }
}

/** Read the full kill switch state (including reason + metadata). */
export async function getKillSwitchState(): Promise<KillSwitchState> {
  try {
    const redis = await getRedis();
    const raw = await redis.get<unknown>(KILL_KEY);
    recordRedisSuccess();
    if (raw === null || raw === undefined) {
      return { enabled: false };
    }
    // Upstash REST auto-deserializes JSON values — calling JSON.parse on
    // an already-parsed object throws SyntaxError. Pre-fix the catch
    // silently dropped the metadata (reason / enabledAt / enabledBy),
    // so engaged kill switches showed only the generic "agent
    // temporarily closed" toast in the dashboard. Other call sites
    // (RedisStore.load, auth/session.ts) use the same guard.
    try {
      const parsed = (
        typeof raw === 'string' ? JSON.parse(raw) : raw
      ) as Omit<KillSwitchState, 'enabled'>;
      return { enabled: true, ...parsed };
    } catch {
      // Legacy flag with no metadata
      return { enabled: true };
    }
  } catch (err) {
    // Same fail-open + breaker-record dance as isKillSwitchEnabled. See
    // the F6 comment there for the trade-off rationale.
    recordRedisFailure();
    logger.warn('killswitch state read failed', { error: err });
    return { enabled: false };
  }
}

/**
 * Minimal AccountingService surface needed for the killswitch
 * audit anchor. Defined locally so killswitch.ts doesn't import
 * the full AccountingService (which would create a circular
 * dependency through MultiUserAgent → Reconciliation → killswitch).
 */
interface KillswitchAuditWriter {
  recordControlEvent(
    event:
      | 'killswitch_enabled'
      | 'killswitch_disabled'
      | 'force_release'
      | 'force_release_override',
    details: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * Engage the kill switch.
 *
 * F22 (2026-05-06 audit MO-6): the HCS-20 audit anchor is written
 * BEFORE the Redis flip. If the anchor fails, we still flip Redis
 * (operator safety > audit completeness during an emergency) but
 * log loudly so the operator can write the anchor manually. Without
 * the anchor, a compromised operator could pause the agent during
 * an attack window with zero on-chain footprint.
 *
 * `accounting` is optional for backward compat (CLI direct calls,
 * tests). HTTP routes pass `multiUser.getAccountingForRecovery()`.
 */
export async function enableKillSwitch(
  reason: string,
  enabledBy: string,
  accounting?: KillswitchAuditWriter,
): Promise<void> {
  if (accounting) {
    try {
      await accounting.recordControlEvent('killswitch_enabled', {
        reason,
        by: enabledBy,
      });
    } catch (err) {
      logger.error(
        'kill switch HCS-20 audit anchor failed; engaging anyway — ' +
          'manual on-chain follow-up REQUIRED',
        {
          component: 'KillSwitch',
          event: 'killswitch_anchor_failed_pre_engage',
          reason,
          enabledBy,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
  const redis = await getRedis();
  const state: Omit<KillSwitchState, 'enabled'> = {
    reason,
    enabledAt: new Date().toISOString(),
    enabledBy,
  };
  await redis.set(KILL_KEY, JSON.stringify(state));
  logger.warn('kill switch ENABLED', { reason, enabledBy });
}

/**
 * Disengage the kill switch.
 *
 * F22: same pattern as `enableKillSwitch` — anchor first, Redis
 * second. The `disabled` event is just as load-bearing as the
 * `enabled` one for an external auditor reconstructing incident
 * timing.
 */
export async function disableKillSwitch(
  disabledBy: string,
  accounting?: KillswitchAuditWriter,
): Promise<void> {
  if (accounting) {
    try {
      await accounting.recordControlEvent('killswitch_disabled', {
        by: disabledBy,
      });
    } catch (err) {
      logger.error(
        'kill switch disable HCS-20 audit anchor failed; disabling anyway — ' +
          'manual on-chain follow-up REQUIRED',
        {
          component: 'KillSwitch',
          event: 'killswitch_anchor_failed_pre_disengage',
          disabledBy,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
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
