/**
 * Application service layer — single canonical entry point for every
 * mutating user-state operation. HTTP routes (`app/api/user/*`,
 * `app/api/admin/*`) and MCP tools (`src/mcp/tools/multi-user.ts`,
 * `operator.ts`) MUST delegate here.
 *
 * Why this exists (the structural fix for the route-vs-MCP asymmetry
 * pattern that produced 4 audit passes worth of "fixed the route,
 * missed the MCP tool" bugs):
 *
 *   - Each business operation lives ONCE. Adding a new wrapping
 *     primitive (rate limit, idempotency, lock, audit anchor) happens
 *     in ONE place.
 *   - Input validation is centralised. NaN/Infinity / format checks
 *     run before any side effect, regardless of caller.
 *   - Access checks (eoaAddress ownership for user tier) cannot be
 *     bypassed by adding a new endpoint that forgot to call them.
 *   - The discriminated `UserOpResult<T>` lets every caller format its
 *     own response (HTTP status code, MCP tool reply) from the same
 *     source state.
 *
 * The composition order inside each op is fixed:
 *
 *   1. Validate input
 *   2. Resolve / authorize user
 *   3. withIdempotency (if a key was supplied)
 *   4. withUserLock (refresh + drain pendingLedger + flush + release)
 *   5. Domain method call
 *   6. Format result
 *
 * Lock-held semantics through idempotency: when the lock is held, the
 * inner body throws `LockHeldError`. `withIdempotency`'s catch DELs the
 * claim (existing throw-releases-claim contract), so a retry with the
 * same idempotency key after the lock is free can proceed. Without
 * this sentinel-throw pattern, idempotency would cache `lockHeld:true`
 * for 24h and trap the user.
 */

import type { IStore } from '../custodial/IStore.js';
import type { MultiUserAgent } from '../custodial/MultiUserAgent.js';
import type {
  PlaySessionResult,
  WithdrawalRecord,
  TokenBalanceEntry,
} from '../custodial/types.js';
import { withUserLock } from '../lib/locks.js';
import { withIdempotency } from '../lib/idempotency.js';

// ── Types ────────────────────────────────────────────────────────

/**
 * Discriminated union covering every outcome a caller might need to
 * format. HTTP routes map each kind to a status code + body; MCP tools
 * map each kind to an MCP error or json result.
 */
export type UserOpResult<T> =
  | { kind: 'ok'; result: T }
  | { kind: 'duplicate'; result: T }
  | { kind: 'in_flight' }
  | { kind: 'lock_held' }
  | { kind: 'access_denied'; reason: string }
  | { kind: 'invalid_input'; reason: string }
  | { kind: 'not_found'; reason?: string };

/** Shared dependencies threaded through every op.
 *
 * Hedera SDK Client lives on the `multiUser` agent — no need to pass
 * it separately. Routes/MCP tools instantiate `multiUser` once via
 * `getAgentContext()` and pass it here.
 */
export interface UserOpDeps {
  store: IStore;
  multiUser: MultiUserAgent;
}

/** Sentinel thrown from inside `withIdempotency` body when the user
 * lock is held. `withIdempotency`'s catch DELs the claim so retry can
 * succeed; the outer `withdrawForUser` / etc. catches it and returns
 * `{ kind: 'lock_held' }`. Never surfaces to the caller as an error. */
class LockHeldError extends Error {
  readonly _isLockHeldError = true as const;
  constructor() {
    super('user lock held — retry shortly');
    this.name = 'LockHeldError';
  }
}

function isLockHeldError(err: unknown): err is LockHeldError {
  return (
    err !== null &&
    typeof err === 'object' &&
    '_isLockHeldError' in err &&
    (err as { _isLockHeldError?: unknown })._isLockHeldError === true
  );
}

// ── Validation helpers ───────────────────────────────────────────

const HEDERA_ID_REGEX = /^0\.0\.\d+$/;
const EVM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const HEDERA_TX_ID_REGEX = /^0\.0\.\d+(?:-|@)\d+(?:[-.])\d+$/;

