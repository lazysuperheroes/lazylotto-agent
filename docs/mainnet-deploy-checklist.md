# Mainnet Deploy Checklist

> Operator-runnable checklist for spinning up the LazyLotto Agent on
> Hedera mainnet at `agent.lazysuperheroes.com`. Work through each
> section in order. Every checkbox should be ticked before flipping
> DNS or sharing the URL externally.

This is a separate Vercel project from testnet — they share zero state.
You're not "promoting testnet to mainnet", you're standing up a fresh
deployment with mainnet keys, mainnet contracts, mainnet tokens, and
a brand new HCS-20 audit topic.

---

## Phase 0 — Pre-flight (do these BEFORE creating the Vercel project)

### Mainnet Hedera operator account
- [ ] Create a fresh Hedera mainnet account (do NOT reuse the testnet operator)
- [ ] Fund it with HBAR for gas (recommend 100+ HBAR for the first month)
- [ ] Set up token associations the agent will need:
  - [ ] LAZY token (mainnet ID `0.0.1311037`)
  - [ ] Any FT prize tokens you expect users to receive
- [ ] Backup the private key in a password manager (not a `.txt` on disk)
- [ ] Note the public account ID — you'll need it for `HEDERA_ACCOUNT_ID`

### Upstash Redis (mainnet namespace)
- [ ] Create a NEW Upstash Redis database (or reuse testnet's, since the
      `lla:{network}:` key prefix already namespaces by network — but a
      separate DB is cleaner for blast radius)
- [ ] Note the REST URL and token
- [ ] Confirm the region is close to your Vercel deployment region
- [ ] Set up daily snapshots / backup if Upstash plan supports it

### HOL registry API key
- [ ] Get a fresh `HOL_API_KEY` from the HOL team if you don't already
      have one (testnet key may or may not work for mainnet — verify)
- [ ] Confirm the key has registration permissions, not just read

### Mainnet contract IDs (verify these against the LazyLotto deployment)
- [ ] `LAZYLOTTO_CONTRACT_ID` — main lottery contract on mainnet
- [ ] `LAZYLOTTO_STORAGE_ID` — storage contract
- [ ] `LAZYLOTTO_POOL_MANAGER_ID` — pool manager
- [ ] `LAZY_GAS_STATION_ID` — LAZY gas station (mainnet)
- [ ] `LAZY_TOKEN_ID` = `0.0.1311037` (mainnet LAZY)

These are NOT the same as testnet. Get them from the LazyLotto dApp
team or `npm view @lazysuperheroes/lazy-lotto`'s mainnet config.

### Domain
- [ ] DNS for `agent.lazysuperheroes.com` ready to point at the new
      Vercel deployment (CNAME to `cname.vercel-dns.com` once project
      is created)
- [ ] Don't actually flip the CNAME until everything else is verified

---

## Phase 1 — HCS-20 audit topic

The mainnet topic should be **v2-only** — no need to carry the v1
backward-compat shim forward (per architect review). Existing testnet
topic stays where it is for ongoing testnet operations.

- [ ] From a local CLI with mainnet keys in `.env`, run:
      ```bash
      lazylotto-agent --multi-user --deploy-accounting
      ```
      (Or whatever the current accounting deployment command is —
      verify in src/cli/wizard.ts.)
- [ ] Note the new topic ID printed on success
- [ ] Verify the topic exists on HashScan mainnet
- [ ] Submit a test `control` message marking the topic as v2-only:
      ```json
      {"p":"hcs-20","op":"control","tick":"LLCRED",
       "event":"schema_v2_only","by":"<your account>",
       "timestamp":"<ISO>"}
      ```
      This is an audit anchor so future readers know this topic
      never had v1 messages.
- [ ] Save the topic ID for `HCS20_TOPIC_ID` in the env vars below

---

## Phase 2 — Create the Vercel project

- [ ] Create a new Vercel project pointing at `lazysuperheroes/lazylotto-agent`
- [ ] Set the production branch to `main` (NOT `testnet`)
- [ ] Set the build command (already in `vercel.json`): `npm run build:web`
- [ ] Set the output directory: `.next`
- [ ] Set the root directory: project root (no subfolder)
- [ ] Connect the Vercel-managed Upstash Redis from Phase 0 (or paste
      the URL/token manually if using a separate Upstash account)

