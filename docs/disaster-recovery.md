# Disaster Recovery Plan

> What to do if Redis (Upstash) is wiped, corrupted, or otherwise
> lost. The goal is to be able to rebuild the operator's local
> ledger from on-chain data alone, with documented steps and
> reasonable RTO.

This is a "we hope it never happens" doc that should be tested at
least once on testnet before mainnet launch.

---

## What Redis holds

Upstash Redis is the source of truth for:

| Data | Key prefix | Source of truth elsewhere? |
|---|---|---|
| User registrations (account ID, EOA, strategy, deposit memo, balances) | `lla:{network}:user:` | **Partial** — registrations + deposits + plays + withdrawals are recorded on the HCS-20 audit topic, but the live balance state isn't (it's derived) |
| Operator state (rake collected, gas spent, totals) | `lla:{network}:operator` | **Partial** — rake transfers are on chain, but the running totals are derived |
| Deposit watermark (last seq number processed) | `lla:{network}:deposit-watermark` | No — purely an optimization for the deposit watcher; safe to reset to 0 |
| Processed transaction set (idempotency) | `lla:{network}:processed-tx` | **Yes** — recoverable by re-walking the topic |
| Auth challenges (nonces) | `lla:{network}:challenge:` | No — short-lived (5 min), wiped naturally |
| Auth sessions | `lla:{network}:session:` | No — users must re-auth (acceptable) |
| Account → session set (auto-revoke) | `lla:{network}:account-sessions:` | No — same as above |
| Distributed user locks | `lla:{network}:lock:user:` | No — short-lived |
| Rate limit counters | `lla:{network}:ratelimit:` | No — they reset every minute anyway |
| Killswitch state | `lla:{network}:killswitch` | No — defaults to off if missing |
| Refund replay protection | `lla:{network}:refunded:` | No — but worst case is a duplicate refund check, not a duplicate refund (we'd see the second one fail) |
| Pending ledger adjustments queue | `lla:{network}:pending-ledger` | No — these are critical, see below |
| Withdrawal velocity counters | `lla:{network}:velocity:withdrawal:` | No — they're 24h windows, reset naturally |
| Dead letters | `lla:{network}:dead-letters` | **Partial** — the failures themselves left on-chain artifacts but the structured "what failed and why" is in Redis |

The two genuinely-load-bearing categories are **user records** and
**operator state**. Everything else is recoverable, ephemeral, or
acceptable-to-lose.

---

## How HCS-20 v2 makes recovery possible

After the v2 schema migration, the audit topic contains every
balance-affecting event:

- `mint` — deposit credited (with memo, sender, amount, token,
  timestamp)
- `transfer` (memo='rake') — rake taken at deposit time
- `burn` (memo starts with 'play:') — legacy v1 play spending
- `play_pool_result` — v2 per-pool play spending (with `feeTokenId`)
- `burn` (memo starts with 'withdrawal') — withdrawal
- `refund` — refunded back to sender
- `prize_recovery` — operator-initiated prize recovery
- `control` — kill switch toggles, schema markers

Walking the topic in consensus order is sufficient to reconstruct
every user's `totalDeposited`, `totalRake`, `totalSpent`,
`totalWithdrawn`, and current `available + reserved` balance.

What you CAN'T reconstruct from chain alone:

- The mapping from `userId` (a UUID we generate) to
  `hederaAccountId` (the user's Hedera wallet) — but you DON'T
  need this. You can re-key all reconstructed user records by
  `hederaAccountId` and re-issue userIds.
- The user's `eoaAddress` if it differs from `hederaAccountId`.
  Practically these are the same for our test users (the EOA
  defaults to `auth.accountId` at registration time), so this is
  fine.
- The user's `depositMemo` (the `ll-XXX` token) — but again, you
  can re-issue these and tell the affected user to update.
- The user's chosen `strategyName` and `rakePercent` — fall back
  to the defaults from `loadCustodialConfig()` and let users
  re-select.
- Auth sessions — users must re-sign in. Acceptable.

---

## Recovery procedure

This is the "Redis is gone" runbook. RTO target: 30 minutes for a
clean recovery, longer if you need to manually triage edge cases.

### Step 1 — Stop the bleeding

1. **Engage the kill switch** at the application layer. If Redis
   is down you can't actually do this via the admin UI (since the
   killswitch state lives in Redis), but the next-best thing is
   to either (a) take Vercel offline by removing the deployment,
   or (b) hard-code the killswitch to enabled in the code and
   redeploy. The goal is "no new plays / deposits / withdrawals
   until we have confidence in the rebuilt ledger."

2. **Snapshot what's left**, if anything:
   - If Upstash is partially up, dump every key matching
     `lla:{network}:*` to a JSON file
   - If Upstash is dead but the agent's local PersistentStore
     directory exists (CLI dev mode), back that up
   - If neither, you're rebuilding from chain alone

### Step 2 — Verify the on-chain audit topic is intact

The topic is on Hedera consensus and is immutable. It can't be
"gone" unless someone deleted the entire Hedera network. But
verify you can still pull messages:

```bash
TOPIC=<your HCS20_TOPIC_ID>
curl -s "https://mainnet.mirrornode.hedera.com/api/v1/topics/$TOPIC/messages?limit=1" \
  | python -m json.tool | head -20
```

Should return at least one message. If you can't reach the mirror
node, try a different region (Hedera has multiple) before assuming
the topic is gone.

### Step 3 — Walk the topic and reconstruct user records

Use the standalone CLI verifier (see `tools/verify-audit.ts` /
`src/scripts/verify-audit.ts`) which already implements the v1+v2
reader logic without depending on Redis or the live agent:

```bash
npx tsx src/scripts/verify-audit.ts \
  --topic $TOPIC \
  --output ./recovery-snapshot.json
```

This produces a snapshot of:
- Per-user ledger state (deposits, rake, spend, withdrawals,
  current available)
- Operator state (rake collected, gas spent)
- Dead-letter list (recoverable from on-chain refund / failure ops)
- Sessions reconstructed via the v2 reader

Verify the snapshot is internally consistent:
- Sum of user deposits + rake = total inflow
- Sum of user spend + withdrawals = total outflow
- Operator wallet on-chain balance ≈ inflow - outflow - gas

### Step 4 — Reseed Redis from the snapshot

Write a one-shot loader script (`src/scripts/reseed-from-snapshot.ts`
— TODO if you're doing this for real) that:

1. Iterates the snapshot's user list
2. For each user, generates a fresh `userId` UUID and writes:
   ```json
   {
     "userId": "<new uuid>",
     "hederaAccountId": "<from snapshot>",
     "eoaAddress": "<from snapshot>",
     "depositMemo": "ll-<new short id>",
     "strategyName": "balanced",
     "rakePercent": 5.0,
     "balances": { ... },
     "active": true,
     "registeredAt": "<from snapshot's first deposit timestamp>",
     "lastPlayedAt": "<from snapshot's last play timestamp>"
   }
   ```
3. Writes the operator state from the snapshot
4. Re-creates the user-by-memo and user-by-account indices
5. Skips the deposit watermark (let it default to 0; the deposit
   watcher will idempotently re-process all known deposits and
   credit nothing because they're already in the ledger)
6. Skips ephemeral data (auth, locks, rate limits, etc.)

### Step 5 — Verify post-reseed

1. Run `operator_reconcile` and confirm `solvent: true` with
   minimal warnings
2. Pick 1-2 specific users you know about and verify their
   ledger balance matches what's on chain (both `mint` minus
   `rake` minus `play_pool_result.spent` minus `burn(withdrawal)`)
3. Run a no-op play session as the operator (with a fresh play
   that won't trigger any pool entries) to verify the agent is
   working end-to-end
4. Verify the audit page renders correctly with the new state

### Step 6 — Tell users what happened

Users will need to:
- Re-sign in (their session tokens are gone)
- Update their `depositMemo` (you reissued them)
- Verify their balance looks right against the audit page

A pinned message on the dashboard or a one-time email blast.

### Step 7 — Disengage kill switch and resume

Once you're confident the reseeded state is correct, disengage
the kill switch and allow new traffic.

---

## What's missing today (TODO before mainnet)

The recovery procedure above is **mostly designed but not fully
implemented**. Specifically:

- [ ] **`src/scripts/verify-audit.ts`** — the standalone verifier
      that walks the topic without needing Redis. (Tracked as
      task #207, scheduled in this batch.)
- [ ] **`src/scripts/reseed-from-snapshot.ts`** — the loader that
      writes the snapshot back into a fresh Redis. Not yet
      written; should follow the verify script.
- [ ] **One annual recovery drill on testnet** — actually run this
      end-to-end at least once before mainnet launch so we know
      it works and the RTO estimate is real.

---

## Backup options for Upstash

Per the Upstash docs:

- **Upstash Pro plans** support automatic daily snapshots
- For free / Pay-as-you-go plans, you can manually export via
  the Upstash dashboard or API
- A simple fallback: a daily cron that hits a new
  `/api/admin/export` endpoint and writes the result to S3 / R2 /
  any object store

We don't currently have the export endpoint. Could be a small
follow-up: enumerate users + operator state + dead letters,
return as JSON, gate by `CRON_SECRET`, run on a Vercel cron.

---

## Reality check

The **best** recovery plan is the one you don't need to use. The
HCS-20 v2 audit topic is an immutable backup that survives any
local-store outage. As long as the topic itself is fine — and it
will be, because it's on Hedera consensus — full reconstruction is
always possible.

The **worst-case scenario** is "Upstash is down for hours during
peak traffic". In that scenario:
- New auth requests fail (sessions live in Redis)
- New plays fail (per-user locks + ledger live in Redis)
- Existing-session users see API 500s
- Health endpoint still returns 200 (no Redis dependency)
- The audit topic keeps working in read-only mode

That's a several-hours outage, not data loss. Acceptable for v0.

The **catastrophic scenario** is "Upstash data is corrupted in a
way the agent can't detect, and the corruption goes undetected for
days while users continue to play". Mitigations:
- The hourly reconcile cron catches divergence between the local
  ledger and the chain
- The HCS-20 v2 trail provides an external check
- The independent CLI verifier (#207) can be run manually any time
  to spot-check

The combination is "good enough for testnet + mainnet v1", with
"add automated daily snapshots" and "add per-user balance
spot-check alerts" as obvious follow-ups once we have real users.
