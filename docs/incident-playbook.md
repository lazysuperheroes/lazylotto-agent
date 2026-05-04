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
