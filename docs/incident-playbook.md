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

## Symptom 8 — Rate limiter behaving wrong

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
