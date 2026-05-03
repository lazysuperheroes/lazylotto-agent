/**
 * Redis health circuit-breaker — F6.
 *
 * The agent has multiple guardrails that legitimately fail open on a
 * single Redis error (kill switch, withdrawal velocity cap, rate
 * limits). Each is defensible individually: a momentary Upstash hiccup
 * shouldn't lock out withdrawals, the kill switch is an override not a
 * gate, etc.
 *
 * The PROBLEM is when those individual fail-open behaviors STACK. If
 * Upstash is down for several minutes during an attack window, the
 * agent simultaneously loses:
 *   - cluster-wide rate limiting (per-Lambda counters only)
 *   - withdrawal velocity caps (returns full cap on every check)
 *   - kill switch enforcement (assumes disabled)
 *   - distributed locks (per-Lambda mutexes only)
 *
 * Each guard is fine alone; together they expose the agent.
 *
 * This module tracks Redis errors over a sliding window. When N
 * failures occur within M seconds, the breaker opens for T seconds.
 * While open, write-path operations (play, withdraw) should fail
 * CLOSED — return a clear "service degraded — try again shortly"
 * 503 — instead of silently bypassing all the guards. Reads continue
 * normally.
 *
 * The breaker re-closes on the first successful Redis op after the
 * cooldown elapses, OR after the cooldown if no further attempts
 * happen.
 *
 * Process-local state by design — each Lambda instance tracks its
 * own breaker. A multi-instance Redis outage will trip every
 * instance's breaker independently, which is the right behavior;
 * the breaker fires when THIS instance can't reach Redis, regardless
 * of what other instances see.
 */

const FAILURE_WINDOW_MS = 60_000; // 60s rolling window
const FAILURE_THRESHOLD = 3; // 3 failures within window → open
const COOLDOWN_MS = 30_000; // 30s open before allowing retry probe

// Pin to globalThis so Next.js HMR doesn't reset breaker state on file
// save (same pattern as the Redis client cache in src/auth/redis.ts).
type BreakerGlobals = {
  __lazylottoRedisBreaker__?: BreakerState;
};

interface BreakerState {
  /** ISO timestamps of recent failures within the window. */
  recentFailures: number[];
  /** Epoch ms when the breaker was opened. 0 = closed. */
  openedAt: number;
}

const globalForBreaker = globalThis as unknown as BreakerGlobals;

function getState(): BreakerState {
  if (!globalForBreaker.__lazylottoRedisBreaker__) {
    globalForBreaker.__lazylottoRedisBreaker__ = {
      recentFailures: [],
      openedAt: 0,
    };
  }
  return globalForBreaker.__lazylottoRedisBreaker__;
}

/** Drop failures older than the rolling window. */
function pruneFailures(state: BreakerState, now: number): void {
  const cutoff = now - FAILURE_WINDOW_MS;
  state.recentFailures = state.recentFailures.filter((t) => t >= cutoff);
}

/**
 * Record a Redis operation failure. If failures cross the threshold
 * within the window, the breaker opens.
 *
 * Wrap your Redis calls like:
 *   try {
 *     const r = await redis.get(key);
 *     recordRedisSuccess();
 *     return r;
 *   } catch (e) {
 *     recordRedisFailure();
 *     throw e;
 *   }
 *
 * Or use `withRedisHealth()` for the same pattern in one line.
 */
export function recordRedisFailure(): void {
  const state = getState();
  const now = Date.now();
  state.recentFailures.push(now);
  pruneFailures(state, now);
  if (state.recentFailures.length >= FAILURE_THRESHOLD && state.openedAt === 0) {
    state.openedAt = now;
    // Visible signal for operators tailing logs
    console.warn(
      `[redisHealth] BREAKER OPENED — ${FAILURE_THRESHOLD}+ Redis failures in ` +
        `${FAILURE_WINDOW_MS / 1000}s. Write-path ops will fail closed for ` +
        `${COOLDOWN_MS / 1000}s.`,
    );
  }
}

/** Record a successful Redis op. Closes the breaker if it was open. */
export function recordRedisSuccess(): void {
  const state = getState();
  if (state.openedAt !== 0) {
    console.warn('[redisHealth] BREAKER CLOSED — Redis op succeeded');
  }
  state.openedAt = 0;
  state.recentFailures = [];
}

/**
 * True if the breaker is currently open. Write-path operations should
 * check this and return 503 when true; reads can proceed normally.
 *
 * Auto-closes if the cooldown has elapsed (next op gets a free probe;
 * if it succeeds → closed, if it fails → re-opened by the next failure).
 */
export function isRedisDegraded(): boolean {
  const state = getState();
  if (state.openedAt === 0) return false;
  const now = Date.now();
  if (now - state.openedAt >= COOLDOWN_MS) {
    // Allow a probe — leave the failure history in place so two probes
    // failing in quick succession will re-open immediately.
    state.openedAt = 0;
    return false;
  }
  return true;
}

/**
 * Wrap a Redis op so failures and successes are recorded automatically.
 * Re-throws on failure so callers see the underlying error unchanged.
 *
 *   const session = await withRedisHealth(() => redis.get(key));
 */
export async function withRedisHealth<T>(op: () => Promise<T>): Promise<T> {
  try {
    const result = await op();
    recordRedisSuccess();
    return result;
  } catch (err) {
    recordRedisFailure();
    throw err;
  }
}

/**
 * Error thrown by guard functions when the breaker is open. Routes
 * should catch this and return 503 with the message.
 */
export class RedisDegradedError extends Error {
  constructor() {
    super(
      'Service temporarily degraded — Redis backend is unhealthy. ' +
        'Write operations are paused; reads remain available. ' +
        'Try again shortly.',
    );
    this.name = 'RedisDegradedError';
  }
}

/**
 * Throw `RedisDegradedError` if the breaker is open. Call from the
 * entry of write-path operations (play, withdraw) BEFORE acquiring
 * locks or making expensive I/O.
 */
export function assertRedisHealthy(): void {
  if (isRedisDegraded()) {
    throw new RedisDegradedError();
  }
}

/**
 * Test-only — reset the breaker between test cases. Not exported in
 * production because no production code path should manipulate the
 * breaker state directly; the recordX functions are the contract.
 */
export function _resetBreakerForTesting(): void {
  globalForBreaker.__lazylottoRedisBreaker__ = {
    recentFailures: [],
    openedAt: 0,
  };
}

/** Constants exposed for tests / observability dashboards. */
export const REDIS_HEALTH_CONFIG = {
  FAILURE_WINDOW_MS,
  FAILURE_THRESHOLD,
  COOLDOWN_MS,
} as const;
