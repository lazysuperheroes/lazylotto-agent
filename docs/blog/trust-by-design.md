# Trust by Design: Why a Custodial Lottery Agent Can Still Be Yours

Every Web3 instinct screams "not your keys, not your coins," and we agree.
So why are we shipping a custodial lottery agent? Because the alternative
— making every user run a node, sign every transaction, and babysit a hot
wallet — is not a product, it is a hobby. The right question isn't *custody
or self-sovereignty*. It is *what does an honest custodial system have to
prove?*

LazyLotto Agent is the bet we made. Hot wallet, multi-user, deployed on
Vercel with Upstash Redis underneath. The agent plays the lottery on your
behalf because that is the entire point. What follows is the description
of how that custody is bounded, what's verifiable from public data, and
what guarantees the code actually enforces — not aspirations, contracts.

> **Don't want to be custodial at all? Run it yourself.**
> The agent is open source. Everything described in this post lives in
> the [public repo](https://github.com/lazysuperheroes/lazylotto-agent).
> You can run the exact same code on your laptop with your own Hedera
> wallet (single-user mode, drives Claude Desktop over stdio), or
> self-host the multi-user variant on your own Vercel + Upstash. The
> hosted instance at `testnet-agent.lazysuperheroes.com` is **one
> deployment** of the agent, not the agent itself. If you'd rather hold
> your own keys, the same code is one `npm install` away.

## The wallet is hot. The blast radius is small.

The agent wallet signs every transaction the agent makes. We built
around that fact directly.

**The wallet doesn't hold user funds.** It holds working capital. User
balances live in a per-user ledger with a hard cap on individual user
balance and a daily withdrawal velocity cap per token. A compromise
does damage proportional to the operator float, not to total deposits.

**The key has a documented, testable rotation story.** The
[incident playbook](../incident-playbook.md) ships a 7-step
key-compromise runbook with a target wall-clock under 30 minutes:
engage kill switch, drain operator float to a cold wallet, rotate the
Hedera account key on-chain, redeploy with the new key, revoke all
live sessions, reconcile from the HCS-20 audit trail, communicate
with users. The runbook is dry-run-able on testnet — we exercise it
before we need it, not during.

**Recovery doesn't depend on us.** Even if every piece of operator
infrastructure goes sideways at once, the public Hedera Consensus
Service topic is the canonical record. Any user's balance can be
reconstructed from the topic alone; the disaster-recovery procedure
rebuilds Redis state from public data. The audit trail isn't just a
witness — it's a recovery primitive.

This is custody as a discipline, not a confession.

## Your wallet is the login

There are no passwords here. There are no API keys to rotate. To sign in,
your Hedera wallet signs a one-time nonce.

Here's what makes that boring (and that is the highest praise security
infrastructure can receive):

- The server fetches your public key from the public mirror node and
  **freezes it into the challenge** before you ever sign. The key cannot
  be swapped under you while the challenge is pending — a TOCTOU class
  closed by construction.
- The nonce is **single-use and atomically deleted on verify** (Redis
  `getdel`). Replay is not a thing.
- Session tokens are **SHA-256 hashed before they ever touch Redis**. A
  Redis breach cannot return usable tokens, only their hashes.
- **Auto-revoke on re-auth** means a stolen token's lifespan ends the
  moment the legitimate user logs in again.
- Threshold and key-list account types are **rejected at challenge
  generation**. We refuse to handle ambiguous signing semantics.

You log in by proving you control the account. The agent never sees your
private key, never asks for it, and could not store it if it tried. Lazy
heroes don't trust strangers — they verify signatures.

## User A cannot bleed User B

In a custodial multi-user lottery agent, the most dangerous failure
mode is cross-user fund leakage: one user's play settling against
another user's balance, or against operator funds. The architecture
rules it out by design.