---

## Phase 3 — Environment variables

Set every variable below in the Vercel project's environment settings.
**Production scope only** — preview and development deployments should
NOT have mainnet keys.

### Hedera (mainnet)
- [ ] `HEDERA_NETWORK=mainnet`
- [ ] `HEDERA_ACCOUNT_ID=<mainnet operator account from Phase 0>`
- [ ] `HEDERA_PRIVATE_KEY=<mainnet operator private key>`

### LazyLotto (mainnet)
- [ ] `LAZYLOTTO_MCP_URL=https://dapp.lazysuperheroes.com/api/mcp`
- [ ] `LAZYLOTTO_MCP_API_KEY=<get from dApp team>`
- [ ] `LAZYLOTTO_CONTRACT_ID=<mainnet>`
- [ ] `LAZYLOTTO_STORAGE_ID=<mainnet>`
- [ ] `LAZYLOTTO_POOL_MANAGER_ID=<mainnet>`
- [ ] `LAZY_GAS_STATION_ID=<mainnet>`
- [ ] `LAZY_TOKEN_ID=0.0.1311037`

### Multi-user / custodial
- [ ] `MULTI_USER_ENABLED=true`
- [ ] `RAKE_DEFAULT_PERCENT=5.0`
- [ ] `RAKE_MIN_PERCENT=2.0`
- [ ] `RAKE_MAX_PERCENT=5.0`
- [ ] `MAX_USER_BALANCE=10000` (or your chosen cap, in HBAR)
- [ ] `WITHDRAWAL_DAILY_CAP_HBAR=1000` (or chosen cap)
- [ ] `HCS20_TOPIC_ID=<from Phase 1>`
- [ ] `HCS20_TICK=LLCRED`
- [ ] `OPERATOR_WITHDRAW_ADDRESS=<address that gets rake withdrawals>`

### Auth + CORS
- [ ] `AUTH_PAGE_ORIGIN=https://agent.lazysuperheroes.com`
      (NOT a wildcard. Production fail-closed.)
- [ ] `ADMIN_ACCOUNTS=<comma-separated mainnet operator account IDs>`
- [ ] `MCP_AUTH_TOKEN=<a strong random token if you want a fallback>`
      (optional — session tokens work without it)

### Upstash Redis
- [ ] `KV_REST_API_URL=<from Upstash>` (or `UPSTASH_REDIS_REST_URL`)
- [ ] `KV_REST_API_TOKEN=<from Upstash>` (or `UPSTASH_REDIS_REST_TOKEN`)

### Public URLs
- [ ] `NEXT_PUBLIC_APP_URL=https://agent.lazysuperheroes.com`
- [ ] `NEXT_PUBLIC_HEDERA_NETWORK=mainnet`
- [ ] `AGENT_MCP_URL=` (leave empty unless overriding)
- [ ] `NEXT_PUBLIC_SUPPORT_URL=mailto:support@lazysuperheroes.com`
      (or whatever your support contact is — unblocks the
      "Contact Support" button on /account stuck deposits)

### HOL registry
- [ ] `HOL_API_KEY=<mainnet rbk_... key>`

### Cron secret (for the reconcile cron — see uptime monitoring doc)
- [ ] `CRON_SECRET=<strong random string>`

---

## Phase 4 — First deploy + smoke test

- [ ] Trigger the first deploy from Vercel UI (push or manual)
- [ ] Watch the build log for any error
- [ ] After deploy succeeds, before flipping DNS, hit the deployment
      URL Vercel gave you (something like
      `lazylotto-agent-abc123.vercel.app`) and verify each:

#### Public endpoints (no auth needed)
- [ ] `GET /api/health` returns 200 with `network: 'mainnet'` and the
      correct `version` (should match `package.json`)
- [ ] `GET /api/discover` returns the discovery payload with the
      mainnet URL in `endpoints.mcp` and `endpoints.health`
