# 2026-05-06 Audit — Fix Tracking

**Branch:** `testnet` · **Baseline commit:** `28afc1a` (checkpoint(uncertain-tx) before audit)

Recovery doc for the multi-persona adversarial audit of the uncertain-tx
verification feature + everything it touches. All 8 persona reports
ran in parallel; ~80 raw findings deduped into 27 fix-now items + 11
deferred + 3 accepted residual.

The persona reports themselves live in transient task-output files
(temp dir; will be GC'd). This file is the durable record. Each item
has enough detail to start work without re-reading the source reports.

## Status legend
- `[ ]` pending
- `[~]` in progress
- `[x]` done (implemented + test green)
- `[-]` deferred (to follow-up branch)
- `[!]` blocked / needs decision

## Severity legend
- **C** critical · **H** high · **M** medium · **L** low · **A** accepted residual

## Plan-of-record decisions
- **Drop `acknowledgeDoubleSpendRisk` flag entirely** as part of F12. Once
  force-release SUCCESS auto-runs verifier-equivalent post-conditions,
  the flag is redundant.
- **One commit per phase.** Five phases for fix-now + one cleanup pass.
- **Tests-first.** Each fix gets a regression test that FAILS on
  `28afc1a`, then the fix that makes it pass.
- **Stay on `testnet`.** Never released; this audit work is part of
  reaching a publishable state.

---

## Phase 1 — Foundations (5 items, ~unblocks everything else)

### `[x]` F1 (C) — `stampProgress` accumulator
**Closes:** C-01, SM-02, U-05, partial C-03

**Bug:** every `stampProgress` call rebuilds details from a stale
`entry.details` snapshot, overwriting prior stamps. After step N+1's
stamp, step N's marker is gone in Redis. Crash mid-flight → next pass
re-runs steps that already executed. Catastrophic for `settleSpend`,
`updateBalance(totalWithdrawn += amount)`, `updateOperator`.

**Files:**
- `src/custodial/uncertainTxVerification.ts:272-291` (`stampProgress` impl)
- All call sites: `:426`, `:445-447`, `:468-470`, `:494-496` (withdrawal),
  `:648-650`, `:668-670` (operator-fee)
- `src/hedera/refund.ts` — applies same fix to refund verifier (overlaps F6)

**Fix:** thread the running `progress` object as the source of truth.
Either pass full `progress` to `stampProgress` (not the patch), or
have `stampProgress` merge with the prior in-memory `progress`
accumulator before writing.

**Test:** `'stampProgress accumulates across steps — crash after totalWithdrawnAt does not lose settledAt'` in `uncertainTxVerification.test.ts`.

---

### `[x]` F2 (C) — `claimKey` prefix assert
**Closes:** I-07

**Bug:** force-release `refund_uncertain` branch and verifier both
`redis.del(details.claimKey)` with no prefix check. A hand-edited
or migration-corrupted entry with `claimKey: 'lla:testnet:session:abc'`
or `'lla:testnet:lock:user:0.0.X'` lets operator-tier delete arbitrary
`lla:` keys → drop sessions, drop user locks (race window),
drop killswitch flag, drop agentSeq counter (rewind HCS-20 seq).

**Files:**
- `app/api/admin/uncertain-tx/[id]/force-release/route.ts:435-447` (route)
- `src/hedera/refund.ts:744` (verifier)

**Fix:** assert `details.claimKey.startsWith(KEY_PREFIX.refunded)` at
both sites; reject with 400 if violated.

**Test:** `'force-release refuses claimKey outside refunded prefix'` in
`force-release.test.ts` — synth a DL with `claimKey: 'lla:testnet:session:abc'`,
assert 400 + the session key still exists.

---

### `[x]` F3 (H) — Strict boolean for `acknowledgeDoubleSpendRisk`
**Closes:** I-02

**Bug:** check is `!body.acknowledgeDoubleSpendRisk`. String `"false"`
is truthy → `!"false"` is `false` → SUCCESS guard skipped. Buggy
admin UI sending the string accidentally triggers double-spend override.

**Files:**
- `app/api/admin/uncertain-tx/[id]/force-release/route.ts:206-223`

**Fix:** zod-parse the body. `z.object({ reason: z.string().min(1).max(256), acknowledgeDoubleSpendRisk: z.boolean().optional() }).parse(...)`.
Note: F12 drops this flag entirely. Until F12 lands, this fix
prevents the truthy-string bypass.

**Test:** `'"false" string does not bypass SUCCESS guard'`.

---

### `[x]` F4 (H) — Input validation at verifier boundary
**Closes:** I-04, I-05, I-12, SM-08

**Bug:** Several:
- `details.amount: Infinity` passes `typeof === 'number'` →
  `settleSpend(Infinity)` corrupts ledger to NaN.
- `tokenReservations[i]` iterated without per-entry shape check →
  `{ token: 42, amount: '1.5' }` corrupts via stringly-typed math.
- Progress markers like `details.settledAt: '2099-01-01'` (future)
  with `totalWithdrawnAt: undefined` produce inconsistent partial
  execution.
- `bumpVerificationAttempts` reads-then-writes via in-process counter;
  concurrent bumps can miss the page threshold.

**Files:**
- `src/custodial/uncertainTxVerification.ts:295-340` (withdrawal),
  `:540-580` (operator-fee), `:720-755` (play),
  `:155-200` (`bumpVerificationAttempts`)
- `src/hedera/refund.ts` — same shape

**Fix:** at each verifier read site, gate the typeof check with
`Number.isFinite(amount) && amount >= 0`; iterate `tokenReservations`
with per-entry shape validation; sanity-check progress-marker
ordering; switch malformed counter to Redis `INCR`.

**Test:** `'Infinity amount fails closed at verifier'`, `'tokenReservations rejects non-string token / non-number amount'`, `'inconsistent progress markers escalate, do not partial-execute'`.

---

### `[x]` F5 (H/M) — External hardening bundle
**Closes:** I-01, I-03, I-08, I-09, I-10, I-11, I-13, I-14

**Bug:** several minor input/external trust issues:
- I-01 (H): `reason` field unbounded — multi-MB reason → HCS-20
  message exceeds 1024-byte cap → audit anchor silently downgraded
  to `audit_trail_orphaned`. Cap at 256 chars.
- I-03 (M): `decodeURIComponent` on URL path can throw `URIError`;
  validate decoded id against Hedera txId regex.
- I-08 (M): mirror response body has no size cap → memory bloat.
- I-09 (M): mirror `fetch` has no timeout — slow body wedges
  reconcile (no `AbortSignal.timeout`). Add 8s.
- I-10 (M): cron endpoint has CRON_SECRET only, no rate limit. Add
  10/60s.
- I-11 (L): rate-limit identity is bearer-token prefix; should be
  `auth.accountId` (rotation bypass).
- I-13 (L): Discord webhook accepts `@everyone` mentions in
  `causeMsg`; strip/escape.
- I-14 (L): force-release on unsupported `entry.kind` holds the
  60s lock unnecessarily; validate before lock acquire.

**Files:** `app/api/admin/uncertain-tx/[id]/force-release/route.ts`,
`src/custodial/uncertainTxVerification.ts`, `src/hedera/refund.ts`,
`src/lib/escalation.ts`, `app/api/cron/reconcile/route.ts`,
`app/api/_lib/rateLimit.ts`.

**Fix:** as listed above; each is a small, isolated change.

**Test:** one assertion per item; bundle into a `force-release.input-validation.test.ts` and `mirror-fetch-timeout.test.ts`.

---

## Phase 2 — Refund correctness (6 items)

### `[x]` F6 (C) — Refund verifier intermediate `stampProgress`
**Closes:** U-03

**Bug:** refund verifier (`verifyUncertainRefunds`) stamps markers
ONLY at the resolve write — no intermediate `stampProgress` between
ledger debit, audit write, claim release. A single resolve-write
failure → all post-conditions re-run on next pass → guaranteed
double-debit on user's `available` + duplicate HCS-20 burn op.
Asymmetric with the withdrawal verifier.

**Files:**
- `src/hedera/refund.ts:619-977` (`verifyUncertainRefunds`)

**Fix:** stamp `ledgerAdjustedAt` immediately after `updateBalance`,
stamp `auditWrittenAt` immediately after `recordRefund`. Mirrors
withdrawal verifier's pattern. Folds in F1's accumulator semantics.

**Test:** `'verifyUncertainRefunds: a resolve-write failure after ledger debit does not double-debit on retry'`.

---

### `[x]` F7 (H) — Refund of fully-spent deposit guard
**Closes:** U-04

**Bug:** `processRefund` doesn't check whether the deposit has been
consumed. User deposits 100, plays 100 (operator pays contract
fees), operator processes refund of original tx → user gets 100
HBAR back AND keeps the play entries. Operator wallet out 200
on a 100 deposit. No Redis failure, no race, no compromise — one
operator click.

**Files:**
- `src/hedera/refund.ts:96-583` (`processRefund`)

**Fix:** after deposit-validation, check
`user.balances.tokens[tokenKey].available + reserved >= humanRefundAmount`
(or compute `unspent = totalDeposited - settled_plays - withdrawn`).
Reject 4xx; allow operator to specify partial refund amount.

**Test:** `'processRefund refuses to refund a deposit whose net unspent balance is less than gross amount'`.

---

### `[x]` F8 (M) — Refund debits user from deposit record, not memo
**Closes:** U-06

**Bug:** Alice deposits to agent with Bob's `depositMemo`
(published / guessable). DepositWatcher routes to Bob, Bob's
balance += 100. Operator refunds the tx → on-chain refund pays
Alice (original sender) but ledger debits Bob (memo lookup).

**Files:**
- `src/hedera/refund.ts:419-475` (`processRefund` ledger debit)

**Fix:** look up by `transactionId` via `store.getDepositByTxId(originalTxId).userId`
rather than re-resolving via memo at refund time. Memo lookup is
correct at deposit time; wrong key at refund time.

**Test:** `'processRefund debits the user from the deposit record, not from getUserByMemo'`.

---

### `[x]` F9 (C) — Operator rake reversal on refund
**Closes:** OP-01

**Bug:** rake-on-deposit credits `op.balances[token] += rakeAmount`.
Refund returns gross deposit but never reverses the rake. Operator's
local fee balance stays inflated by `rakeAmount` for every refunded
deposit. Reconcile shows persistent insolvency (`wallet < users + operator`)
by exactly `rakeAmount` per refund.

**Files:**
- `src/hedera/refund.ts:455-461` (ledger debit), `src/custodial/UserLedger.ts:122-146` (rake credit on deposit)
- `src/custodial/AccountingService.ts` (need new op for rake reversal)

**Fix:** persist `rakeAmount` on the `DepositRecord` at credit time
(might already be there — verify). On refund SUCCESS branch (both
in-band and verifier paths), reverse: `op.balances[token] -= rakeAmount`.
Emit a v2 `rake_reversal` audit op so the topic reflects the reversal.

**Test:** `'processRefund reverses operator rake on refund of credited deposit'`.

---

### `[x]` F10 (H) — Refund verifier claim semantics
**Closes:** SM-13

**Bug:** verifier confirms FAILED → DELs `details.claimKey` →
resolve write throws → `!resolvedAt` → operator force-releases →
DELs claim again (no-op) → resolve marker written → user submits
NEW refund for same originalTxId → claim wins (no marker) →
second on-chain refund fires.

**Files:**
- `src/hedera/refund.ts:740-768`

**Fix:** on confirmed FAILED, OVERWRITE the claim to `failed:<refundTxId>`
with 30d TTL instead of `DEL`. Resolve write can then be safely
retried; replay protection survives the resolve-write failure window.

**Test:** `'verifier crashes after claim DEL but before resolve; subsequent refund attempt is rejected as duplicate'`.

---

### `[x]` F11 (M) — `isDepositCredited` uses recorded, not claimed
**Closes:** OP-07

**Bug:** `isDepositCredited` returns true on the SADD claim. SADD
lands in Redis BEFORE `creditDeposit` actually records the deposit;
on lock contention or partial failure, the SADD persists but no
`DepositRecord` exists. A parallel refund call passes the gate and
refunds a never-credited deposit — wallet shorts by full amount.

**Files:**
- `src/hedera/refund.ts:112-118` (the gate)
- `src/custodial/UserLedger.ts:53-211` (`creditDeposit`)
- `src/custodial/IStore.ts` (need `isDepositRecorded` query)

**Fix:** `isDepositRecorded(txId)` checks `getDepositByTxId(txId) !== undefined`.
Refund uses the recorded gate, not the claimed gate. The SADD claim
remains at-most-once protection but isn't the gate for refund.

**Test:** `'processRefund refuses tx that was claimed but not recorded'`.

---

## Phase 3 — Force-release rewrite (4 items)

### `[ ]` F12 (C) — Force-release SUCCESS branches mirror verifier post-conditions for ALL kinds
**Closes:** A-08, A-09, A-10, U-01, U-02, U-09, OP-06, SM-07, partial DR-06

**Bug:** today the operator-fee branch correctly settles+audits on
mirror=SUCCESS (Pass-3 fix). Withdrawal/play/refund branches don't —
they only release the reserve/claim while the on-chain tx already
paid out. One-click double-spend if operator uses the override.
After this fix, mirror=SUCCESS auto-runs the verifier's post-conditions
for every kind, so `acknowledgeDoubleSpendRisk` flag is redundant
and can be dropped.

**Files:**
- `app/api/admin/uncertain-tx/[id]/force-release/route.ts:240-271` (withdrawal),
  `:393-424` (play), `:425-448` (refund)
- Each branch needs to mirror the operator-fee SUCCESS path
  (`:297-390`) — read `priorMarkers`, run idempotent post-conditions
  (settle / audit), stamp markers, write resolve.

**Fix per kind:**
- `withdrawal_uncertain` SUCCESS → `settleSpend` + `totalWithdrawn += amount`
  + `recordWithdrawal` (history) + `accounting.recordWithdrawal` (audit)
  with the same `settledAt`/`totalWithdrawnAt`/`historyWrittenAt`/`auditWrittenAt`
  markers. Only `releaseReserve` on FAILED/NOT_FOUND.
- `play_uncertain` SUCCESS → KEEP reservations held (no release)
  AND emit a `play_session_aborted` (or new `manual_settlement_pending`)
  v2 anchor (folds with F16). Operator must reconstruct settlement.
- `refund_uncertain` SUCCESS → `updateBalance(available -= humanRefundAmount)`
  + `recordRefund` audit anchor + claim-overwrite-to-resolved
  (same as F10's claim semantics).

**Drop:** `acknowledgeDoubleSpendRisk` flag entirely. Mirror=SUCCESS
auto-settles correctly; mirror=FAILED/NOT_FOUND releases; mirror=transient
returns 503 retry-shortly. No need for an "ack" override path.

**Test:**
- `'force-release withdrawal_uncertain mirror=SUCCESS: settles, debits totalWithdrawn, writes audit anchor'`
- `'force-release play_uncertain mirror=SUCCESS: keeps reservations held, emits manual-triage anchor'`
- `'force-release refund_uncertain mirror=SUCCESS: writes refund anchor + ledger debit, retains claim as resolved'`
- `'acknowledgeDoubleSpendRisk flag is rejected as unknown body field'` (regression — ensure removal is enforced)

---

### `[ ]` F13 (H) — Force-release reads progress markers before mutating
**Closes:** SM-09

**Bug:** force-release `withdrawal_uncertain` branch unconditionally
calls `releaseReserve` regardless of whether the verifier already
stamped `settledAt` (and thus already moved the reserve to settled).
Releasing the reserve after settlement re-credits the user.

**Files:**
- `app/api/admin/uncertain-tx/[id]/force-release/route.ts:240-271`

**Fix:** mirror the operator-fee branch — read `priorMarkers` from
`entry.details`, branch on which steps already happened. If
`settledAt` already set, settlement happened — releasing the reserve
is wrong. (Folds into F12's rewrite.)

**Test:** `'force-release withdrawal_uncertain with settledAt set is no-op on reserve'`.

---

### `[ ]` F14 (H) — Force-release operator-fee SUCCESS marker ordering
**Closes:** OP-03, SM-10, C-03

**Bug:** route mutates Redis (debit operator) at line 312, THEN
stamps `operatorDebitedAt` at line 324. Lambda freeze in between
returns 500 to the operator and leaves Redis with a debited operator
state but no marker. Next reconcile sees `!operatorDebitedAt`, debits
again. Same shape inside the verifier (`uncertainTxVerification.ts:632-650`).

**Files:**
- `app/api/admin/uncertain-tx/[id]/force-release/route.ts:308-340`
- `src/custodial/uncertainTxVerification.ts:632-650`

**Fix:** stamp `operatorDebitedAt` BEFORE the mutation (accept the
inverse failure mode: marker stamped but mutation skipped — but
this is detectable by `flush()` succeeding-then-failing being rare,
and we can audit-orphan it). Better: fold both writes into a single
`updateOperator` callback that mutates state AND sets the marker
in the same Redis pipeline.

**Test:** `'force-release operator_fee SUCCESS: marker write failure does not leave double-debit window'`.

---

### `[ ]` F15 (M) — Force-release refuses already-triaged play_uncertain
**Closes:** SM-04

**Bug:** if a `play_uncertain` SUCCESS-triaged entry is somehow
re-opened (manual operator edit, replay), force-release would
release reservations even though on-chain play succeeded.

**Files:**
- `app/api/admin/uncertain-tx/[id]/force-release/route.ts:139` (current filter)

**Fix:** check `details.successTriagedAt` flag (set by F16's
manual-triage anchor write). If present, refuse with 409.

**Test:** `'force-release refuses play_uncertain whose details.successTriagedAt is true'`.

---

## Phase 4 — Audit anchor symmetry (7 items)

### `[ ]` F16 (C) — `play_uncertain` SUCCESS audit anchor
**Closes:** A-06, DR-04

**Bug:** verifier's `play_uncertain` SUCCESS branch emits NO HCS-20
message — only escalates and resolves. On-chain play landed, funds
moved, but topic has no record. Redis-only (reservation held + DL
row) is the only evidence. Redis loss → user reconstructs as full
pre-play balance, operator wallet permanently short.

**Files:**
- `src/custodial/uncertainTxVerification.ts:825-852`

**Fix:** before escalating + resolving, emit a v2 anchor — either
a `play_session_aborted` with reason `'reconcile_success_pending_triage'`
or a new `op: 'manual_settlement_pending'` carrying
`{ uncertainTxId, userId, tokenReservations, mirrorResult: 'SUCCESS' }`.
Stamp `successTriagedAt` on the entry (used by F15).

**Test:** `'play_uncertain SUCCESS branch emits manual-triage audit anchor before resolving'`.

---

### `[ ]` F17 (H) — In-band audit failure → `audit_trail_orphaned`
**Closes:** A-01, A-02, A-03

**Bug:** in-band paths (`MultiUserAgent.ts`) silently swallow
`accounting.record*` failures with empty catches. The verifier
paths since 0.3.4 correctly write `audit_trail_orphaned`; the
in-band paths were never updated.

**Files:**
- `src/custodial/MultiUserAgent.ts:1283-1301` (withdraw),
  `:1533-1553` (operator-fee withdraw), `:404-425` (strategy change)

**Fix:** in each catch, write `audit_trail_orphaned` with replay
params (mirror force-release's pattern at `force-release/route.ts:369-385`).
Each must call `escalateUncertainDlFailure` so operators page on it.

**Test:**
- `'in-band withdrawal: audit failure writes audit_trail_orphaned with all retry params'`
- `'withdrawFees: audit failure writes audit_trail_orphaned, debit already applied'`
- `'updateUserStrategy: audit failure writes audit_trail_orphaned with replay params'`

---

### `[ ]` F18 (H) — Burn body-level idempotency key
**Closes:** A-13, DR-10, MO-2b

**Bug:** `recordWithdrawal` and `recordOperatorWithdrawal` v1 burn
messages have no `withdrawTxId` field. Reader can't dedup. After
Redis loss + reseed, verifier re-runs and emits a duplicate burn —
reader sums two burns → user `totalWithdrawn = 2N`. Also blocks
the phantom-mint cross-check (F21) because there's no canonical
on-chain reference to verify.

**Files:**
- `src/custodial/AccountingService.ts:242-256` (`recordWithdrawal`),
  `:280-295` (`recordOperatorWithdrawal`) — verify exact lines
- `src/custodial/hcs20-reader.ts` — burn parser (add dedup on
  `withdrawTxId`)

**Fix:** extend both `record*Withdrawal` to require `withdrawTxId`,
embed in the v1 message body (`memo: 'withdrawal:<txId>'` or a
new field — verify schema constraints). Reader dedups by
`withdrawTxId`. Update all call sites (`MultiUserAgent.ts` in-band
+ `uncertainTxVerification.ts` verifier + force-release route).

**Test:** `'recordWithdrawal includes withdrawTxId so duplicates are detectable'` + a reader test that two burns with the same `withdrawTxId` collapse to one withdrawal event.

---

### `[ ]` F19 (M) — Verifier audit-orphan carries replay params
**Closes:** A-04, A-15

**Bug:** orphan rows from withdrawal/operator-fee verifier audit
failures drop `recipientAccountId`, `withdrawTxId`, `agentAccountId`.
Manual replay can't reconstruct without joining against the original
DL row (fragile if purged).

**Files:**
- `src/custodial/uncertainTxVerification.ts:505-511` (withdrawal),
  `:680-686` (operator-fee)

**Fix:** splat all replay-needed fields into the orphan details.

**Test:** `'orphan carries enough detail to replay both the control event and the kind-specific anchor'`.

---

### `[ ]` F20 (H) — `verify-audit.ts` extensions
**Closes:** DR-02, DR-06

**Bug:** `verify-audit.ts` doesn't reduce `operator_withdrawal`
events into operator state — the standalone DR tool produces no
operator ledger. Reader strips `mirrorResult`/`kind`/`uncertainTxId`
from `force_release` control events, so `verify-audit.ts` can't
surface override warnings.

**Files:**
- `src/scripts/verify-audit.ts:265-303` (event reducer)
- `src/custodial/hcs20-reader.ts:360-373` (`parseControlEvent`)

**Fix:** add `operator_withdrawal` reducer accumulating
`operator.balances[token] -= amount`, `totalWithdrawnByOperator[token] += amount`.
Add `rake` reducer for `operator.balances[token] += rakeAmount`.
Reader's `parseControlEvent` preserves `mirrorResult`, `kind`,
`uncertainTxId`. `verify-audit.ts` lists `force_release_override`
rows as warnings.

**Test:** `'verify-audit reconstructs operator state from rake + operator_withdrawal events'` + `'verify-audit surfaces force_release_override events as warnings'`.

---

### `[ ]` F21 (H) — Phantom mint cross-check in `verify-audit.ts`
**Closes:** MO-2

**Bug:** reader trusts the topic. A compromised operator (with
topic submit key) can submit a `mint` op with a `depositTxId` that
never landed on chain. `verify-audit.ts` aggregates it into
`totalDeposited` unconditionally. Phantom mints survive standalone
replay.

**Files:**
- `src/scripts/verify-audit.ts:267-270` (mint reducer)

**Fix:** for every `mint` op, fetch
`GET <mirror>/transactions/<depositTxId>` and verify SUCCESS +
positive transfer to `agentAccountId` matching `amt`. Mismatch →
critical flag in output. Same check for `refund.refundTxId` and
withdraw burns once F18 lands.

**Test:** `'verify-audit flags phantom mint with non-existent depositTxId as CRITICAL'`.

---

### `[ ]` F22 (H) — HCS-20 anchor for killswitch + boot-time escalation URL check
**Closes:** MO-6, SM-11

**Bug:** `enableKillSwitch` / `disableKillSwitch` write Redis only,
no audit anchor. Operator can pause the agent or silence escalation
(unset env at deploy time) with zero on-chain footprint. The
`recordControlEvent` op type for `killswitch_*` exists but isn't
called.

**Files:**
- `src/lib/killswitch.ts:111-130` (toggles)
- `src/lib/escalation.ts:34` (silent no-op when env unset)
- `app/api/_lib/mcp.ts` or boot path (production assertion for
  `RECONCILE_FAILURE_WEBHOOK_URL`)

**Fix:** killswitch toggles call `accounting.recordControlEvent('killswitch_enabled' | 'killswitch_disabled', ...)` BEFORE Redis write. Production boot refuses without `RECONCILE_FAILURE_WEBHOOK_URL` (mirror existing Upstash assertion). Escalation also writes an HCS-20 anchor when it fires, so silencing the webhook still leaves a topic trail.

**Test:**
- `'enableKillSwitch writes HCS-20 anchor before Redis flip'`
- `'production boot refuses without RECONCILE_FAILURE_WEBHOOK_URL'`

---

## Phase 5 — Concurrency & recovery (5 items)

### `[ ]` F23 (H) — Per-user lock in verifier paths
**Closes:** C-06

**Bug:** verifier's `releaseReserve` / `settleSpend` /
`updateBalance` mutate per-user state without acquiring `lockUser:<userId>`.
Races active withdraw / play / refund paths. Breaks `available + reserved <= deposited` invariant across the two writers.

**Files:**
- `src/custodial/uncertainTxVerification.ts:374` (FAILED branch),
  `:422-466` (SUCCESS branch),
  `:791-803` (play FAILED)
- `src/hedera/refund.ts` ledger-adjust block

**Fix:** wrap each per-user mutation in `acquireUserLock(userId)` /
release. Mirror `processRefund`'s pattern (`refund.ts:445-451`).
On failed acquire (contention with active flow), defer to next
reconcile pass with a `still_uncertain` outcome.

**Test:** `'verifyUncertainPlays releaseReserve serializes against concurrent withdraw via per-user lock'`.

---

### `[ ]` F24 (H) — In-band operator-fee withdraw: pre-submit pending claim
**Closes:** OP-02

**Bug:** gap between `awaitReceipt` resolving and `store.updateOperator`
firing. Lambda freeze in that window + retry with new idempotency
key = double-pay (same-token re-spend). No DL was written; open-DL
guard misses it.

**Files:**
- `src/custodial/MultiUserAgent.ts:1468-1530`

**Fix:** stamp a `pending_operator_withdraw:<txId>` SET-NX-EX claim
in Redis before the on-chain submit; resolve it after `updateOperator`
flush. Open-DL guard reads it. Mirror refund's pattern.

**Test:** `'withdrawOperatorFees: simulated freeze after awaitReceipt does not double-pay on retry with new idempotency key'`.

---

### `[ ]` F25 (H) — Verifier transient-error releases lock
**Closes:** SM-01

**Bug:** lock acquired then mirror returns transient → `still_uncertain`
returned, no state mutated, but lock held 60s. Cron at 5min cadence
× transient mirror = entry wedged.

**Files:**
- `src/custodial/uncertainTxVerification.ts:347-356`, `:581-589`,
  `:764-773`
- `src/hedera/refund.ts:710-719`

**Fix:** DEL lock on no-mutation paths (transient or recent NOT_FOUND).
Use fence value (UUID) so it's safe.

**Test:** `'transient mirror error releases verifier lock so next pass can re-attempt within TTL'`.

---

### `[ ]` F26 (M) — Verifier releases lock after resolve
**Closes:** C-02, SM-03

**Bug:** lock held 60s after work done (verifier never DELs).
Force-release on a different valid txId can collide cosmetically.
More importantly, if `markResolved` fails (logged, swallowed),
entry stays unresolved AND lock blocks force-release for ~55s.

**Files:**
- `src/custodial/uncertainTxVerification.ts:521`, `:695`, `:809`
- `src/hedera/refund.ts:935-959`

**Fix:** DEL lock with fence at end of per-entry block (mirror
`releaseUserLock`). Also: pre-stamp `resolveMarkAt` before resolve
write so retry-after-failure can short-circuit.

**Test:** `'verifier releases per-txId lock after successful resolve'`.

---

### `[ ]` F27 (M) — 24h NOT_FOUND uses txId timestamp
**Closes:** SM-06

**Bug:** policy uses `entry.timestamp` (write-time clock). Lambda
clock skew → 24h policy fires immediately → reserve released → tx
lands → operator drained.

**Files:**
- `src/custodial/uncertainTxVerification.ts:155-158` (`applyNotFoundMaxAge`)
- `src/hedera/refund.ts:723`

**Fix:** parse Hedera txId's embedded valid-start nanoseconds
(`0.0.X@<seconds>.<nanos>`); compare against that. Falls back to
`entry.timestamp` only when txId parse fails.

**Test:** `'24h max-age uses txId timestamp not entry.timestamp'`.

---

## Deferred (follow-up branch — 11 items)

| ID | Title | Closes | Sev |
|----|----|----|----|
| `[-]` D1 | Force-release minimum age (10min) before override | MO-7 | M |
| `[-]` D2 | Strategy hash anchored on `strategy_change` + `play_session_open` | MO-8 | M |
| `[-]` D3 | agentSeq seed validation against tampered Redis pre-seed | MO-4, MO-11, DR-08 | M |
| `[-]` D4 | `prize_recovery` EVM address verified by `verify-audit.ts` | MO-10 | M |
| `[-]` D5 | `recover-stuck-prizes` records gas in `gasTracker` | OP-05 | L |
| `[-]` D6 | Pending refund adjustment blocks new reserves | U-10 | M |
| `[-]` D7 | Deposit-credit orphan-claim sweep | U-07 | L |
| `[-]` D8 | Token-key normalization at DL boundary | U-11 | L |
| `[-]` D9 | Re-uncertain protection (resolved entries one-way) | SM-15 | L |
| `[-]` D10 | Atomic INCR for malformed-attempt counter | SM-12 | L |
| `[-]` D11 | Topic-spam mitigation (mirror-side filter) | MO-9 | L |

## Accepted residual (3 items)

| ID | Title | Closes | Decision |
|----|----|----|----|
| `[-]` A1 | Session impersonation by operator (Redis write) | MO-5 | Document as residual; non-custodial design future work |
| `[-]` A2 | Confirmed-FAILED uncertain entries write no anchor | A-05, DR-03 | Deliberate; document explicitly in `hcs20-v2-schema.md` |
| `[-]` A3 | Force-release cannot redirect funds (defensive note) | MO-1 | Noted; no change |

## Update procedure

When starting an item: change `[ ]` → `[~]`, add date.
When done: change `[~]` → `[x]`, add date + commit SHA.
When deferring: change to `[-]` with reason.
