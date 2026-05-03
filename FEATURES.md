# LazyLotto Agent — Features

The agent ships in three deployment shapes (single-user local, multi-user
local, multi-user hosted) and exposes one consistent set of capabilities
across all three. Features are grouped below by audience.

---

## For Players

**Autonomous play loop.** The agent picks pools by expected value, buys
entries within budget, rolls for prizes, and routes winnings to your wallet.
You hit Play (or ask Claude to). It does the rest.

**Drive it from any AI client.** Two protocols, same toolset:
- **MCP** — Model Context Protocol server. Wire into Claude.ai, Claude
  Desktop, Claude Code, or Cursor with one URL.
- **A2A** — Agent-to-Agent protocol with a standard
  `/.well-known/agent-card.json` discovery endpoint. Any A2A-compliant
  agent can find and call this one with no custom integration.

*"Play a session, then tell me what I won"* works as a single prompt.

**Multi-token aware.** HBAR and LAZY play side-by-side. The agent budgets
each token independently and only ever spends what's actually in your
reserved balance for that token. A HBAR-only player can never accidentally
trigger a LAZY play they don't fund.

**Three built-in strategies.** Conservative (high win-rate pools, small
entries), balanced (sensible default), aggressive (prize-rich pools, larger
swings, $100/session cap). Pick at registration; switch any time via the
dashboard or `multi_user_set_strategy`.

**NFT win-rate boost.** Delegate your Lazy Superheroes (Gen 1) or Lazy
Super Villains (Gen 2) NFTs to the agent and your boost compounds, without
ever transferring custody. In hosted mode, the operator's NFTs boost
everyone.

**Rake on deposit, not on wins.** Default 5%, negotiable down to 2% for
high-volume players. Win the entire prize. No withdrawal fee, no idle fee.

**On-chain audit trail.** Every deposit, play, prize, fee, refund, and
recovery is logged to an HCS-20 topic. A standalone verifier script
reconstructs your full ledger from the public mirror node, no Redis required.

**Withdrawals pinned to your wallet.** The address you registered with is
the only address you can withdraw to. Enforced server-side, visible
on-chain.

**No KYC, no email, no password.** Sign in by signing a challenge with
your Hedera wallet. That's the entire auth flow.

**Web dashboard.** Connect, fund, play, withdraw, view history, see your
character mascot, browse the audit trail. Dark mode, LAZY Gold accents.

---

## For Developers

**MCP server with 23 tools.** Single-user (9), multi-user (8), and operator
(7) tiers. Stdio transport for Claude Desktop, HTTP transport for self-hosting
and serverless. Cached agent context per warm Lambda; stateless per-request
otherwise.

**A2A server with parity-by-construction.** `POST /api/a2a` (JSON-RPC 2.0)
plus `GET /.well-known/agent-card.json`. The A2A adapter calls the MCP
endpoint over HTTP for each skill — there's no parallel handler tree to drift.
`npm run check-protocols` verifies parity on any deployed URL.

**Three deployment modes.** Run it on your laptop with your own wallet, run
it as an operator with a CLI managing multiple users, or deploy it to
Vercel as a hosted service. Same code, three configs.

**Open source.** MIT-licensed, public repo, scoped npm package
(`@lazysuperheroes/lazylotto-agent`).

**Hedera-native.** Built on `@hashgraph/sdk` and
`@hashgraphonline/standards-sdk`. Real Hedera transactions, real mirror node
reads, real HCS topics — no off-chain shadow ledger.

**HOL discoverable.** HCS-11 profile + UAID. The agent shows up in the
Hashgraph Online registry so other agents can find it programmatically.
Three discovery surfaces: HOL registry, `/api/discover`,
`/.well-known/agent-card.json`.

**Versioned strategies.** Strategies are typed, Zod-validated JSON. Drop a
custom file in, set the env var, done.

**Dual-shape audit reader.** `parseAuditTopic` reads both the legacy v1
batch format and the current v2 sequence format from the same topic. Forward
and backward compatibility live in one place.

**Test suite + audit verifier + parity checker.** 380 tests including the
regression that locks in per-token budget correctness, A2A adapter parity,
and HCS-20 dual-shape parsing. Standalone audit verifier ships in
`src/scripts/verify-audit.ts`. Standalone protocol parity checker ships in
`src/cli/check-protocols.ts`.

---

## For Operators

**Admin dashboard.** Reconcile on-chain balances against the ledger, browse
the dead-letter queue, see live health metrics, run all of it from one page.
Audit page on the same dashboard surfaces SessionCard aggregations of the
HCS-20 trail with newest-first ordering and per-token unit display.

**Kill switch.** One toggle blocks new plays and new registrations during
incidents while leaving withdrawals open. Users can always exit. Reason
text is shown to anyone who hits a blocked endpoint.

**Reconcile cron + uptime monitoring.** Hourly `/api/cron/reconcile` returns
503 on insolvency and optionally fires a webhook. `/api/health` for
external uptime monitors. Wiring guide in `docs/uptime-monitoring.md`.

**Dead-letter recovery.** Stuck deposits, failed prize transfers, and
corrupt sessions land in a queue with full diagnostic context. One-click
refund flow. Stuck-prize recovery script with the same gas retry ladder
used by live plays — recoveries are recorded as `prize_recovery` events on
the HCS-20 trail so they're visible to external auditors.

**HCS-20 v2 audit trail.** External-auditor-grade on-chain ledger with
per-pool open/result/close sequence. Disaster recovery procedure documented:
lose Redis, rebuild from the topic alone. Every message is self-sufficient
and ≤ 1024 bytes; sequence numbers are monotonic and recovered at startup.

**Structured logging + schema versioning.** JSON logs to stderr in
production (Logtail/Axiom/Datadog ready), schema-versioned persisted records
for clean future migrations. Stderr-only invariant protects stdio MCP
JSON-RPC.

**Per-token reservation correctness.** A regression class around
mixed-token users (HBAR-only player, LAZY-only player, both) is locked in
by tests. Operator funds cannot bleed into a user's play, even if a strategy
or contract change goes sideways at runtime.

**Operator runbooks.** `docs/incident-playbook.md` (symptom → action,
including a 7-step operator-key-compromise runbook with a sub-30-min
target), `docs/disaster-recovery.md` (Redis loss), `docs/mainnet-deploy-checklist.md`
(phase-by-phase deploy), `docs/mainnet-hol-registration.md` (one-time HOL).

**Production preflight.** Hosted deploys (`NODE_ENV=production`)
require Upstash Redis credentials. Missing credentials cause every
route to return `PRODUCTION_REDIS_REQUIRED` 503 on the first
request — Redis is a deploy precondition, not optional configuration.

**Layered Redis safety.** Two-layer health policy. Individual guards
(kill switch, velocity cap, rate limiter) fail open on transient
errors so brief upstream blips don't lock anyone out. A process-local
circuit breaker tracks sustained failures and flips write-path routes
(play, withdraw) to `redis_degraded` 503 when Redis is genuinely
unhealthy. Reads continue throughout. Local responsiveness, aggregate
strictness.

**Wallet-only privileged auth on hosted.** Operator and admin tiers
issued exclusively through Hedera signature challenge against
`OPERATOR_ACCOUNTS` / `ADMIN_ACCOUNTS`. The `MCP_AUTH_TOKEN`
shared-secret env var is scoped to single-user CLI / stdio
deployments; multi-user mode ignores it.

**Health you can monitor.** `/api/health` reports backend mode
(`redis: 'upstash' | 'memory'`), kill switch state, and version, all
without auth. External uptime monitors can alert on backend-mode
asymmetry without scraping logs.