- [ ] `GET /api/public/stats` returns 200 with `agentName`, `network: 'mainnet'`,
      `agentWallet` matching your mainnet operator account
- [ ] `POST /api/mcp` with a JSON-RPC `initialize` returns
      `serverInfo: { name: 'lazylotto-agent', version: '0.1.X' }`
- [ ] `POST /api/mcp` with `tools/list` returns the full tool list
      (~13 multi-user + 7 operator)

#### Auth flow
- [ ] Visit `/auth` in a browser, connect with the operator wallet,
      sign the challenge, land on `/dashboard`
- [ ] Confirm the session token is stored in localStorage
- [ ] Navigate to `/admin` and confirm you can see the admin dashboard
      (requires your account in `ADMIN_ACCOUNTS`)

#### Critical operator actions
- [ ] From the MCP endpoint with operator session token, call
      `operator_health` — should return `mode: 'serverless'` and
      `depositDetection: 'on-demand'`
- [ ] Call `operator_balance` — should show zero rake collected on
      a fresh deploy
- [ ] Call `operator_reconcile` — should return `solvent: true` with
      empty deltas (no users, no deposits yet)

---

## Phase 5 — HOL registration

See `docs/mainnet-hol-registration.md` for the dedicated checklist.
Returns a UAID you should record below.

- [ ] HOL registration completed
- [ ] Mainnet UAID recorded: `_______________`
- [ ] HCS-11 profile topic recorded: `_______________`

---

## Phase 6 — Cron + monitoring (recommended before public traffic)

- [ ] Vercel Cron configured to hit `/api/cron/reconcile` hourly
      (see `vercel.json` after the cron PR lands)
- [ ] External uptime monitor pointed at `/api/health` (see
      `docs/uptime-monitoring.md` for setup options)
- [ ] Slack/Discord webhook for cron failures (or however you want
      to be paged)

---

## Phase 7 — DNS cutover + first user

- [ ] Update DNS to point `agent.lazysuperheroes.com` at the Vercel
      deployment
- [ ] Wait for DNS propagation (~5 min for most CDN-fronted domains)
- [ ] Visit `https://agent.lazysuperheroes.com/api/health` and confirm
      it loads
- [ ] Sign in once with your operator wallet, register as a user
      ("operator who plays" account), deposit a small amount of HBAR
      to verify the deposit watcher fires
- [ ] Run a single play session to verify v2 audit messages land on
      the topic correctly (check `/audit` page for the new SessionCard)
- [ ] Verify reconciliation: `/admin` → reconcile → `solvent: true`
      with the deposit reflected

---

## Phase 8 — Share with first external users

- [ ] Update `docs/testnet-user-guide.md` references that say "testnet"
      to also mention mainnet (or write a parallel `mainnet-user-guide.md`)
- [ ] Share the URL with the first batch of users
- [ ] Watch the audit page + admin dashboard + reconcile cron output
      for the first 24 hours

---

## Rollback plan

If something is wrong post-cutover:

1. **Revert the DNS** to point at the old (testnet?) deployment, or
   to a holding page
2. **Engage the kill switch** via the admin dashboard so deposits and
   plays are paused but withdrawals stay open
3. **Diagnose** via Vercel function logs + the reconcile output
4. **Fix forward** in a new commit, redeploy, re-verify Phase 4
5. **Disengage kill switch** when fixed

The kill switch is your friend — it lets you pause new activity without
locking users out of their funds. Do not skip wiring it up in
`ADMIN_ACCOUNTS`.

---

## Notes

- The mainnet HCS-20 topic should NEVER receive v1 batch messages.
  Confirm by running `src/scripts/test-v2-reader.ts` against it after
  any test play and verifying `stats.v1Messages === 0`.
- Mainnet rake goes to the agent operator account by default. To send
  it to a separate fee-collection wallet, set `OPERATOR_WITHDRAW_ADDRESS`.
- Per the project's project memory, $LAZY uses 1 decimal place. The
  token registry handles this; just make sure `LAZY_TOKEN_ID` is set
  to the mainnet token (`0.0.1311037`) and not the testnet one.
