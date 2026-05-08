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
/**
 * R2-FG-25 (round-2 X-06 / R-12): bound HCS submit time. The pre-fix
 * `await accounting.recordControlEvent` could hang for minutes during
 * topic congestion — exactly the moment the operator wants to engage
 * the killswitch. Bound at 5 seconds; on timeout, write an
 * `audit_trail_orphaned` row + flip Redis anyway. The orphan row gives
 * an operator the replay parameters to write the anchor by hand once
 * the topic is healthy again.
 */
const KILLSWITCH_HCS_TIMEOUT_MS = 5_000;

async function recordControlEventWithTimeout(
  accounting: KillswitchAuditWriter,
  event: 'killswitch_enabled' | 'killswitch_disabled',
  details: { reason?: string; by: string },
): Promise<{ ok: true } | { ok: false; reason: string; cause: unknown }> {
  // R3-FG-28 (round-3 P2-006 / P5-KS-001 / P5-KS-002): use AbortSignal
  // (with timeout) so the recordControlEvent submission is actually
  // CANCELLED on timeout. Pre-fix `Promise.race` left the HCS submit
  // running in background — could emit a duplicate `killswitch_enabled`
  // anchor AFTER the orphan row was written and Redis flipped, leaving
  // the topic with TWO events for a single engagement. Plus a
  // microtask race between the timer and the HCS resolution could
  // produce both branches running.
  //
  // Note: this requires accounting.recordControlEvent to honor
  // AbortSignal — which most HCS SDKs do via fetch's signal. If the
  // SDK ignores the signal, behavior is unchanged from R2-FG-25 (no
  // worse).
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), KILLSWITCH_HCS_TIMEOUT_MS);
  try {
    await Promise.race([
      accounting.recordControlEvent(event, details),
      new Promise<never>((_, reject) => {
        ac.signal.addEventListener('abort', () => {
          reject(new Error(`HCS submit timeout after ${KILLSWITCH_HCS_TIMEOUT_MS}ms`));
        });
      }),
    ]);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      cause: err,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function enableKillSwitch(
  reason: string,
  enabledBy: string,
  accounting?: KillswitchAuditWriter,
): Promise<void> {
  // R4-FG-47 (round-4 medium): atomic SET NX EX before any HCS work.
  // Pre-fix the route's `existing.enabled` pre-check + this function's
  // unconditional `redis.set(KILL_KEY, ...)` left a TOCTOU window where
  // two concurrent POSTs could both see `enabled === false`, both
  // submit a `killswitch_enabled` HCS anchor, and the second `set`
  // would clobber the first's `enabledBy` / `enabledAt` metadata.
  //
  // The atomic `SET … NX` here is the real idempotency gate. If we
  // win the SET, we own the engagement and proceed with the anchor.
  // If the SET no-ops (already set), some sibling caller already
  // engaged — short-circuit before any HCS submit so we don't emit a
  // duplicate anchor. The route's pre-check is now an optimistic
  // optimization (skip the work if obviously not needed); this gate
  // is the correctness layer.
  //
  // Note this trades F22's strict anchor-first ordering for a few
  // hundred milliseconds: the Redis flag lands microseconds before
  // the anchor instead of after. That window can show "agent rejects
  // plays without an on-chain anchor" briefly. The trade is worth it
  // — the F22 anchor-first guarantee was already best-effort
  // (anchor failure → flip anyway) so it was never strict.
  const redis = await getRedis();
  const state: Omit<KillSwitchState, 'enabled'> = {
    reason,
    enabledAt: new Date().toISOString(),
    enabledBy,
  };
  // R5-FG-7 (round-5 critical): R4-FG-47's comment claimed "SET NX
  // EX" but the call was `{ nx: true }` only — no TTL. Once flipped,
  // the kill flag was permanent until an explicit `disableKillSwitch`.
  // A future operator engaging again with a NEW reason silently
  // no-ops below — second-engagement reason+by lost from Redis AND
  // the topic. With 24h TTL, engagements auto-expire so the topic +
  // Redis state stay honest about the current operator intent.
  // Operators who need a longer engagement re-call this every <24h.
  const KILLSWITCH_TTL_SEC = 24 * 60 * 60;
  const claimed = await redis.set(KILL_KEY, JSON.stringify(state), {
    nx: true,
    ex: KILLSWITCH_TTL_SEC,
  });
  if (claimed === null) {
    // SET NX no-op: another caller owns the engagement. Idempotent
    // return — caller can read state to confirm.
    logger.info('kill switch already engaged (SET NX no-op)', { reason, enabledBy });
    return;
  }
  let anchorFailed = false;
  let anchorReason: string | undefined;
  if (accounting) {
    const result = await recordControlEventWithTimeout(accounting, 'killswitch_enabled', {
      reason,
      by: enabledBy,
    });
    if (!result.ok) {
      anchorFailed = true;
      anchorReason = result.reason;
      logger.error(
        'kill switch HCS-20 audit anchor failed (timeout or error); engaging anyway — ' +
          'manual on-chain follow-up REQUIRED',
        {
          component: 'KillSwitch',
          event: 'killswitch_anchor_failed_pre_engage',
          reason,
          enabledBy,
          error: result.reason,
        },
      );
      // R3-FG-27 (round-3 P1-002 / P6-005 / P9-005): R2-FG-25's commit
      // promised the timeout branch writes audit_trail_orphaned + flips
      // Redis. Implementation only logged. Now: write the orphan row +
      // escalate via webhook so the operator sees the missing on-chain
      // anchor and can replay manually. Without this, the killswitch
      // engagement evidence is invisible to a topic-only auditor in a
      // DR scenario.
      //
      // R5-FG-6 (round-5 critical): track whether BOTH the orphan
      // write AND the escalation succeeded. If neither lands, the
      // operator + topic + DL queue have ZERO record of the engagement
      // while Redis says enabled. Better to revert the Redis flip and
      // fail loudly than ship into a state with no evidence trail.
      let orphanWritten = false;
      let escalationFired = false;
      try {
        const { createStore } = await import('../custodial/createStore.js');
        const { mintAuditOrphanId } = await import('./orphanIds.js');
        const store = await createStore();
        await store.upsertDeadLetter({
          // R4-FG-28: bare Date.now() collides if two enable calls
          // race within the same millisecond — use uuid-suffixed id.
          transactionId: mintAuditOrphanId('audit-orphan:killswitch-enable', 'global'),
          timestamp: new Date().toISOString(),
          error: `killswitch enable HCS anchor failed/timed out: ${result.reason}`,
          kind: 'audit_trail_orphaned',
          details: {
            sourceKind: 'killswitch_enabled',
            event: 'killswitch_enabled',
            reason,
            enabledBy,
            phase: 'killswitch_anchor_failed_pre_engage',
          },
        });
        orphanWritten = true;
      } catch (orphanErr) {
        logger.error('killswitch enable orphan-write also failed', {
          component: 'KillSwitch',
          error: orphanErr instanceof Error ? orphanErr.message : String(orphanErr),
        });
      }
      try {
        const { escalateUncertainDlFailure } = await import('./escalation.js');
        await escalateUncertainDlFailure({
          kind: 'audit_trail_orphaned',
          uncertainTxId: `killswitch-enable:${Date.now()}`,
          cause: result.cause,
        });
        escalationFired = true;
      } catch (escErr) {
        logger.error('killswitch enable escalation also failed', {
          component: 'KillSwitch',
          error: escErr instanceof Error ? escErr.message : String(escErr),
        });
      }
      if (!orphanWritten && !escalationFired) {
        // R5-FG-6: triple-fault. Revert the Redis flip and fail
        // loudly. Operator must retry; better to know we're broken
        // than to engage silently. The route's catch surfaces the
        // throw to the operator UI.
        try {
          await redis.del(KILL_KEY);
        } catch (revertErr) {
          logger.error(
            'CRITICAL: killswitch triple-fault — Redis revert ALSO failed; agent may be in killed state with no evidence',
            {
              component: 'KillSwitch',
              error: revertErr instanceof Error ? revertErr.message : String(revertErr),
            },
          );
          // Even revert failed; rethrow the ORIGINAL anchor cause so
          // the route sees a 5xx and the operator retries.
          throw result.cause instanceof Error
            ? result.cause
            : new Error(`killswitch triple-fault: ${result.reason}`);
        }
        throw new Error(
          `killswitch_engagement_aborted: HCS anchor failed (${result.reason}) and ` +
          'BOTH orphan-write and escalation also failed. Redis flip reverted. Retry.',
        );
      }
    }
  }
  // R4-FG-47: the Redis flip already landed via the SET NX EX above —
  // it is the atomic claim that gated entry to this function.
  // Pre-fix this site re-issued an unconditional SET, which on the
  // losing-race side would clobber the winner's metadata. With NX
  // gating, the second caller short-circuits before reaching here.
  // R2-FG-25: anchor failure does NOT undo the Redis state — operator
  // safety beats audit completeness during an emergency.
  logger.warn('kill switch ENABLED', { reason, enabledBy });
  if (anchorFailed) {
    logger.error(
      'killswitch engaged WITHOUT on-chain anchor — operator must replay manually',
      {
        component: 'KillSwitch',
        event: 'killswitch_engaged_anchor_orphan',
        reason,
        enabledBy,
        anchorReason,
      },
    );
  }
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
    const result = await recordControlEventWithTimeout(accounting, 'killswitch_disabled', {
      by: disabledBy,
    });
    if (!result.ok) {
      logger.error(
        'kill switch disable HCS-20 audit anchor failed (timeout or error); disabling anyway — ' +
          'manual on-chain follow-up REQUIRED',
        {
          component: 'KillSwitch',
          event: 'killswitch_anchor_failed_pre_disengage',
          disabledBy,
          error: result.reason,
        },
      );
      // R3-FG-53 (round-3 P5-KS-002): orphan + escalate disable-side too.
      try {
        const { createStore } = await import('../custodial/createStore.js');
        const { mintAuditOrphanId } = await import('./orphanIds.js');
        const store = await createStore();
        await store.upsertDeadLetter({
          // R4-FG-28: bare Date.now() collides; use uuid-suffixed id.
          transactionId: mintAuditOrphanId('audit-orphan:killswitch-disable', 'global'),
          timestamp: new Date().toISOString(),
          error: `killswitch disable HCS anchor failed/timed out: ${result.reason}`,
          kind: 'audit_trail_orphaned',
          details: {
            sourceKind: 'killswitch_disabled',
            event: 'killswitch_disabled',
            disabledBy,
            phase: 'killswitch_anchor_failed_pre_disengage',
          },
        });
      } catch { /* logged above */ }
      try {
        const { escalateUncertainDlFailure } = await import('./escalation.js');
        await escalateUncertainDlFailure({
          kind: 'audit_trail_orphaned',
          uncertainTxId: `killswitch-disable:${Date.now()}`,
          cause: result.cause,
        });
      } catch { /* logged above */ }
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
