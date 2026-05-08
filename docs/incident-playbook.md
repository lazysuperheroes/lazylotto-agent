# LazyLotto Agent Incident Playbook

> Symptom → action runbook for the failure modes we've actually
> seen, plus a few we've designed for. Each entry tells you how to
> recognize the problem, what to check, and the exact tool/command
> to run to fix it.

This is operator-facing. If you're paged at 2am, start here.

---

## TL;DR — what's the kill switch and how do I use it?

**The kill switch pauses new plays and registrations but keeps
withdrawals open.** It's the safest first move when something is
wrong and you don't know what yet.

- **Enable**: `/admin` → top of page → "Engage" button (or POST to
  `/api/admin/killswitch` with `{ enabled: true, reason: "investigating" }`)
- **Disable**: Same place, "Disengage" button after the issue is fixed
- **Effect**: any in-flight play or withdrawal completes; new requests
  return 503 with the reason. Users see a banner on the dashboard.

Always engage the kill switch before doing destructive ops (refunds,
recovery, schema migration). Always disengage it after.

---

## Symptom 1 — User reports prizes not showing up on the dApp

**You'll see this from**: a user message ("I won X but my wallet has Y"),
or the prize transfer dead-letter count growing in `/admin`.

### Diagnosis

1. Get the affected user's Hedera account ID.
2. Run the recovery script in **dry-run** mode first:
   ```bash
   npx tsx src/scripts/recover-stuck-prizes.ts <userAccountId>
   ```
3. Look at the output:
   - "Pending count: 0" on the agent wallet → no stuck prizes; the
     user is wrong, OR they already claimed via the dApp. Check the
     dApp directly.
   - "Pending count: N > 0" → confirmed stuck. The script will list
     what's there (HBAR, LAZY, NFTs).
4. Check if the user has `pendingPrizes > 0` already on their EOA
   side — that means previous transfers worked but the user just
   hasn't claimed yet. Tell them to visit
   `https://testnet-dapp.lazysuperheroes.com/lotto/prizes` (or the
   mainnet equivalent) and click claim.

### Fix

If there are stuck prizes in the agent wallet, run the recovery
**for execute**:

```bash
npx tsx src/scripts/recover-stuck-prizes.ts <userAccountId> \
  --execute --reason "stuck prize recovery — incident <id>"
```

Or via the operator MCP tool from Claude Desktop:

```
Run operator_recover_stuck_prizes for user <userAccountId>
with execute=true and reason="incident <id>"
```

The script:
- Reads the agent wallet's pending prize list via dApp MCP
- Calls `transferPendingPrizes` with the escalating gas ladder
  (225K → 300K → 400K per prize, capped at 14M)
- Records a `prize_recovery` op on the HCS-20 audit topic
- Marks any matching `prize_transfer_failed` dead letters as
  resolved

### Verify the fix

```bash
# Reader against live topic — should now show prize_recovery event
npx tsx src/scripts/test-v2-reader.ts | grep prize_recovery
```

Tell the user to visit the dApp and click Claim. Their prizes
should be there.

### Prevent recurrence

The retry-with-escalating-gas ladder shipped in commit `6a8c85b`
covers `INSUFFICIENT_GAS`. Other failure modes are now dead-lettered
and visible in `/admin`. If you see this happening repeatedly, it's
probably a contract change or a new failure mode worth investigating.

---

## Symptom 2 — Reconciliation page shows insolvent OR unaccounted balances

**You'll see this from**: `/admin` → reconcile → red warning banner,
or the cron reconcile webhook firing.

### Diagnosis

The reconcile output includes:
- `solvent: true | false` — false means on-chain has LESS than the
  ledger thinks users are owed (DANGER — somebody's funds are at risk)
- `delta` per token — raw `on-chain - ledger` difference
- `adjustedDelta` per token — after subtracting tracked gas, network
  fees, etc.
- `warnings[]` — human-readable explanation of the deltas

Common cases:

| Pattern | Meaning |
|---|---|
| `solvent: false`, `delta < 0` | INCIDENT. On-chain wallet has less than the ledger expects. Either funds were lost OR a refund/withdrawal happened that wasn't recorded in the ledger. |
| `solvent: true`, `unaccounted` warning, positive delta | On-chain has MORE than the ledger expects. Could be ghost deposits (funds in wallet without a memo), operator top-ups, or unclaimed prizes that came back to the agent. Not urgent but worth tracing. |
| `pending ledger adjustment` warning | A refund couldn't grab the user lock and queued an adjustment. Run drain. |

### Fix — solvent: false

1. **Engage kill switch immediately** (`/admin` → engage)
2. **Snapshot the state** — copy the reconcile output, the user list,
   the recent dead letters
3. **Run the audit reader** against the topic to see what's actually
   recorded: `npx tsx src/scripts/test-v2-reader.ts`
4. **Check the agent wallet** on HashScan for any unexpected outflows
   in the last 24 hours
5. **DO NOT** process new refunds or withdrawals until the gap is
   explained
6. Once the gap is explained and the ledger is corrected, disengage
   the kill switch

### Fix — pending ledger adjustment queued

These accumulate when a refund couldn't grab the user lock. Drain
the queue:

```bash
# Via the admin MCP tool from Claude Desktop:
Ask Claude: "Drain pending ledger adjustments"
```

Or via the API:

```bash
curl -X POST https://agent.lazysuperheroes.com/api/admin/drain-pending-ledger \
  -H "Authorization: Bearer sk_OPERATOR_TOKEN"
```

Then re-run reconcile to confirm the warning cleared.

---

## Symptom 3 — Dead letter queue accumulating

**You'll see this from**: `/admin` → dead letters count > 0 in the
admin badge, or the cron firing if you set a threshold.

### Diagnosis

Dead letters come in two `kind`s now:

- **`deposit_failed`**: a deposit landed in the agent wallet but
  couldn't be credited (wrong memo, unknown token, exceeds max
  balance, sent to deregistered user). Sender + memo + amount are
  in the entry.