/** Numeric input check shared across all amount fields. */
function validAmount(amount: unknown, max = 1e9): boolean {
  return (
    typeof amount === 'number' &&
    Number.isFinite(amount) &&
    amount > 0 &&
    amount <= max
  );
}

/** Case-insensitive equality for Hedera + EVM identifiers. */
function eqAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// ── Op: playForUser ──────────────────────────────────────────────

export async function playForUser(
  deps: UserOpDeps,
  ctx: { userId: string; idempotencyKey?: string | null },
): Promise<UserOpResult<PlaySessionResult>> {
  const user = deps.store.getUser(ctx.userId);
  if (!user) return { kind: 'not_found', reason: 'User not registered' };

  try {
    const idempotent = await withIdempotency<PlaySessionResult>(
      `play:${ctx.userId}`,
      ctx.idempotencyKey ?? null,
      async () => {
        const locked = await withUserLock(deps.store, ctx.userId, async () =>
          deps.multiUser.playForUser(ctx.userId),
        );
        if ('lockHeld' in locked) throw new LockHeldError();
        return locked.result;
      },
    );
    if (idempotent.kind === 'in-flight') return { kind: 'in_flight' };
    if (idempotent.kind === 'duplicate')
      return { kind: 'duplicate', result: idempotent.result };
    return { kind: 'ok', result: idempotent.result };
  } catch (err) {
    if (isLockHeldError(err)) return { kind: 'lock_held' };
    throw err;
  }
}

// ── Op: withdrawForUser ──────────────────────────────────────────

export async function withdrawForUser(
  deps: UserOpDeps,
  ctx: {
    userId: string;
    amount: number;
    token: string;
    idempotencyKey?: string | null;
  },
): Promise<UserOpResult<WithdrawalRecord>> {
  if (!validAmount(ctx.amount)) {
    return {
      kind: 'invalid_input',
      reason: 'amount must be a finite positive number under 1e9',
    };
  }
  if (typeof ctx.token !== 'string' || ctx.token.length === 0) {
    return { kind: 'invalid_input', reason: 'token is required' };
  }

  const user = deps.store.getUser(ctx.userId);
  if (!user) return { kind: 'not_found', reason: 'User not registered' };

  try {
    const idempotent = await withIdempotency<WithdrawalRecord>(
      `withdraw:${ctx.userId}`,
      ctx.idempotencyKey ?? null,
      async () => {
        const locked = await withUserLock(deps.store, ctx.userId, async () =>
          deps.multiUser.processWithdrawal(ctx.userId, ctx.amount, ctx.token),
        );
        if ('lockHeld' in locked) throw new LockHeldError();
        return locked.result;
      },
    );
    if (idempotent.kind === 'in-flight') return { kind: 'in_flight' };
    if (idempotent.kind === 'duplicate')
      return { kind: 'duplicate', result: idempotent.result };
    return { kind: 'ok', result: idempotent.result };
  } catch (err) {
    if (isLockHeldError(err)) return { kind: 'lock_held' };
    throw err;
  }
}

// ── Op: setStrategyForUser ───────────────────────────────────────

const VALID_STRATEGIES = ['conservative', 'balanced', 'aggressive'] as const;
type StrategyName = (typeof VALID_STRATEGIES)[number];

export interface SetStrategyOk {
  status: 'updated' | 'unchanged';
  userId: string;
  strategyName: string;
  strategyVersion: string;
  previousStrategy: string;
}