The agent enforces an invariant called **per-token reservation and
settlement**. Before each play session, it computes the intersection
of the user's positive-balance tokens with the strategy's budgeted
tokens. That set — and only that set — is what the play loop is
allowed to spend. The data structure is a `Map<token, reservedAmount>`
keyed by token, so settlement happens token by token against the right
balance, never against a cross-token sum.

Concrete example: a user funds with HBAR only, never deposits LAZY.
Their reservation set is exactly `{HBAR}`. The strategy filter is
restricted to HBAR-denominated pools. If the play loop ever attempts
to spend LAZY, defense-in-depth throws and every reservation is
released back to the user.

The invariant is locked in by a regression test —
*"HBAR-only user only has HBAR in the reservation set"* — that runs
on every commit. The data structure is the answer: when an invariant
spans multiple resources, the data structure should reflect that, not
compress it.

## The on-chain ledger is the source of truth

Every play session writes a structured sequence to an HCS-20 topic on
Hedera Consensus Service: `play_session_open` → N × `play_pool_result` →
`play_session_close` (or `play_session_aborted` on partial-write failure).
Every deposit, rake, withdrawal, refund, and prize recovery gets its own
immutable record. Each message is stamped with a monotonic per-agent
sequence number, so dropped messages are detectable. Each is
self-sufficient and ≤ 1024 bytes — the writer hard-fails on overflow
because a truncated audit message is worse than a dropped one.

This isn't logging. It's the **source of truth**. Three things follow:

**Independent verification.** A standalone script reconstructs any
user's full ledger from the public mirror node alone — no Redis
credentials, no agent endpoint, no insider access required:

```bash
npx tsx src/scripts/verify-audit.ts --topic <id> --user <accountId>
```

This is the artifact we'd hand a regulator. They don't have to trust
our infrastructure. They run the script, get the same numbers our
dashboard shows, and verify against on-chain state.

**Operational glitches are correctable.** Because every state-changing
event lives on the public topic, anything weird that happens — a
deposit credited to the wrong account, a session that never closed
cleanly, an unexplained drift between operator wallet and ledger — is
reconstructable and adjustable from public data. The agent's Redis
state is a derived view; the topic is canonical. If they ever
disagree, the topic wins, the agent rebuilds, and an audit-trail entry
records the adjustment so the correction itself is on-chain too.

**Format evolution without history loss.** The reader handles both the
legacy v1 batch shape and the current v2 sequence shape. Testnet
history written before v2 still reconstructs cleanly via an
anti-corruption layer in the parser. We can upgrade the wire format
without orphaning a single past event.

Lazy heroes don't trust — they verify. We made verification cheap.

## Two protocols, one auth boundary

We expose tools through two protocols: **MCP** for AI clients like Claude
Desktop, and **A2A** for agent-to-agent discovery and invocation. The A2A
implementation deliberately has zero new business logic — every A2A skill
call is a JSON-RPC re-issue of the equivalent MCP `tools/call` against the
same Lambda. Auth, rate limiting, tier enforcement, dead-letter handling:
all of it lives in one place.

This matters for security because **drift between two parallel
implementations is where bugs live**. The repository ships a
single canonical list of tool names; both surfaces import it. A
parity test (`npm run check-protocols`) calls each tool both ways on
every release and fails the build if the surfaces disagree by even
one entry. If you found a privilege escalation in MCP, you'd find the
same one in A2A — and you'd find a regression test catching it.

The auth model is wallet-only on hosted deployments. Operators and
admins authenticate by signing a challenge with a Hedera account whose
ID appears in `OPERATOR_ACCOUNTS` or `ADMIN_ACCOUNTS`. Wallet
signature is the only path to any privileged tier. For single-user
CLI deployments — where the operator runs the agent on their own
machine and is the only caller — `MCP_AUTH_TOKEN` provides a simple
stdio gate. Multi-user mode ignores that env var entirely. One trust
model per deployment shape.

## When something breaks, the right things break