- **`prize_transfer_failed`**: a play session won prizes but the
  transferPendingPrizes call exhausted the retry ladder. The userId,
  sessionId, prizesByToken, and attemptsLog are in the `details` bag.

### Fix — deposit_failed

Choose one:

1. **Refund** the original deposit back to the sender:
   ```
   Ask Claude: "Refund transaction <txId> with reason stuck_deposit"
   ```
   Or via curl with operator token:
   ```bash
   curl -X POST https://agent.lazysuperheroes.com/api/admin/refund \
     -H "Authorization: Bearer sk_OPERATOR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"transactionId":"0.0.X@..."}'
   ```
2. **Manually credit** to a user (rare — only if you know the deposit
   was meant for a specific user but the memo was wrong). Walk the
   `creditDeposit` flow manually. Document why in the dead letter
   resolution notes.

### Fix — prize_transfer_failed

Run the recovery tool for the affected user (see Symptom 1). The
recovery will mark the dead letter as resolved automatically.

### Verify

After fixing, re-check the dead letter count. It should drop. If a
fixed dead letter is still in the queue with `resolvedAt: null`,
manually mark it resolved via the admin API.

---

## Symptom 4 — Audit reader shows `corrupt` sessions

**You'll see this from**: `/audit` page → a SessionCard with red
"CORRUPT" badge and warnings.

### Diagnosis

A session is `corrupt` if:
- **Pool count mismatch**: the close message claims N pools played
  but the reader saw a different number of pool messages
- **poolsRoot mismatch**: the reader's recomputed Merkle hash from
  the observed pool messages doesn't match what the close message
  claims

The first usually means a pool message was dropped between write
and read. The second means either:
1. The writer lied (tampering — unlikely since we control the writer)
2. The reader's hash function diverged from the writer's
3. A bug in `computePoolsRoot` was introduced and one side wasn't
   updated

### Fix

1. Run the test-v2-reader script to confirm: `npx tsx src/scripts/test-v2-reader.ts`
2. Check the affected sessionId on HashScan to inspect the raw
   topic messages
3. If the reader's `agentSeqGaps` stat is non-zero for the affected
   agent, dropped messages are the cause — investigate why writes
   failed (Vercel function timeout? HCS topic temporarily unavailable?)
