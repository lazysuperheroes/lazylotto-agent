# Uptime Monitoring Setup

> How to wire `/api/health` (and the upcoming reconcile cron) into
> external monitoring so an operator gets paged before users notice
> something is wrong.

This is the missing piece flagged at the end of the Stage 2 work:
right now we find out about stuck prizes / dead letter accumulation
by manually checking the admin dashboard. For mainnet, monitoring
needs to push, not pull.

---

## What to monitor

Three layers, in order of operator urgency:

1. **Liveness**: is the agent up at all? → `/api/health`
2. **Solvency**: does the on-chain wallet match the internal ledger?
   → `/api/cron/reconcile` (added in this batch, see Reconcile Cron
   Endpoint task)
3. **Drift**: are dead letters / pending ledger adjustments / corrupt
   sessions accumulating? → admin dashboard or a future `/api/admin/health`
   summary endpoint

The priority pyramid: liveness > solvency > drift. Set monitor
sensitivity accordingly — getting paged for liveness is a "wake
up now" event; drift is a "look at it tomorrow" event.

---

## Layer 1 — Liveness on `/api/health`

The endpoint:
- Lives at `https://agent.lazysuperheroes.com/api/health`
- Returns `200 OK` with `{ status: "ok", network, version, timestamp }`
- Has no auth, no Redis dependency, no Hedera SDK calls
- Designed to fail-fast and never cascade

If `/api/health` is down, the entire deployment is broken. This
is the high-signal canary.

### Option A — Better Stack (formerly Better Uptime) [recommended]

1. Sign up at <https://betterstack.com>
2. Create a monitor:
   - **URL**: `https://agent.lazysuperheroes.com/api/health`
   - **Check frequency**: 30s
   - **Request timeout**: 10s
   - **Expected status code**: 200
   - **Expected body contains**: `"status":"ok"`
   - **Regions**: at least 2 different ones to avoid false alerts
     from regional outages
3. Add a notification channel:
   - **Slack** / **Discord** webhook (recommended for low-noise
     pages)
   - **Email** (fine for backup)
   - **PagerDuty** / **Opsgenie** (overkill until we have real
     mainnet users)
4. Set the alert escalation:
   - First alert after 1 missed check (30s)
   - Re-alert after 5 minutes if not acknowledged
5. Test the alert by hitting a deliberately broken URL once

### Option B — UptimeRobot

Free tier supports 50 monitors at 5-minute intervals. Lower
sensitivity than Better Stack but adequate for testnet.