Two pieces of plumbing that aren't sexy but matter at 3 AM.

**Kill switch.** An operator can engage a frozen state from the admin
dashboard. Engaged means: no new plays, no new registrations, with a
public reason string. Disengaged means: business as usual. What it
never blocks is *withdrawals or deregistration* — the user can always
exit, even when the agent is parked. The kill switch is an override,
not a cage.

**Production preflight.** Hosted deploys require Upstash Redis to be
configured before any route will serve a request. Missing credentials
in production cause every API route to return a structured
`PRODUCTION_REDIS_REQUIRED` 503 on the first call. Distributed locks,
rate limits, kill-switch state, and velocity caps all live in Redis
by design — there is no in-memory fallback in production that could
let the system run with reduced safety guarantees.

**Redis circuit breaker.** A two-layer health policy watches the
shared Redis dependency. Individual guards (kill switch, velocity
cap, rate limiter) fail open on a momentary Redis error — a 200ms
upstream blip shouldn't lock anyone out. A process-local circuit
breaker watches the same client and tracks sustained failures: three
in 60 seconds opens it. While open, write-path routes (play,
withdraw) return a clean `redis_degraded` 503 until a successful
Redis operation closes the breaker. Reads keep flowing. Individual
guards stay responsive to transient errors; the aggregate flips to
strict when the underlying dependency is genuinely unhealthy.

**Health you can monitor.** `/api/health` reports the active backend
(`upstash` vs `memory`), the kill switch state, and the agent
version, all without auth. External uptime monitors can alert on
`redis: 'memory'` in production — the asymmetry between expected and
observed configuration becomes a page, not a surprise.

## The spec is the contract

One operating principle worth stating plainly: documentation is the
contract, code is the implementation. The README and CLAUDE.md
describe what the agent promises; the code is held to those
promises. The guarantees in the README are commitments, and the
test suite encodes them. If you ever find a guarantee in the docs
that the code doesn't honor, file it — we treat it as a bug, not as
a doc to soften.

## What's next: hardware-backed signing, when the time is right

The system has a single deliberate future enhancement on the security
roadmap: hardware-backed signing for the operator key. We have a clear,
usage-driven trigger for it. KMS-backed signing moves from planned to
active when **operator-wallet AUM crosses 50,000 HBAR equivalent**, or
when the operating team grows past its current size. The monthly
reconcile report surfaces AUM with this threshold check on every run, so
the trigger fires on its own — no human has to remember to check.

We're not in a hurry to build it before the math says we should. At
today's scale, the existing trust boundary (Sensitive env at provision,
balance caps that bound blast radius, a tested rotation runbook, an
on-chain ledger that lets us reconstruct anything from public data) is
the right level of paranoia. When usage justifies more, we have a
documented graduation path. The whole posture is "right-sized for the
moment, with a plan for the next one."

## Verify, don't trust

The strongest security claim a custodial system can make is
*"you do not have to take our word for it."* Run the verifier:

- `npx tsx src/scripts/verify-audit.ts --topic <id> --user <accountId>`
  — reconstruct your full ledger from the public Hedera mirror node
  alone. No Redis credentials, no insider access.
- `GET /api/health` — confirm `redis: 'upstash'` and check the kill
  switch state from anywhere, no auth required.
- `npm run check-protocols <agent-url>` — verify MCP and A2A surfaces
  match on a live deployment.
- HashScan — watch your deposit memo land on the chain in real time.

We've built a setup we're genuinely proud of: wallet-only privileged
auth, an on-chain audit trail that doubles as a recovery primitive,
two protocols sharing one auth boundary with mechanical parity, an
aggregate-fail-closed posture for sustained outages, a key-rotation
runbook we exercise before we need it, and a spec the code is held
to — never the other way around. The receipts are public, the math is
yours to check, the deploy fails loudly when it should, and the
graduation criteria for the next layer are already written down. Come
play.
