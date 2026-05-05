# Concurrency Invariants

> Mandatory reading before adding any "have I seen this id?" /
> "what number comes next?" check to the custodial layer or any
> Redis-backed code path.

## The bug class we hardened against in 0.3.2 — 0.3.3

LazyLotto runs as multiple concurrent Lambda instances on Vercel
sharing a single Upstash Redis cluster. Each Lambda holds its own
in-memory caches that are hydrated once at cold start. **Reading from
those caches for cross-Lambda correctness produces silent divergence
under concurrent load.**

The duplicate-deposit incident (0.3.2 fix) was the canonical example:
`RedisStore.isTransactionProcessed(txId)` returned
`this.processedTxIds.has(txId)` — local Set lookup only. Two warm
Lambdas racing on the same fresh deposit each saw "not processed",
each credited the user, each wrote a `deposit` + `rake` op to the
HCS-20 audit topic. Balance doubled, audit trail corrupted, all
because a read path that needed cluster-wide truth consulted only its
own cache.

The agent has at least three other paths with the same shape:
refund replay protection (TOCTOU between GET and SET around an
on-chain transfer), dead-letter resolution (silent append where the
code claimed upsert), and `agentSeq` monotonicity (per-Lambda
counter where the schema documented "monotonic per-agent"). All three
are fixed in 0.3.3 using the same set of primitives below.

## The rule

**Any "have I seen this before?" read OR "what number comes next?"
read whose correctness depends on every Lambda agreeing must consult
Redis directly through an atomic primitive.** Not the local cache.

Reads that DON'T need cross-Lambda correctness can stay on the local
cache:

- Display-only counts/sums on the dashboard.
- The deposit watcher's pre-loop short-circuit before
  `creditDeposit` (the hard claim happens inside `creditDeposit`).
- Any read where a false-negative just causes an extra trip through
  a downstream check that's atomic.