export async function setStrategyForUser(
  deps: UserOpDeps,
  ctx: { userId: string; strategy: string; performedBy?: string },
): Promise<UserOpResult<SetStrategyOk>> {
  if (!(VALID_STRATEGIES as readonly string[]).includes(ctx.strategy)) {
    return {
      kind: 'invalid_input',
      reason: `strategy must be one of: ${VALID_STRATEGIES.join(', ')}`,
    };
  }
  const strategy = ctx.strategy as StrategyName;

  const user = deps.store.getUser(ctx.userId);
  if (!user) return { kind: 'not_found', reason: 'User not registered' };
  if (!user.active) {
    return {
      kind: 'access_denied',
      reason: 'User is deregistered. Strategy cannot be changed.',
    };
  }

  // 0.3.4 hardening: the "unchanged" fast-path moves INSIDE the lock so
  // the strategyName comparison is against post-refresh canonical state.
  // Pre-fix it ran against potentially-stale local cache and could tell
  // a user "unchanged" when their actual strategy on Redis was different.
  try {
    const locked = await withUserLock(deps.store, ctx.userId, async () => {
      const fresh = deps.store.getUser(ctx.userId);
      if (!fresh) {
        throw new Error('NOT_FOUND_DURING_LOCK');
      }
      const previousStrategy = fresh.strategyName;
      if (previousStrategy === strategy) {
        return {
          status: 'unchanged' as const,
          userId: fresh.userId,
          strategyName: fresh.strategyName,
          strategyVersion: fresh.strategyVersion,
          previousStrategy,
        } satisfies SetStrategyOk;
      }
      const updated = await deps.multiUser.updateUserStrategy(
        ctx.userId,
        strategy,
        ctx.performedBy ?? 'user',
      );
      return {
        status: 'updated' as const,
        userId: updated.userId,
        strategyName: updated.strategyName,
        strategyVersion: updated.strategyVersion,
        previousStrategy,
      } satisfies SetStrategyOk;
    });

    if ('lockHeld' in locked) return { kind: 'lock_held' };
    return { kind: 'ok', result: locked.result };
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_FOUND_DURING_LOCK') {
      return { kind: 'not_found', reason: 'User vanished during operation' };
    }
    throw err;
  }
}

// ── Op: deregisterUserOp ─────────────────────────────────────────

export interface DeregisterOk {
  deregistered: boolean;
  userId: string;
  remainingBalance: Record<string, TokenBalanceEntry>;
}

export async function deregisterUserOp(
  deps: UserOpDeps,
  ctx: { userId: string },
): Promise<UserOpResult<DeregisterOk>> {
  const user = deps.store.getUser(ctx.userId);
  if (!user) return { kind: 'not_found', reason: 'User not registered' };

  try {
    const locked = await withUserLock(deps.store, ctx.userId, async () => {
      // deregisterUser is sync and just flips active=false via the ledger.
      deps.multiUser.deregisterUser(ctx.userId);
      const refreshed = deps.store.getUser(ctx.userId);
      return {
        deregistered: true,
        userId: ctx.userId,
        remainingBalance: refreshed?.balances.tokens ?? {},
      } satisfies DeregisterOk;
    });
    if ('lockHeld' in locked) return { kind: 'lock_held' };
    return { kind: 'ok', result: locked.result };
  } catch (err) {
    throw err;
  }
}

// ── Op: registerUserOp ───────────────────────────────────────────

export interface RegisterOk {
  status: 'registered' | 'already_registered';
  userId: string;
  strategy: string;
  rakePercent: number;
  depositMemo: string;
  agentWallet: string;
}

