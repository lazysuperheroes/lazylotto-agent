# Mainnet HOL Registration Checklist

> Operator-runnable checklist for registering the LazyLotto Agent
> on Hashgraph Online's mainnet registry, after the Vercel deployment
> from `mainnet-deploy-checklist.md` is live and verified.

This is a one-time action that mints a Universal Agent ID (UAID) and
publishes the agent's HCS-11 profile to a Hedera Consensus Service
topic. Once done, anyone with mirror node access can find the agent
via HOL search.

---

## Prerequisites

Before running registration, confirm:

- [ ] The mainnet Vercel deployment is live and `/api/discover`
      returns a payload with `network: 'mainnet'` and the correct
      `endpoints.mcp` URL pointing at `agent.lazysuperheroes.com/api/mcp`
- [ ] The mainnet operator wallet (`HEDERA_ACCOUNT_ID` from the env)
      has at least **5 HBAR** for the inscription transaction
      (typical cost is < 1 HBAR but leave headroom)
- [ ] You have `HOL_API_KEY` (an `rbk_...` key from the HOL team)
      configured locally in `.env` for running the CLI
- [ ] Local `.env` is set to mainnet: `HEDERA_NETWORK=mainnet`,
      `HEDERA_ACCOUNT_ID=<mainnet>`, `HEDERA_PRIVATE_KEY=<mainnet>`
- [ ] **There is no `.agent-config.json` from a previous mainnet
      run.** If there is, back it up and remove it — the CLI's
      registration flow needs to start clean.
      ```bash
      mv .agent-config.json .agent-config.json.bak-$(date +%s) 2>/dev/null
      ```

---

## Step 1 — Run the registration

From the project root, with mainnet env vars active:

```bash
npx tsx src/index.ts --register
```

You should see output like:

```
HOL: Registering agent with HOL registry...
  Inscribing HCS-11 profile...
  Profile topic: 0.0.XXXXX
  Inscription cost: 0.X HBAR
  Saved partial config (profile inscribed, broker pending)
  Registering with HOL registry broker...
  Registered! UAID: uaid:aid:XXXXXX...
  Saved to .agent-config.json
```

If the broker step fails but the inscription succeeded, the partial
config is saved. You can re-run `--register` (without `--force`) to
retry just the broker step.

- [ ] Inscription succeeded — note the **profile topic ID**: `_______________`
- [ ] Broker registration succeeded — note the **UAID**: `_______________`
- [ ] `.agent-config.json` written and committed-to-backup (NOT to git;
      it's already in `.gitignore`)

---

## Step 2 — Verify on the broker

The broker exposes `https://hol.org/registry/api/v1/resolve/{uaid}`.
URL-encode the UAID:

```bash
UAID="<your-mainnet-uaid>"
ENCODED="${UAID//:/%3A}"
curl -s "https://hol.org/registry/api/v1/resolve/$ENCODED" | python -m json.tool
```

Verify:

- [ ] Returns 200, not 404
- [ ] `agent.name === "LazyLotto Agent"`
- [ ] `agent.registry === "hashgraph-online"`
- [ ] `agent.metadata.nativeId === "lazylotto-agent"`
- [ ] `agent.description` mentions the auth URL
      (`https://agent.lazysuperheroes.com/auth`)
- [ ] `agent.metadata.registeredAt` matches the current date

Also verify by search:

```bash
curl -s "https://hol.org/registry/api/v1/search?q=lazylotto&limit=10" \
  | python -m json.tool
```

- [ ] Mainnet entry appears in the hits (you may also see the testnet
      entry — that's expected and harmless because the broker indexes
      by `aid`, derived from the Hedera key, and your testnet vs
      mainnet operator accounts have different keys → different aids)

---

## Step 3 — Verify HCS-11 topic on HashScan

The inscribed profile message lives on the topic ID from Step 1.
Open it in HashScan mainnet:

```
https://hashscan.io/mainnet/topic/<profile topic ID>
```

- [ ] Topic exists and shows at least one message
- [ ] First message decodes to a valid HCS-11 profile JSON with
      `display_name: 'LazyLotto Agent'`, `model: 'rule-based/ev-scoring'`,
      and the `properties` bag containing `mcp_endpoint`,
      `discover_endpoint`, `auth_endpoint`, `dashboard`,
      `rake_range`, `accepted_tokens`

> **Note**: The HOL broker drops the `properties` bag at registration
> time (it only stores name/description/capabilities/category). The
> on-chain HCS-11 record is the only place where the full profile
> lives. Clients that need the connection URLs should hit
> `/api/discover` directly — see `docs/hol-discovery-guide.md` for
> the three-layer model explanation.

---

## Step 4 — Update the agent's discover endpoint

The mainnet agent's `/api/discover` should return its own UAID in the
response. Verify:

```bash
curl -s https://agent.lazysuperheroes.com/api/discover | python -m json.tool
```

- [ ] `uaid` field matches what you got from registration
      (or is `null` if the env var isn't set yet — see below)

If the UAID is `null`, set the `UAID` env var on Vercel and redeploy:

- [ ] Set `UAID=<mainnet uaid>` on the Vercel project (production scope)
- [ ] Trigger a redeploy
- [ ] Re-curl `/api/discover` and confirm `uaid` is populated

---

## Step 5 — Record the registration

Update the project's records so future ops have the source of truth:

- [ ] Add the mainnet UAID and profile topic to a private operator
      runbook / vault entry (do NOT commit to the repo)
- [ ] Update `WORKING_PLAN.md` with the live mainnet UAID
- [ ] If you maintain a public registry of LSH agents, link it there

---

## Failure modes + fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| Inscription fails with `ACCOUNT_BALANCE_LOW` | Not enough HBAR | Top up the operator account, retry |
| Inscription succeeds but broker step fails with 401 | `HOL_API_KEY` missing or wrong | Set the key, re-run `--register` (it'll skip re-inscription if a partial config exists) |
| Broker returns `pending` status and never resolves | Broker queue backlog | Wait a minute then re-run `--register`. The CLI handles the pending case via `waitForRegistrationCompletion`. |
| Resolve returns 404 immediately after registration | Mirror node propagation lag | Wait 30 seconds and retry the curl |
| `--register --force` returns 503 `profile_registry_unavailable` | Broker doesn't support PUT updates for our registry namespace (known limitation) | Don't use `--force` — there's nothing to update if the registration succeeded |
| Search results show stale name/description | Broker re-indexes async | Allow up to 10 minutes; if it persists, file a ticket with HOL |

---

## What you do NOT need to do

- **Re-inscribe the profile** — once a UAID exists, the broker indexes
  by `aid`, which is deterministic from the Hedera key. Re-inscribing
  creates a new on-chain topic but doesn't change what the broker
  serves.
- **Pay anything to the broker** — the registration is included in
  the inscription HBAR cost. There is no per-message broker fee.
- **Touch testnet** — testnet and mainnet UAIDs are completely
  independent. Different keys → different aids → different broker
  records.