If you're not sure which category your read belongs in, write the
test described in [Adding a new invariant](#adding-a-new-invariant)
below and see what fails.

## The three primitives

We use exactly three Redis primitives for cross-Lambda correctness.
Pick the one that matches your need.

### 1. `SADD`-based atomic claim

Use when: "I want to be the FIRST to claim this id; everyone else
should know it's claimed."

`SADD set member` returns 1 iff the element was newly added across
the entire cluster, 0 if it was already a member. The first caller
wins; subsequent callers short-circuit.

Example: deposit credit (`IStore.tryClaimTransaction`).

```ts
async tryClaimTransaction(txId: string): Promise<boolean> {
  if (this.processedTxIds.has(txId)) return false; // local fast-path
  const added = await this.redis.sadd('deposits:processed', txId);
  if (added === 1) this.processedTxIds.add(txId);
  return added === 1;
}
```

The local-cache fast-path is a *hit* optimisation — only correct
because a local hit means we (or a prior `load()`) already won the
SADD. A local miss MUST hit Redis.

For "is X claimed by anyone?" reads (no claim attempt), use
`SISMEMBER`:

```ts
async isDepositCredited(txId: string): Promise<boolean> {
  if (this.processedTxIds.has(txId)) return true; // fast-path on hit
  const present = await this.redis.sismember('deposits:processed', txId);
  if (present === 1) this.processedTxIds.add(txId); // backfill
  return present === 1;
}
```

### 2. `SET NX EX`-based exclusive lock

Use when: "I want to be the only caller doing X for the next N
seconds; everyone else should retry later."

`SET key value NX EX seconds` returns `'OK'` iff the key did NOT
exist (atomic across cluster). Subsequent callers get `null` and can
either retry or surface a "in progress" error.

Examples: per-user lock around play/withdraw/recovery
(`acquireUserLock`), per-operation lock around reconcile/
migrate-schema (`acquireOperatorLock`), refund replay protection
(`SET refundLockKey 'pending' NX EX 30d`).

```ts
const claim = await redis.set(refundLockKey, 'pending', {
  nx: true,
  ex: 30 * 24 * 60 * 60,
});
if (claim === null) {
  const existing = await redis.get(refundLockKey);
  throw new Error(
    existing && existing !== 'pending'
      ? `Already refunded: ${existing}`
      : `Refund in progress on another Lambda. Try again shortly.`,
  );
}
```

For multi-step operations: write `'pending'` first, overwrite with
the success value (e.g. `refundTxId`) after the operation completes,
DEL on failure to release the lock for retry.

### 3. `INCR`-based atomic counter

Use when: "I want a unique sequence number across all Lambdas."

`INCR key` returns the new value (post-increment) atomically. Each
caller gets a distinct integer.

Example: HCS-20 v2 `agentSeq` (`IStore.nextAgentSeq`).

```ts
async nextAgentSeq(agentAccountId: string): Promise<number> {
  return await this.redis.incr(`agentSeq:${agentAccountId}`);
}
```

For seed-once-then-increment: combine with `SET NX` on first use:

```ts
async seedAgentSeq(agentAccountId: string, baseline: number): Promise<void> {
  await this.redis.set(`agentSeq:${agentAccountId}`, baseline, { nx: true });
}
```

Two cold Lambdas can both run their mirror-scan baseline calculation
and both call `seedAgentSeq` — first SETNX wins, both then INCR
against the shared counter.

## Adding a new invariant

When you add a cross-Lambda read or sequence operation:

1. **Pick a primitive** from the three above. If none fit, that's
   probably a sign you haven't decomposed the problem; look at your
   read in terms of "claim", "lock", or "counter."
2. **Add a regression test** to
   `src/custodial/concurrency-invariants.test.ts`. The existing tests
   show the shape: shared mock Redis state, two store instances,
   `Promise.all([...])`, assert on outcome (singular winner / unique
   sequence numbers / no duplicate rows / etc).
3. **Document the invariant in this file** in a one-line sentence
   under "Live invariants" below. The test enforces it at CI time;
   the doc explains it to humans.

If you can't articulate the invariant in one sentence, you probably
haven't picked the right primitive. Re-read [The rule](#the-rule).

## Live invariants

Every invariant has a regression test in
`src/custodial/concurrency-invariants.test.ts`.

| # | Invariant | Primitive | Source |
|---|-----------|-----------|--------|
| 1 | Each on-chain deposit txId is credited to a user balance exactly once across all Lambdas. | SADD claim (`tryClaimTransaction`) | `src/custodial/UserLedger.ts` (creditDeposit) |
| 2 | A Lambda whose local cache is empty still gets the correct `isDepositCredited` answer for any txId credited by any other Lambda. | SISMEMBER (`isDepositCredited`) | `src/hedera/refund.ts` (deposit-validation gate) |
| 3 | Each HCS-20 v2 message emitted by an agent account gets a unique `agentSeq` across all Lambdas. | INCR (`nextAgentSeq`) | `src/custodial/AccountingService.ts` |
| 4 | Two cold Lambdas seeding `agentSeq` from independent mirror scans converge to one canonical baseline. | SETNX (`seedAgentSeq`) | `src/custodial/AccountingService.ts` (initializeAgentSeq) |
| 5 | Each on-chain transaction can produce at most one refund across all Lambdas. | SET NX EX (refund replay protection) | `src/hedera/refund.ts` |
| 6 | Pre-transfer refund failure releases the claim so retries can succeed without waiting for the 30-day TTL. | DEL on catch | `src/hedera/refund.ts` |
| 7 | A dead-letter entry's resolution markers replace the unresolved row, never duplicate it. | upsert by `transactionId` (`upsertDeadLetter`) | `src/custodial/RedisStore.ts` |
| 8 | At most one stuck-prize recovery runs per user at a time across all Lambdas. | SET NX EX (`acquireUserLock`) | `src/mcp/tools/operator.ts` (operator_recover_stuck_prizes) |
| 9 | At most one reconcile runs at a time across all Lambdas (cron + admin click + MCP tool serialise). | SET NX EX (`acquireOperatorLock('reconcile')`) | `src/mcp/tools/operator.ts`, `app/api/admin/reconcile/route.ts`, `app/api/cron/reconcile/route.ts` |
| 10 | At most one schema migration runs at a time. | SET NX EX (`acquireOperatorLock('migrate-schema')`) | `app/api/admin/migrate-schema/route.ts` |
| 11 | Per-user play and withdraw mutations serialise across all Lambdas (single mutator at a time per user). | SET NX EX (`acquireUserLock`) | `app/api/user/play/route.ts`, `app/api/user/withdraw/route.ts` |
| 12 | Lock holders see post-flush Redis state — local cache is refreshed on acquire, all pending writes are flushed before release. | `withUserLock` helper composing `acquireUserLock` + `refreshUser` + `applyPendingLedgerForUser` + `flush` + `releaseUserLock` | `src/lib/locks.ts:withUserLock` |
| 13 | `creditDeposit` acquires the same per-user lock as refund/play/withdraw — no lost-update on `user.balances` between deposit watcher and other actors. | SET NX EX with backoff (`acquireUserLock` ~6.85s) | `src/custodial/UserLedger.ts:creditDeposit` |
| 14 | Refund-queued ledger debits drain on EVERY user lock acquire — no up-to-1-hour window where on-chain refund is undebited. | Eager drain inside `withUserLock` (`applyPendingLedgerForUser`) | `src/custodial/pendingLedger.ts`, `src/lib/locks.ts` |
| 15 | Withdrawal requests with the same `Idempotency-Key` execute exactly once across all Lambdas — lost-response retries don't double-withdraw. | SET NX EX (`withIdempotency`) | `src/lib/idempotency.ts`, `app/api/user/withdraw/route.ts` |
| 16 | Velocity cap fails CLOSED on Redis error — single transient hiccup can no longer disable the cap for one withdrawal. | Throw → 503 `redis_degraded` | `src/custodial/MultiUserAgent.ts:checkWithdrawalVelocity` |
| 17 | CLI `recover-stuck-prizes` serialises with itself — two CLI invocations on the same target account block each other. | SET NX EX (`acquireUserLock(\`recover-cli:\${accountId}\`)`) | `src/scripts/recover-stuck-prizes.ts` |

Adding a new entry to this table is the visible "did I do my
homework?" signal. Drift between the table and the test file is
itself a CI regression — the next test in
`concurrency-invariants.test.ts` should match the next row here.

## Items explicitly deferred from the 0.3.3 audit

The 0.3.3 adversarial audit surfaced these items that were
considered and explicitly NOT fixed. Documenting here so we don't
re-audit them and conclude the same thing.

| # | Item | Why deferred |
|---|------|--------------|
| D1 | `recordPlaySession` / `recordWithdrawal` are append-only | Latent only — currently safe under per-user lock. Adding upsert-by-id costs an extra Redis round trip per play with no current safety improvement. Re-evaluate if the lock contract ever changes. |
| D2 | `deposits:processed` Redis SET unbounded growth | Math: ~10K deposits/year × 10 years × ~30 bytes ≈ 3MB. Negligible. Any cleanup re-opens the dedup window. Don't fix. |
| D3 | Refund `'pending'` marker stuck after Lambda death | Rare edge case. 30-day TTL is the safety net; operator can `redis-cli DEL` for faster retry. Documented in incident playbook Symptom 13. Auto-recovery adds complexity for marginal value. |
| D4 | Watermark last-write-wins (`setWatermark`) | Causes redundant mirror-node calls on rewind, but mirror is free. `tryClaimTransaction` is the dedup gate, so no double-credit possible. Skip. |
| D5 | `DepositWatcher.upsertDeadLetter` cross-Lambda race | Visual dupes in admin dashboard, no money loss. Wrapping the watcher in a lock would defeat its fast-iteration design. Defer. |
| D6 | Cold-start init coordination | Multiple cold Lambdas independently run their `RedisStore.load()` — extra Redis hits during cold-start storms but no correctness issue. Cost concern only. |
| D7 | CLI vs MCP recovery cross-tool coordination | CLI uses `recover-cli:{accountId}` lock; MCP uses internal userId. They don't coordinate cross-tool. Operational practice (don't run CLI while production is processing same account) is the documented mitigation. |

## Failure modes that LOOK like concurrency bugs but aren't

For triage clarity:

- **In-process cache out-of-sync with Redis after a flush failure**:
  not a concurrency bug — it's a durability bug. The fix is a
  `flush()` in the right place, not a new primitive.
- **Sequence numbers duplicated within a single Lambda**: not a
  concurrency bug — it's a logic bug (someone called `nextAgentSeq`
  twice without using the first result). The primitive is correct.
- **Two refunds for two different txIds racing for one user balance**:
  not addressed by these invariants. That's a per-user-balance race,
  closed by `acquireUserLock` around the ledger adjustment (already
  in `refund.ts`).

## See also

- `docs/incident-playbook.md` — Symptom 11 (deposit double-credit),
  12 (dead-letter double-resolution), 13 (refund double-execution),
  14 (agentSeq duplicates).
- `src/custodial/concurrency-invariants.test.ts` — the executable
  contract for everything above.
- `src/custodial/IStore.ts` — primitive method signatures + JSDoc
  with cross-Lambda safety contracts.