export async function registerUserOp(
  deps: UserOpDeps,
  ctx: {
    authAccountId: string;
    authTier: 'user' | 'admin' | 'operator' | 'public';
    eoaAddress?: string;
    accountId?: string; // admin/operator only
    strategy?: string;
    rakePercent?: number;
    agentWallet: string;
  },
): Promise<UserOpResult<RegisterOk>> {
  // ── Resolve target accountId ───────────────────────────────
  // Reject unauthenticated callers explicitly — registration mints a
  // depositMemo and writes a user record, both of which require a
  // verified session.
  if (ctx.authTier === 'public') {
    return { kind: 'access_denied', reason: 'Authentication required to register' };
  }
  // For 'user' tier: the session's accountId is the canonical target.
  // For admin/operator: body.accountId may override (defaults to agent wallet).
  const resolvedAccountId =
    ctx.authTier === 'user'
      ? ctx.authAccountId
      : ctx.accountId ?? ctx.agentWallet;

  // ── EOA ownership check (closes audit finding C3) ─────────
  // Pre-0.3.4 the route accepted any body.eoaAddress and the
  // downstream NegotiationHandler dedup leaked the existing record
  // for that EOA — even if the caller wasn't the owner. For user
  // tier, force eoaAddress = authAccountId. For admin/operator,
  // any value is acceptable (they're trusted to register on behalf
  // of others).
  const eoaAddress = ctx.eoaAddress ?? resolvedAccountId;
  if (ctx.authTier === 'user' && !eqAddr(eoaAddress, ctx.authAccountId)) {
    return {
      kind: 'access_denied',
      reason:
        'eoaAddress must match the authenticated session account. ' +
        'Re-authenticate as the target account if you intend to register it.',
    };
  }

  // ── Format check ─────────────────────────────────────────
  if (!HEDERA_ID_REGEX.test(eoaAddress) && !EVM_ADDRESS_REGEX.test(eoaAddress)) {
    return {
      kind: 'invalid_input',
      reason: 'Invalid eoaAddress format. Expected 0.0.X or 0x...',
    };
  }

  // Strategy preset
  const strategy = ctx.strategy ?? 'balanced';
  if (!(VALID_STRATEGIES as readonly string[]).includes(strategy)) {
    return {
      kind: 'invalid_input',
      reason: `strategy must be one of: ${VALID_STRATEGIES.join(', ')}`,
    };
  }

  // Rake percent (admin/operator-supplied negotiation)
  if (ctx.rakePercent !== undefined && !Number.isFinite(ctx.rakePercent)) {
    return { kind: 'invalid_input', reason: 'rakePercent must be a finite number' };
  }

  // ── Dedup check on local cache (refresh first for cross-Lambda freshness)
  await deps.store.refreshUserIndex();
  const existing = deps.store.getUserByAccountId(resolvedAccountId);
  if (existing) {
    return {
      kind: 'ok',
      result: {
        status: 'already_registered',
        userId: existing.userId,
        strategy: existing.strategyName,
        rakePercent: existing.rakePercent,
        depositMemo: existing.depositMemo,
        agentWallet: ctx.agentWallet,
      },
    };
  }

  // ── Create the user. registerUser is per-user atomic (the userId
  // it generates is unique by construction). No withUserLock needed —
  // there's no existing user to race against.
  const user = await deps.multiUser.registerUser(
    resolvedAccountId,
    eoaAddress,
    strategy,
    ctx.rakePercent,
  );
  return {
    kind: 'ok',
    result: {
      status: 'registered',
      userId: user.userId,
      strategy: user.strategyName,
      rakePercent: user.rakePercent,
      depositMemo: user.depositMemo,
      agentWallet: ctx.agentWallet,
    },
  };
}

// ── Op: withdrawOperatorFees ─────────────────────────────────────

export interface OperatorWithdrawOk {
  withdrawn: number;
  to: string;
  transactionId: string;
  remainingBalances: Record<string, number>;
}

export async function withdrawOperatorFees(
  deps: UserOpDeps,
  ctx: {
    amount: number;
    to: string;
    token: 'HBAR' | 'LAZY';
    idempotencyKey?: string | null;
  },
): Promise<UserOpResult<OperatorWithdrawOk>> {
  if (!validAmount(ctx.amount)) {
    return {
      kind: 'invalid_input',
      reason: 'amount must be a finite positive number under 1e9',
    };
  }
  if (typeof ctx.to !== 'string' || !HEDERA_ID_REGEX.test(ctx.to)) {
    return { kind: 'invalid_input', reason: 'to must be a Hedera account id (0.0.X)' };
  }

  // operatorWithdrawFees acquires its own operator-scoped lock + refreshOperator
  // (per 0.3.3/0.3.4 hardening). withIdempotency wraps for retry safety.
  const idempotent = await withIdempotency<OperatorWithdrawOk>(
    `withdraw-fees:${ctx.token}`,
    ctx.idempotencyKey ?? null,
    async () => {
      const txId = await deps.multiUser.operatorWithdrawFees(
        ctx.amount,
        ctx.to,
        ctx.token,
      );
      const op = deps.multiUser.getOperatorBalance();
      return {
        withdrawn: ctx.amount,
        to: ctx.to,
        transactionId: txId,
        remainingBalances: op.balances,
      };
    },
  );

  if (idempotent.kind === 'in-flight') return { kind: 'in_flight' };
  if (idempotent.kind === 'duplicate')
    return { kind: 'duplicate', result: idempotent.result };
  return { kind: 'ok', result: idempotent.result };
}