1. Sign up at <https://uptimerobot.com>
2. Create a monitor:
   - **Type**: HTTP(s)
   - **URL**: `https://agent.lazysuperheroes.com/api/health`
   - **Interval**: 5 min (free) or 1 min (paid)
   - **Keyword**: `"status":"ok"` (required to make sure HTML
     500 pages don't pass)
3. Configure alert contacts (email, Slack, webhook)

### Option C — Vercel Monitoring

Vercel has built-in uptime monitoring on the Pro plan. Uses
Vercel's own infrastructure so it's the simplest setup but
shares fate with the platform you're trying to monitor.

1. In Vercel Dashboard → your project → Monitoring
2. Add a new endpoint check pointing at `/api/health`
3. Configure threshold and notification

**Don't use this as your only monitor** — if Vercel itself is
down, the monitor is down too. Pair it with Better Stack or
UptimeRobot from outside Vercel.

### Option D — Self-hosted Prometheus + blackbox_exporter

Maximum control, maximum operational burden. Don't bother
unless you already run a Prometheus stack.

---

## Layer 2 — Solvency via reconcile cron

The reconcile cron endpoint (added in this batch) does the
expensive work — pulls mirror node data, sums on-chain vs
ledger, returns the result.

### Setup

1. Set `CRON_SECRET=<strong random string>` in Vercel env vars
2. Vercel's cron config in `vercel.json` schedules
   `GET /api/cron/reconcile` on an hourly basis (or whatever
   you choose)
3. The endpoint requires the `Authorization: Bearer ${CRON_SECRET}`
   header — Vercel Cron supplies this automatically when
   configured via `vercel.json`
4. The endpoint returns the reconcile result and ALSO sets a
   non-200 status if `solvent: false`

### Wire to your monitor

If you're using Better Stack, add a SECOND monitor pointing at
the cron endpoint with the auth header:

- **URL**: `https://agent.lazysuperheroes.com/api/cron/reconcile`
- **Method**: GET
- **Headers**: `Authorization: Bearer <CRON_SECRET>`
- **Frequency**: 1 hour (matches Vercel Cron — don't double-run)
- **Expected status**: 200
- **Expected body contains**: `"solvent":true`
- **Alert escalation**: insolvency = wake operator NOW

### Webhook on failure (alternative)

Instead of (or in addition to) external monitoring, you can have
the cron endpoint POST to a webhook on `solvent: false`:

```ts
// In /api/cron/reconcile after running reconcile():
if (!result.solvent) {
  await fetch(process.env.RECONCILE_FAILURE_WEBHOOK_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `🚨 LazyLotto reconcile FAILED — solvent: false`,
      result,
    }),
  });
}
```

Set `RECONCILE_FAILURE_WEBHOOK_URL` to a Slack incoming webhook,
Discord webhook, or any other webhook receiver. Free, async, and
fires from the same code path so it can't be missed.

---

## Layer 3 — Drift detection (dead letters, pending ledger, corrupt sessions)

These accumulate slowly and are NOT urgent enough to wake an
operator. A daily summary is sufficient.

### Option A — Daily summary cron

Add a `/api/cron/daily-summary` endpoint that:
1. Counts dead letters
2. Counts pending ledger adjustments
3. Runs the v2 reader and counts `corrupt | orphaned | in_flight` sessions
4. Posts a summary to Slack / Discord
5. Returns 200 if all counts are zero, 200 with `degraded: true`
   if non-zero

Schedule it once a day. Operator reads the summary in the
morning and decides whether to investigate.

### Option B — Threshold alerts

In the reconcile cron, add a threshold check:
```ts
if (deadLetterCount > 5 || pendingLedgerCount > 0 ||
    corruptSessionCount > 0) {
  // Post to webhook
}
```

This is the lowest-effort version of drift detection — just
extend the existing reconcile cron rather than adding a second
endpoint.

---

## Recommended setup for mainnet launch

The minimum viable monitoring:

- [ ] **Better Stack** monitor on `/api/health` (30s, 2 regions, Slack webhook)
- [ ] **Vercel Cron** hitting `/api/cron/reconcile` hourly with `CRON_SECRET`
- [ ] **`RECONCILE_FAILURE_WEBHOOK_URL`** env var set to a Slack incoming
      webhook so insolvency events post automatically
- [ ] One pinned channel in Slack/Discord receiving both alerts so
      they're impossible to miss

Once you have real users and the system is running smoothly:

- [ ] Daily summary cron (Layer 3)
- [ ] Per-token spend / win threshold alerts
- [ ] Vercel function error rate dashboards

---

## What NOT to do

- **Don't** point an uptime monitor at `/api/mcp` — it's a POST
  endpoint with auth, the monitor will hammer it with empty
  bodies and trip the rate limiter
- **Don't** poll `/admin` from a monitor — same problem, plus
  it requires a session token
- **Don't** run reconcile more often than once per hour — it
  pulls mirror node data and walks the topic, which gets
  expensive on a busy mainnet topic
- **Don't** alert on individual deposit / play failures — they
  happen and get retried/dead-lettered. Alert on the rate,
  not the event

---

## Appendix — what `/api/health` returns

```json
{
  "status": "ok",
  "network": "mainnet",
  "version": "0.1.32",
  "timestamp": "2026-04-08T01:23:45.678Z"
}
```

The `version` field reads from `NEXT_PUBLIC_APP_VERSION` (injected
from `package.json` at build time by `next.config.mjs`). If you
see `0.1.0` in production, the build-time injection is broken
and the deploy is suspect.

The `timestamp` field is useful for distinguishing "the monitor
is hitting a stale CDN cache" from "the agent is responding live"
— a fresh timestamp means the function actually ran for this
request.