4. If the hash function diverged, find the recent commit to
   `computePoolsRoot` in `src/custodial/hcs20-v2.ts` and roll
   forward a fix (NOT a rollback — old messages can't be rewritten)
5. Add a regression test to `hcs20-reader.test.ts`

This is a "pause and investigate" situation. Engage the kill switch
while you debug.

---

## Symptom 5 — Operator-LAZY bleed (per-token spend leak)

**You'll see this from**: `/admin` reconcile showing LAZY on-chain
> ledger by a meaningful amount, with no corresponding `creditDeposit`
events recently.

### Diagnosis

This is the bug we fixed in Stage 2 (commit `1a0adba`). If you see
it post-fix, it means the regression test
(`'HBAR-only user only has HBAR in the reservation set'` in
`MultiUserAgent.test.ts`) was bypassed somehow. Check:

1. Are the per-token reservation tests still passing?
   ```bash
   npx tsx --test src/custodial/MultiUserAgent.test.ts
   ```
2. Does any user have a `tokenBudgets` entry for a token they have
   0 balance in? (Shouldn't matter post-fix, but worth checking.)
3. Is there a recent strategy override that bypasses the
   `restrictedFeeToken` logic?

### Fix

If the regression has somehow returned, the immediate stop-gap is:

1. **Engage kill switch**
2. Force every user's strategy `poolFilter.feeToken` to a single
   value matching their balance (manual edit via Redis CLI or
   admin tool if one exists)
3. Investigate the regression in `MultiUserAgent.playForUser`
4. Ship a fix with a new test that locks the bug down
5. Disengage kill switch

The 240 LAZY currently in the agent wallet (operator bootstrap)
is unrelated and intentional — see `WORKING_PLAN.md` for context.

---

## Symptom 6 — MCP endpoint returning HTML 500 page

**You'll see this from**: `curl POST /api/mcp` returning HTML
instead of JSON-RPC, or Claude Desktop showing "tool call failed
with no message".

### Diagnosis

This shouldn't happen post commit `46f7094` (process-level
unhandledRejection handler) but if it does:

1. Check Vercel function logs for `[mcp] UNHANDLED REJECTION` or
   `[mcp] UNCAUGHT EXCEPTION` lines
2. Check the `X-Vercel-Id` response header — `lhr1::iad1::xxx-`
   means the function ran (look at logs); `lhr1::xxx-` (no origin
   region) means the function was killed before responding (more
   serious — process crash)

### Fix

Process crash is usually:
- Out of memory (Vercel functions are 1GB by default)
- Unhandled error in the SDK's async dispatch chain
- Cold-start init failure (e.g. Hedera client throwing because
  of missing env vars)

Check Vercel logs, fix root cause, redeploy. If the unhandled
rejection handler is missing or got removed in a refactor, restore
it from `app/api/mcp/route.ts`.

---

## Symptom 7 — `/api/health` is down

**You'll see this from**: external uptime monitor pages you, or
`curl /api/health` returns 5xx.

### Diagnosis

`/api/health` is the simplest possible endpoint — no auth, no
downstream calls, just returns `{status, network, version,
timestamp}`. If it's down, the entire deployment is hosed.

1. Check Vercel project status — is the deployment "Ready"?
2. Check Vercel function logs for the health route
3. Try the auto-generated Vercel URL directly (bypassing custom DNS)

### Fix

- If the deployment failed: roll back to the last good deploy via
  Vercel UI
- If DNS is the issue: revert the CNAME or wait for propagation
- If the function itself is broken (extremely unlikely given how
  small it is): redeploy or rollback

---

## Symptom 8 — Operator key compromise (suspected or confirmed)

**You'll see this from**: unexpected outflows from the agent wallet on
HashScan, the reconcile cron firing with unexplained negative deltas,
suspicious `/api/auth/verify` activity, an alert from a security
service, OR — best case — a teammate noticing a leak before damage.

This is a P0. Stop reading the rest of this playbook and execute the
seven steps below in order.

### Step 1 — Engage the kill switch with a key-compromise reason

```
/admin → Engage → reason: "key compromise — investigating <date>"
```

Or via API:

```bash
curl -X POST https://agent.lazysuperheroes.com/api/admin/killswitch \
  -H "Authorization: Bearer sk_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"reason":"key compromise - investigating"}'
```

What this stops: new plays, new registrations.
What it does NOT stop: withdrawals, reads. Users can still get out.

### Step 2 — Drain operator-controlled float to a cold wallet

Don't wait for the rotation. The current operator key is presumed
hostile-controllable; move the working-capital float out of reach
immediately.

```bash
# From an operator-tier session (wallet auth, OPERATOR_ACCOUNTS):
operator_withdraw_fees amount=<all-HBAR> to=<cold-wallet> token=HBAR
operator_withdraw_fees amount=<all-LAZY> to=<cold-wallet> token=LAZY
```

Or the corresponding REST endpoints. Pick a Hedera account YOU control
that the compromised key has never touched. Hardware-wallet preferred.

Note: this only drains the operator float (rake collected, gas pool).
User-deposited balances stay where they are — they'll be reconciled in
Step 5 from the HCS-20 trail.

### Step 3 — Rotate the Hedera operator key

1. Generate a new keypair (HashPack or `hedera-cli`):
   ```bash
   # Locally — DO NOT echo the private key into terminal scrollback
   node -e "import('@hashgraph/sdk').then(({PrivateKey})=>{const k=PrivateKey.generateED25519();console.log('PUB:',k.publicKey.toStringDer());require('fs').writeFileSync('/tmp/newkey.txt',k.toStringDer(),{mode:0o600});})"
   ```
2. Update the Hedera account's key on-chain via `AccountUpdateTransaction`
   signed by the OLD key (this is the key-compromise paradox — if the
   old key is leaked, an attacker could race you. Do this BEFORE the
   attacker realizes the leak is detected, or after rotating to a
   throwaway account first):
   ```bash
   npx tsx src/scripts/rotate-operator-key.ts \
     --account-id <agent-account> \
     --old-key-file /tmp/oldkey.txt \
     --new-public-key <pub-from-step-1>
   ```
   *(If this script doesn't exist yet — write it as part of the
   pre-mainnet runbook hardening. The transaction is a 4-line SDK call.)*
3. Update Vercel environment variables (Sensitive mode):
   - `HEDERA_PRIVATE_KEY` = new private key (DER hex)
   - Trigger a redeploy
4. Verify: `agent_status` returns the operator EVM address; the new key
   signs a test no-op transaction successfully.

### Step 4 — Revoke all live sessions

A leaked operator key may have been used to mint sessions. Wipe them.

```bash
# Flushes the entire `lla:<network>:session:*` and account-sessions space.
# Requires Upstash CLI access OR a one-shot operator endpoint.
upstash redis cli "EVAL \"for _,k in ipairs(redis.call('KEYS','lla:'..ARGV[1]..':session:*')) do redis.call('DEL',k) end\" 0 testnet"
```

Re-issue admin/operator sessions by signing fresh wallet challenges.

### Step 5 — Reconcile from HCS-20 (no operator state needed)

The audit topic is the source of truth for what users are owed.

```bash
npx tsx src/scripts/verify-audit.ts \
  --topic <HCS20_TOPIC_ID> \
  --json > /tmp/post-incident-ledger.json
```

For each user, compare reconstructed balance against current Redis
state. Discrepancies (caused by attacker-issued operations not present
in Redis, or by Redis ops that didn't reach the topic) become Phase 2
items — fund users from the cold wallet to match the audit-trail
balance.

### Step 6 — User communication

- **Status page / dashboard banner**: "We detected unauthorized access
  to operator infrastructure. The agent has been paused. Withdrawals
  remain available. We will publish a post-incident report within 72
  hours."
- **No specific account-level outreach** until Step 5 reveals which
  users were affected (if any).
- **Do NOT publish the rotation timeline or the new operator account
  address** until you're certain no further compromise is in progress.

### Step 7 — Post-incident

After the system is stable:

1. Disengage kill switch.
2. Monitor `/admin` reconcile + dead letters for 24h.
3. Write a postmortem covering: detection time, time to engage kill
   switch, time to rotate key, total funds at risk, total funds lost,
   user-facing impact, root cause (how did the key leak?).
4. Update this playbook based on what you learned.
5. If KMS-backed signing was deferred (see README "Deferred
   Hardening"), this incident is the trigger to schedule the migration.

### Acceptance test (dry-run, schedulable)

This runbook is not believed-to-work until it's been executed
end-to-end on testnet. The dry-run drill:

1. Pick a quiet testnet window.
2. Generate a NEW keypair for the testnet agent wallet.
3. Update the testnet account's key on-chain via the rotation script.
4. Update Vercel testnet env, redeploy.
5. Verify the agent comes back up signing transactions with the new key.
6. Verify `verify-audit.ts` ledger reconciles cleanly.
7. Time each step.

Total wall-clock target: **< 30 minutes**. If the drill takes longer,
identify the bottleneck (probably the Vercel redeploy step) and either
script around it or document the realistic timing.

---

## Symptom 9 — Users seeing `redis_degraded` 503s

**You'll see this from**: dashboard banner "service temporarily
degraded — try again shortly" on play or withdraw, OR a 503 with
`reason: 'redis_degraded'` in the JSON body, OR the structured log
line `[redisHealth] BREAKER OPENED` in Vercel function logs.

This is the Redis circuit breaker doing its job. Three Redis
failures within 60s tripped it; write-path routes are returning 503
until a successful Redis op closes the breaker. Reads continue
working throughout.

### Diagnosis

1. Hit `GET /api/health` and check the `redis` field. Expected
   `upstash`; if it reports `memory`, something is more broken than
   the breaker — your Upstash credentials aren't being read at all
   (see Symptom 8 of the deploy checklist).
2. Check Upstash status page (or your provider equivalent).
3. Tail Vercel function logs: `[redisHealth] BREAKER OPENED` at the
   trip, `[redisHealth] BREAKER CLOSED` when a probe succeeds.
4. Hit Upstash directly with curl from your machine to confirm
   end-to-end reachability.

### Fix

The breaker auto-closes on the first successful Redis op. If Upstash
recovers, the next play/withdraw probe closes the breaker and traffic
resumes. No operator action needed for transient outages.

If Upstash is down for an extended period (>5 min):

1. **Acknowledge users.** Post a status update — the dashboard banner
   already explains "service degraded" but a longer outage warrants a
   public note.
2. **Confirm reads still work** — `/api/user/status`, `/api/audit`,
   the audit page should all keep responding. If they don't, this
   isn't an F6 issue, it's a wider Vercel/Upstash regional incident.
3. **No emergency action while degraded.** Withdrawals are paused but
   funds aren't locked — they're still in the user's ledger, ready
   to settle once Redis is back.
4. After recovery, run reconcile to confirm no drift: `/admin` → run
   reconcile.

### Prevent recurrence

The breaker is the prevention. Sustained Upstash outages are an
upstream-provider problem; the structural defense is what we
control. If you see the breaker tripping repeatedly without obvious
upstream cause, look for:

- Network egress issues from Vercel to Upstash (check Vercel status)
- A noisy-neighbor scenario on the Upstash plan (consider upgrading)
- Code paths making excessive Redis calls (profile the hot route)

---

## Symptom 10 — Rate limiter behaving wrong

**You'll see this from**: legitimate users getting 429s, or the
reverse — abusers not being throttled.

### Diagnosis

Check the rate limit headers on any /api/mcp response:

```
X-RateLimit-Mode:      upstash | memory
X-RateLimit-Limit:     30
X-RateLimit-Count:     <current>
X-RateLimit-Ttl:       <seconds remaining>
X-RateLimit-Identity:  <token prefix or IP>
```

- `Mode: memory` in production = Upstash isn't wired up. The
  in-memory fallback is per-Lambda, so limits don't enforce
  cluster-wide. Fix the Upstash env vars.
- `Mode: upstash` but legitimate users still hit 429 = the limit
  is too tight. Adjust `MCP_RATE_LIMIT` in `app/api/mcp/route.ts`
  (currently 30/min).
- `Identity` is `unknown` for too many requests = the keying
  isn't extracting the auth header / IP correctly. Investigate
  `checkMcpRateLimit`.

---

## Symptom 11 — Duplicate deposit / rake ops on HCS-20 audit topic

**You'll see this from**: the audit page showing the same on-chain
deposit transaction id (memo) recorded twice — two `deposit` ops, two
matching `rake` ops, doubled `Deposited` and `Rake` totals on the user
header. The play loop is unaffected because plays hold a per-user
Redis lock; deposits did not.

### Cause (fixed in 0.3.2)

`RedisStore.isTransactionProcessed()` historically read only an
in-process `Set`. The `deposits:processed` Redis set IS maintained on
write but the read path didn't consult it. Two warm Vercel Lambdas
holding independent caches could each see "not processed" for the same
on-chain tx and both call `creditDeposit` → both write HCS-20
`deposit` + `rake` ops → user balance + operator rake doubled.

The race window opened when both `/api/user/check-deposits` (no lock)
and `/api/user/play` (lock-protected) raced on the same fresh deposit,
or when two concurrent `check-deposits` requests landed on different
warm Lambdas.

### Fix

`UserLedger.creditDeposit` now goes through `IStore.tryClaimTransaction`
which is backed by Redis `SADD` (atomic across Lambdas). The first
caller wins; subsequent callers short-circuit with the already-credited
balance. See `src/custodial/UserLedger.ts:60` and the regression tests
in `src/custodial/RedisStore.test.ts` (cross-Lambda race) +
`src/custodial/UserLedger.test.ts` ("creditDeposit: concurrent calls
for the same txId credit exactly once").

### If you see it again post-0.3.2

It would mean the atomic claim is being bypassed. Investigate:

1. Did someone add a new code path that writes `deposit`/`rake` HCS-20
   ops without going through `UserLedger.creditDeposit`? Grep for
   `accounting.recordDeposit` callers.
2. Is `tryClaimTransaction` being called correctly? Look at the
   `creditDeposit` implementation — the claim must be the FIRST await,
   before any balance mutation.
3. Did a Redis flush race leak the SADD? Unlikely (Upstash is strongly
   consistent for SADD), but check Vercel logs for Redis errors during
   the relevant time window.

### Reconciliation

The HCS-20 topic is immutable, so duplicate ops cannot be unwritten.
Two options:

- **Forward-fix**: write a `refund` op for the duplicate's net amount
  via `operator_refund` to bring the user's ledger back to truth. The
  audit trail clearly shows the duplicate plus the corrective refund.
- **Rebuild Redis from HCS-20**: re-run the v2 reader with a
  `Set<txId>` dedup filter on `deposit` ops, write the corrected
  balance back to Redis. Disaster-recovery territory; document the
  delta before and after.

---

## Symptom 12 — Duplicate dead-letter rows / recovery double-resolution

**You'll see this from**: the admin dashboard's dead-letter list
showing the same `transactionId` twice — once unresolved, once
resolved — after a stuck-prize recovery. Or the recovery action
running twice for the same user (audit topic shows two
`prize_recovery` ops with the same prize totals).

### Cause (fixed in 0.3.3)

Two independent layers:

1. `RecordDeadLetter` was an append, not an upsert, despite the
   comment claiming otherwise. The recovery resolution path wrote
   `{...original, resolvedAt, resolvedBy}` expecting the original
   unresolved row to be replaced; instead a second row was added.
2. `operator_recover_stuck_prizes` had no per-user lock. Two
   operators (or one operator from two tabs) hitting different
   Lambdas both passed the `!resolvedAt` filter against their local
   caches, both attempted recovery on chain.

### Fix

`IStore.upsertDeadLetter` is a genuine upsert keyed by
`transactionId` (RedisStore: per-id key + LREM-then-RPUSH on the
index list). The `operator_recover_stuck_prizes` MCP tool wraps the
execute path in `acquireUserLock(userId, 300)` — the per-user lock
already used by play and withdraw. See
`docs/concurrency-invariants.md` invariants #7 + #8.

### Diagnosis

If you see this post-0.3.3:

1. Check the dead-letter row's `kind` field — if it's
   `prize_transfer_failed`, that came through
   `MultiUserAgent.upsertDeadLetter`. If it's `deposit_failed` or
   absent, that came through the deposit watcher (also using
   `upsertDeadLetter` post-0.3.3).
2. Run `npx tsx src/scripts/test-v2-reader.ts` against the topic
   and confirm the agentSeq sequence is contiguous around the
   recovery — if the agentSeq has gaps for the resolved entries,
   one of the Lambdas died mid-flight before completing the audit
   write.

### Reconciliation

The dead-letter ledger duplication is local to Redis (and the
in-memory cache). Either:
- Delete one of the duplicate rows manually via a Redis CLI session
  (`LREM lla:{network}:store:deadletters 1 <full JSON>`).
- Run a one-shot compaction script that re-reads the dead-letter
  list, deduplicates by `transactionId`, and rewrites.

The HCS-20 audit topic itself is unaffected — `prize_recovery`
messages are correctly emitted only when the lock is held.

---

## Symptom 13 — Refund double-execution / 30-day refund block

**You'll see this from**: an HBAR transfer to the same sender
appearing on chain twice (operator double-clicked admin refund), OR
a legitimate refund request being rejected with "already refunded"
when no actual refund happened (chain-tx failed but the marker stuck).

### Cause (fixed in 0.3.3)

Two separate races:

1. **Double-execution** (severity HIGH). The pre-fix replay
   protection was a GET-then-SET pattern around the on-chain refund:
   `redis.get(refundLockKey)` → mirror-node lookup → on-chain
   transfer → `redis.set(refundLockKey, refundTxId)`. Multi-second
   TOCTOU window covering the irreversible transfer. Two clicks
   landing on different Lambdas both saw `null`, both refunded.
2. **30-day block on retry** (severity MEDIUM). The pre-fix marker
   was only written on success; a chain-tx failure left the marker
   in place if it had been written, OR no marker if the failure was
   pre-write — but combined with the new atomic claim there was no
   release on failure, so a transient mirror-node error left the
   `'pending'` marker stuck for 30 days.

### Fix

`SET refundLockKey 'pending' NX EX 30d` BEFORE the on-chain
transfer. On success: overwrite with the actual `refundTxId`. On
pre-transfer failure: `DEL` the marker so retries are immediate. See
`src/hedera/refund.ts`, `docs/concurrency-invariants.md` invariants
#5 + #6.

### Diagnosis

For "rejected legitimate refund":

1. `redis-cli GET lla:{network}:store:refunds:{txId}` — if the
   value is `'pending'`, a previous attempt failed mid-flight. DEL
   the key to allow retry: `redis-cli DEL <same key>`.
2. If the value is a transaction ID, check it on Hashscan — if the
   refund actually succeeded the operator just needs to confirm.

For "double-refund detected":

1. This shouldn't happen post-0.3.3. If it does, capture both refund
   transaction IDs and the originating txId.
2. Check the dApp Vercel logs for two `processRefund` invocations
   with the same `transactionId` arg — that's the smoking gun.
3. The on-chain refunds are real. Reconciliation: deduct the duplicate
   refund amount from the operator's balance via a manual
   `operator_withdraw_fees` adjustment OR document the loss in the
   incident postmortem.

---

## Symptom 14 — Duplicate or out-of-order `agentSeq` on the audit topic

**You'll see this from**: the v2 reader's `agentSeqGaps` stat being
non-empty for sessions that succeeded, OR two HCS-20 v2 messages
from the same agent carrying the same `agentSeq` value, OR an audit
walker's "monotonic per-agent counter" assumption failing.

### Cause (fixed in 0.3.3)

`AccountingService` held `agentSeq` as a private numeric field
seeded once per process via mirror-node scan, then incremented
locally. Two warm Lambdas writing v2 messages for DIFFERENT users
(per-user lock doesn't serialise across users) both called
`nextAgentSeq()` and got the same number from their independent
counters. The schema doc + CLAUDE.md state "monotonic per-agent
counter"; the implementation delivered "monotonic per-Lambda-process."

### Fix

`AccountingService.nextAgentSeq` now routes through
`IStore.nextAgentSeq(agentAccountId)` which does Redis `INCR` on
`agentSeq:{accountId}` — atomic across all Lambdas. Cold-start
seeding is a separate `SETNX` from the mirror-scan baseline; two
cold Lambdas converge to the same canonical seed. See
`src/custodial/AccountingService.ts`, `docs/concurrency-invariants.md`
invariants #3 + #4.

### Diagnosis

If you see post-0.3.3:

1. Confirm the v2 reader is actually flagging duplicates (not gaps).
   `npx tsx src/scripts/test-v2-reader.ts` prints the gap analysis.
2. Check `redis-cli GET lla:{network}:store:agentSeq:{accountId}` —
   if it's lower than the highest seq on the topic, the Lambda hasn't
   re-hydrated the counter. This shouldn't happen with INCR semantics
   but worth ruling out.
3. If the duplicates predate 0.3.3 deploy, they're in the audit
   trail forever (immutable). Document the cutover timestamp and
   note in any external auditor communication that pre-0.3.3
   `agentSeq` is best-effort, post-0.3.3 is hard-monotonic.

### Reconciliation

The audit topic is immutable. Duplicate `agentSeq` values pre-fix
are noise the reader handles with a warning; they don't corrupt
session state (sessions match by `sessionId`, not `agentSeq`).
External auditors using `agentSeq` for ordering should use
`consensus_timestamp` as the tiebreaker, which is always unique.

---

## Symptom 15 — Double-withdrawal from a lost-response retry

**You'll see this from**: a user reports two on-chain withdrawals
for the amount they expected one of, sometime after a network blip
or a 503 response that they retried.

### Cause (closed in 0.3.3)

Pre-fix: per-user lock prevented simultaneous withdrawals but not
sequential retries. Client posts withdrawal, response packet drops,
client retries the SAME body, both calls execute (the first holder
already released the lock).

### Fix

`Idempotency-Key` header support in `app/api/user/withdraw/route.ts`
via `withIdempotency`. First request claims the key in Redis with
24h TTL; duplicate retries with the same key get the cached result
back without a second on-chain transfer.

### Diagnosis

If you see this post-0.3.3:

1. Check the request logs in Vercel for the user's withdraw calls.
   Were both requests sent with the SAME `Idempotency-Key` header?
   - If YES, this is a regression — `withIdempotency` failed to
     dedupe. Check Redis logs for the claim key (`idem:withdraw:{userId}:{key}`)
     during that timeframe.
   - If NO (or no header sent), the client didn't send a key — the
     fix opts out when no header is present (backwards compat). The
     dashboard should be sending one; check for a regression in the
     frontend submit handler.
2. The two on-chain transfers are real. Reconciliation: either
   admin-refund the duplicate, OR document the loss in the incident
   postmortem and move on (testnet treats this as expected churn).

---

## Symptom 16 — Withdraw 503 `velocity_check_unavailable`

**You'll see this from**: a withdraw returning 503 with
`reason: 'redis_degraded'` and message starting
`velocity_check_unavailable`. User can't withdraw, dashboard shows
"agent temporarily unavailable" banner.

### Cause (intentional, 0.3.3 hardening)

Pre-fix the velocity cap silently failed open on a transient Redis
error — single hiccup disabled the daily cap for one withdrawal.
Now fails closed. A single Redis call within `checkWithdrawalVelocity`
that errors will refuse the withdrawal.

### Diagnosis

1. Check `/api/health` — is the Redis backend healthy? `redis: 'upstash'`?
2. Look for a flap: a single 50ms hiccup vs a sustained outage.
   Sustained outages also trip the breaker (Symptom 9) so the user
   sees `redis_degraded` from a different code path.
3. If the hiccup is transient, the user's retry should succeed.
   If not, escalate per Symptom 9 (Redis health investigation).

This is NOT a bug — it's the deliberate fail-closed posture from
the 0.3.3 audit. False-positive 503s during transient issues are
the cost of preventing a single-call cap bypass.

---

## Symptom 17 — Dead-letter entries with `kind: 'audit_trail_orphaned'`

**You'll see this from**: admin dashboard dead-letter list showing
entries where `transactionId` is a session id (UUID) and `kind` is
`audit_trail_orphaned`. Indicates a play session settled in the
local ledger but couldn't write any HCS-20 marker (close OR
aborted) to the topic.

### Cause (introduced in 0.3.4)

A play settles in three phases: (a) settlement of reservations,
(b) v2 `play_session_close` write to HCS-20, (c) if (b) fails,
fall-back `play_session_aborted` write. Pre-0.3.4 if BOTH (b) and
(c) failed, only `console.warn` fired — operator had no signal.
0.3.4 dead-letters this state explicitly.

External auditors reconstructing balances from the topic see the
user's pre-play balance — the spend is invisible on chain even
though the local ledger has it.

### Diagnosis

1. Look at the dead-letter `details.closeError` and
   `details.abortError` for the underlying HCS submit error.
   Common causes:
   - HCS topic temporarily unreachable
   - `AGENT_SEQ_SEED_FAILED` (see Symptom 18)
   - HCS-20 v2 message size overflow (rare — 1024-byte cap is
     enforced and the schema is sized below it)
2. Check the local `PlaySessionResult` record (admin dashboard or
   `npm run read-accounting`) for the session id. The local
   ledger has the truth; the topic doesn't.
3. Once the underlying issue is resolved, manually replay by
   submitting a fresh `play_session_close` (or `play_session_aborted`)
   for the same session id via the operator CLI. The reader
   tolerates late-arriving terminal markers up to
   `SESSION_INFLIGHT_TIMEOUT_MS` (5 min) past `last_seen`.

### Reconciliation

The HCS-20 topic is immutable; we cannot retroactively write a
marker for a session whose `inflight` window has passed. Two
options:

- **Forward-fix only**: leave the topic state, write a
  `prize_recovery` or `refund` op to the topic that explicitly
  references the orphaned session id with a "manual reconciliation"
  reason. Reader still flags as orphaned but the operator audit
  trail has the explanation.
- **Out-of-band note**: document in the incident report and mention
  in any auditor communications. Pre-0.3.4 this state was silent;
  going forward it's at least visible in the dead-letter queue.

---

## Symptom 18 — `AGENT_SEQ_SEED_FAILED` thrown on every v2 write

**You'll see this from**: Vercel logs spamming
`AGENT_SEQ_SEED_FAILED` for an agent account; `playForUser` always
dead-letters via `audit_trail_orphaned`; user-facing plays return
HTTP 500 with the SDK error.

### Cause (introduced in 0.3.4 hardening)

`AccountingService.initializeAgentSeq` retries the mirror-node
seed scan 3 times with backoff (200ms / 1s / 3s). If all retries
fail, the agent is added to `agentSeqSeedFailed` — subsequent
`nextAgentSeq` calls throw rather than write a duplicate sequence
number.

This is the deliberate fail-closed posture. The underlying issue is
that the agent process can't reach the mirror node.

### Diagnosis

1. Confirm mirror-node reachability: `curl
   https://mainnet.mirrornode.hedera.com/api/v1/network/nodes`
   (or testnet equivalent). If this fails, mirror is down.
2. Check `HEDERA_NETWORK` env. A misconfigured mainnet env hitting
   the testnet mirror will fail the scan if the agent has no
   testnet activity.
3. Check Vercel function logs for the original scan error
   (logged before the seed-failed flag was set).

### Recovery

Restart the agent process to retry the scan. On Vercel, redeploy
or trigger a fresh cold start (e.g. via `vercel --force redeploy`).
The seed-failed flag is per-process — once a fresh boot succeeds,
the flag is cleared.

---

## Symptom 19 — Operator running `replay-deposit` for a dead-lettered tx

**You'll see this from**: operator-driven recovery — admin clicks
"replay" on a dead-letter (deposit failed because of a transient
error or a missing token registration that's now resolved).

### Path

`POST /api/admin/replay-deposit` with `{ transactionId }` (admin
tier). Fetches the tx from mirror node, re-runs through
`DepositWatcher.processTransaction`. Bypasses the watermark gate.

### Safety

`creditDeposit`'s atomic SADD claim guarantees no double-credit.
If the deposit was already credited via a parallel path (rare —
only happens if the operator manually credited it before clicking
replay), `tryClaimTransaction` returns false and the function is
a no-op aside from incrementing the skip counter. If the underlying
issue is still unresolved, a fresh dead-letter is written.

### What to check after running replay

1. The endpoint response: `credited: true` means the deposit was
   applied; `credited: false` means it was skipped (dead-letter
   already exists, or already credited).
2. Admin dead-letter list — if a fresh entry appeared, the original
   issue isn't resolved. Inspect the new entry's error and rerun
   diagnosis.
3. User's balance dashboard — confirm the credit landed.

---

## Symptom 20 — Page: `kind: 'deposit_anchor_failed'`

**You'll see this from**: webhook page / Slack / Discord. R4-FG-5
fires this when `UserLedger.creditDeposit` flushed local state but
`accounting.recordDeposit` (HCS-20 mint anchor) threw. Local credit
is real; topic-only auditors will NOT see the deposit.

### Diagnose

1. Check the dead-letter row at
   `audit-orphan:in-band:deposit-anchor:<txId>:<salt>` (R5-FG-25).
   `kind: 'audit_trail_orphaned'`,
   `details.sourceKind: 'in_band_deposit_anchor'`. Confirms which
   txId is missing the anchor.
2. `details.userId` and `details.netAmount` give the affected user.
3. Cross-check `/api/user/audit?account=<accountId>` — local credit
   should appear; the corresponding `mint` op on the topic will be
   absent.

### Reconcile

1. Wait 5 min for HCS to recover (most often the anchor failure is
   a transient submit failure, not a sustained issue).
2. Run `npx tsx src/scripts/audit-deposit-discrepancy.ts` —
   compares live store totalDeposited against on-chain mints. Any
   gap is the unanchored deposit set.
3. Forward-fix: call `/api/admin/replay-deposit` with the txId.
   The atomic SADD claim on the local credit means re-running is
   idempotent (no double-credit); the replay re-attempts the
   `recordDeposit` anchor. R4-FG-34's self-heal also applies if the
   replay was previously cached as `flush_failed_paged`.
4. After the anchor lands, mark the orphan row resolved via
   `/api/admin/uncertain-tx/<id>/force-release` if it didn't
   self-resolve.

### Prevention

R5-FG-3's `safeSubmit` covers post-submit errors at the SDK layer;
the underlying mirror node / Hedera congestion is out of our hands.
A sustained anchor-failure rate (≥1 per hour) is a Hedera-side
incident — escalate to Hedera ops.

---

## Symptom 21 — Page: `kind: 'rake_anchor_failed'`

**You'll see this from**: webhook page. R4-FG-5 fires this when the
deposit's local credit + rake credit landed but `recordRake` (the
companion HCS-20 transfer anchor) failed. Operator silently kept
the rake but topic-only auditors see no rake transfer.

### Diagnose

Almost identical to Symptom 20. Look for the
`audit-orphan:in-band:rake-anchor:<txId>:<salt>` row and confirm
`details.sourceKind: 'in_band_rake_anchor'`.

### Reconcile

Run `replay-deposit` for the same txId — both `recordDeposit` and
`recordRake` re-fire (in separate try blocks at
`UserLedger.creditDeposit:181-263`). The deposit-mint replay is
idempotent (R5-FG-24 reader-side dedup); the rake replay is
similarly idempotent on the topic post-R5-FG-14 (writer + reader
dedup on `(from, depositTxId)`).

### Prevention

R5-FG-69 deferred — long-term improvement is to batch deposit+rake
into a single submit so they can't desync. Until then, an
operator-driven `replay-deposit` is the standing fix.

---

## Symptom 22 — Page: `kind: 'refunded_originals_sadd_failed'`

**You'll see this from**: webhook page. R3-FG-7 / R5-FG-21 fires
this when the SADD into the permanent `refundedOriginals` set
failed AFTER the on-chain refund either landed (verifier path) or
was about to be attempted (in-flight pre-submit path). The ban-set
membership is what prevents a second on-chain refund after the
30-day per-tx claim TTL expires.

### Diagnose

1. Look for the orphan row keyed
   `audit-orphan:refund-verifier-sadd:<originalTxId>:<salt>`
   (verifier path, R5-FG-25 salted) or
   `audit-orphan:refund-sadd-pre-submit:<originalTxId>:<salt>`
   (pre-submit path, R5-FG-21).
2. `details.originalTxId` is the deposit that's missing the
   permanent-ban entry.
3. Check Redis: `SISMEMBER lla:<network>:refunded-originals
   <originalTxId>` — if 0, the ban is genuinely missing.

### Reconcile

1. Manually `SADD lla:<network>:refunded-originals <originalTxId>`
   to land the ban. The 30-day per-tx claim still protects until it
   expires; SADD before then prevents any window from opening.
2. Mark the orphan row resolved via the admin UI.

### Prevention

The SADD targets a single Redis key — sustained failures are a
Redis health symptom (Symptom 9 / Symptom 16). If isolated, the
write was likely lost to transient network blip.

---

## Symptom 23 — Page: `kind: 'deposit_credit_flush_failed'`

**You'll see this from**: webhook page. R3-FG-6 fires this when
`UserLedger.creditDeposit` recorded the deposit + rake locally but
`store.flush()` failed (twice — there's a built-in retry).

### Diagnose

1. R5-FG-45: also look for the on-chain
   `deposit_credit_flush_orphaned` control event in the audit
   topic. Topic-only DR (Redis loss) reads this to detect over-credit.
2. The orphan row at
   `audit-orphan:in-band:credit-flush:<txId>:<salt>` carries
   `details.grossAmount` and `details.userId`.

### Reconcile

1. Inspect Redis health (`/api/admin/monitoring`). If unhealthy,
   recover Redis first (Symptom 9).
2. With Redis healthy: trigger a write that hits `flush()` for the
   affected user (e.g., `replay-deposit`). Local state is already
   correct; the replay's flush will land. R4-FG-34's self-heal
   applies — `flush_failed_paged` cache invalidates on retry.
3. If Redis was lost entirely: rebuild from the on-chain trail per
   `docs/disaster-recovery.md`. The R5-FG-45 control event tags
   which deposits had unfinished flushes so they don't double-credit
   on rebuild.

### Prevention

`flush_failed_paged` is operator-paged but does NOT block the user's
local credit. The local cache holds the new balance; subsequent
operations work for the affected user as long as their Lambda stays
warm. Cold starts re-load from Redis; if Redis is still missing the
flush, the user will see a snapped-back balance until the next
write.

---

## Symptom 24 — Dead-letter row with `kind: 'audit_trail_orphaned'`,
sourceKind in `{deposit, rake, prize_recovery, replay_deposit, force_release_*}`

**You'll see this from**: dashboard / admin DL list / `read-accounting`
output flagging the orphan. R4-FG-19 / R4-FG-26 / R5-FG-21 / R5-FG-44
all classify failed audit anchors under this kind, with the specific
sourceKind discriminating the failure point.

### Diagnose

The orphan row's `details` object names the missing anchor and the
phase. Cross-link to the on-chain action it was supposed to anchor:

| `sourceKind`                            | Missing anchor                | Recovery |
|-----------------------------------------|-------------------------------|----------|
| `in_band_deposit_anchor`                | `mint` (deposit)              | replay-deposit (Symptom 20) |
| `in_band_rake_anchor`                   | `transfer` (rake)             | replay-deposit (Symptom 21) |
| `in_band_credit_flush`                  | local flush                   | Symptom 23 |
| `in_band_play_settle`                   | session settle                | Operator manual reconcile vs dApp pool state |
| `in_band_withdrawal`                    | `burn`                        | Cross-check mirror; if SUCCESS, force-release as resolved |
| `prize_recovery_post_success_orphan`    | `prize_recovery` event        | recover-stuck-prizes script with `--audit-only` |
| `refund_post_success_orphan`            | `refund` event                | recordRefund replay via admin tool |
| `refund_pre_submit_sadd`                | refundedOriginals SADD        | Symptom 22 |
| `force_release_*`                       | `force_release` control event | Re-run force-release once Hedera healthy |

### Reconcile

Per the table above. After the missing anchor lands, the orphan row
is marked resolved (verifier picks it up automatically; or operator
clicks force-release).

---

## Symptom 25 — `legacy_abort_no_merkle` warning on session

**You'll see this from**: `read-accounting` output, `verify-audit`
alerts, audit page session card. R4-FG-24 introduced
`poolsRoot` on `play_session_aborted`; R5-FG-2 added the cutover.

### Diagnose

1. Pre-cutoff (consensus_timestamp before
   `LEGACY_MERKLE_CUTOFF_TIMESTAMP`, default `2026-05-08T00:00:00Z`)
   — informational only. The aborted message lacks Merkle
   tamper-evidence; count-only check confirmed pool count matches.
2. Post-cutoff — promoted to `corrupt` status (R5-FG-2). This
   indicates either operator-key forgery or a writer regression
   that dropped the field. Critical alert.

### Reconcile

Pre-cutoff: no action needed.
Post-cutoff: investigate as a security incident (Symptom 8 — operator
key compromise). Compare on-chain pool messages to the abort
claim's `completedPools` count; verify operator-key access logs.

---

## When in doubt

1. **Engage the kill switch first** — it's almost never the wrong move
2. **Snapshot the state** — copy reconcile output, user list, recent
   dead letters, the last hour of Vercel logs
3. **Don't run destructive ops** without an explicit cause and a
   matching fix (no "let me just refund everything and start over")
4. **Document the incident** in the operator runbook so the next
   one is faster
5. **Update this playbook** if you encountered a symptom not listed
   here

The architectural goal is that nothing should require code changes
to recover from. If you find a class of failure that does, that's
a hardening backlog item.