// ── Op: replayDeposit ────────────────────────────────────────────

export interface ReplayDepositOk {
  transactionId: string;
  credited: boolean;
  status: 'credited' | 'already_processed' | 'rejected_revalidated';
}

export async function replayDeposit(
  deps: UserOpDeps,
  ctx: { transactionId: string; performedBy: string },
): Promise<UserOpResult<ReplayDepositOk>> {
  if (typeof ctx.transactionId !== 'string' || !HEDERA_TX_ID_REGEX.test(ctx.transactionId)) {
    return {
      kind: 'invalid_input',
      reason: 'transactionId must be a Hedera tx id (0.0.X-T-N or 0.0.X@T.N)',
    };
  }

  // Idempotency keyed on the tx id itself — admin double-clicks dedupe naturally.
  const idempotent = await withIdempotency<ReplayDepositOk>(
    'replay-deposit',
    ctx.transactionId,
    async () => {
      // Fetch tx from mirror node + hand off to DepositWatcher.
      const { getMirrorBaseUrl } = await import('../hedera/mirror.js');
      const mirrorBase = getMirrorBaseUrl();
      const res = await fetch(`${mirrorBase}/transactions/${ctx.transactionId}`);
      if (!res.ok) {
        throw new ReplayDepositMirrorError(
          `Transaction ${ctx.transactionId} not found on mirror node (${res.status})`,
        );
      }
      const data = (await res.json()) as { transactions?: unknown[] };
      const tx = data.transactions?.[0];
      if (!tx) {
        throw new ReplayDepositMirrorError('Transaction not found in mirror response');
      }

      const watcher = deps.multiUser.getDepositWatcher();
      const credited = await watcher.processTransaction(
        tx as Parameters<typeof watcher.processTransaction>[0],
      );

      return {
        transactionId: ctx.transactionId,
        credited,
        status: credited ? 'credited' : 'already_processed',
      };
    },
  );

  if (idempotent.kind === 'in-flight') return { kind: 'in_flight' };
  if (idempotent.kind === 'duplicate')
    return { kind: 'duplicate', result: idempotent.result };
  return { kind: 'ok', result: idempotent.result };
}

/** Sentinel for replay-deposit mirror failures so the route can map to 404. */
export class ReplayDepositMirrorError extends Error {
  readonly _isReplayMirrorError = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'ReplayDepositMirrorError';
  }
}

// ── MCP-tool response helpers ────────────────────────────────────
//
// Convert UserOpResult to either a json result or errorResult call.
// MCP tools use these to avoid repeating the switch boilerplate.

export function isOpFailure<T>(
  r: UserOpResult<T>,
): r is Extract<
  UserOpResult<T>,
  | { kind: 'lock_held' }
  | { kind: 'in_flight' }
  | { kind: 'access_denied'; reason: string }
  | { kind: 'invalid_input'; reason: string }
  | { kind: 'not_found'; reason?: string }
> {
  return r.kind !== 'ok' && r.kind !== 'duplicate';
}

/** Error message for an MCP errorResult call. */
export function failureMessage<T>(r: UserOpResult<T>): string {
  switch (r.kind) {
    case 'lock_held':
      return 'Operation in progress for this user. Try again shortly.';
    case 'in_flight':
      return 'A previous request with this Idempotency-Key is still in progress. Retry shortly.';
    case 'invalid_input':
      return r.reason;
    case 'access_denied':
      return r.reason;
    case 'not_found':
      return r.reason ?? 'Not found';
    case 'ok':
    case 'duplicate':
      throw new Error('failureMessage called on ok/duplicate result');
  }
}
