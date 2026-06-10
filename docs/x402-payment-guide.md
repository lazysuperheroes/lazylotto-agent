# Paying for a Rake Holiday (x402 on Hedera)

LazyLotto charges a small **rake** on each deposit (the agent's fee for playing on
your behalf). The **rake holiday** is a paid upgrade: **pay a one-off
USD-denominated price and get 0% rake for 30 days.** Payment is collected with
**[x402](https://x402.org) on Hedera** — an HTTP-native payment standard — so an
AI agent (or you) can pay programmatically.

- **Endpoint:** `POST /api/premium/rake-holiday`
- **Price:** USD-denominated (default **$5.00**), payable in **USDC** or the
  **live HBAR equivalent**.
- **Auth:** your LazyLotto session token (`Authorization: Bearer sk_…`) — it
  identifies *whose* rake holiday this is.
- **Off by default:** the gate only runs when the operator sets `X402_ENABLED=true`
  and an `X402_PAY_TO`. When off, the endpoint returns `503` (no free holidays).

> **Verified working** end-to-end against the Blocky402 testnet facilitator on
> 2026-06-09 (HBAR path): `402 → buyer-signed transfer → facilitator verify →
> settle → 0% rake for 30 days`.

## How the gate works (x402 exact-scheme, Hedera)

1. You `POST` the endpoint with **no payment** → it replies **`402`** with a
   `PaymentRequired` body listing `accepts` (one option per asset: USDC and HBAR),
   each with the atomic `amount`, the `payTo` account, the facilitator `feePayer`,
   and human-readable `extra.display` / `extra.priceUsd`.
2. You build a Hedera `TransferTransaction` paying the chosen `amount` to `payTo`,
   **with the facilitator as the fee-payer**, sign it with your account, and
   base64-encode it into an `X-PAYMENT` header.
3. You re-`POST` with the `X-PAYMENT` header → the server calls the facilitator's
   `verify` then `settle` (the facilitator co-signs the fee and submits on-chain)
   → on success the rake holiday is granted and you get `200`.

Key facts (so you don't rediscover them): **`x402Version` is `2`** (the
x402-foundation stack, not Coinbase's `1`); the network id is **CAIP-2
`hedera:testnet`**; the testnet **facilitator** is `https://api.testnet.blocky402.com`
(fee-payer `0.0.7162784`, keyless).

---

## Path C — pay from the dashboard (easiest, no code)

If you're a human with a Hedera wallet, just use the dashboard. Sign in at
`/auth`, open `/dashboard`, and click **"💎 0% rake for 30 days ↗"** on the rake
line. Pick **HBAR** or **USDC** (on testnet a faucet link appears if you need
testnet USDC), then **Pay … with wallet** and approve the transfer. The
facilitator covers the network fee; you send only the quoted amount. The
402 → sign → settle loop runs under the hood — you just approve one transfer.

---

## Path A — let an AI agent pay (recommended if you have one)

If your agent has a **Hedera account** and an **x402 payment capability** (e.g. an
Agent Kit plugin like [`hak-mppx-hedera-plugin`](https://github.com/tomrowbo/hak-mppx-hedera-plugin),
or any x402-`fetch` wrapper), it can handle the whole 402 → pay → retry loop from
a prompt. Give it your session token and a prompt like:

```
Purchase a 30-day "rake holiday" for my LazyLotto account.

- Endpoint: POST https://testnet-agent.lazysuperheroes.com/api/premium/rake-holiday
- Authenticate with: Authorization: Bearer <MY_SESSION_TOKEN>
- It is x402-gated on Hedera testnet (x402Version 2, scheme "exact").
- On the 402, choose the HBAR option (asset "0.0.0"), pay the quoted amount to
  the payTo account using the facilitator as fee-payer, and retry with the
  X-PAYMENT header.
- Confirm the response says the rake holiday is active and tell me the amount
  paid and the expiry.
```

The agent reads the 402, signs the transfer from its Hedera account, and retries —
no bespoke code needed on your side.

---

## Path B — pay manually with the reference script

For testing (or if you don't have an x402-capable agent), use the bundled
simulator **`uat-x402.ts`** (repo root). It does exactly Path A's steps and prints
each one.

### What you need

| Variable | What it is | How to get it |
|---|---|---|
| `SESSION_TOKEN` | Your LazyLotto session token (who gets the holiday) | Sign in at `/auth`, then in the browser console: `localStorage.getItem('lazylotto:sessionToken')` |
| `BUYER_ACCOUNT_ID` | A **funded** Hedera testnet account that pays — **must differ from `payTo`** | Create one in the [Hedera Portal](https://portal.hedera.com/faucet) (gives testnet HBAR) |
| `BUYER_PRIVATE_KEY` | That account's key (DER / ECDSA / ED25519 all handled) | From the Portal / your wallet |
| `BASE_URL` | optional, default `http://localhost:3000` | your deployment URL for a hosted test |

The buyer needs **≥ the quoted amount** of HBAR (the facilitator pays the network
fee). At $5 that's ~63 HBAR; to iterate cheaply, set
`X402_RAKE_HOLIDAY_PRICE_USD_CENTS=10` (~1.3 HBAR). For the **USDC** option
instead, the buyer must hold testnet USDC (`0.0.429274`, from
[Circle's faucet](https://faucet.circle.com)) **and** be associated with that
token — see `docs/uat-chat-x402.md` §0.

### Run it

```powershell
# BUYER_ACCOUNT_ID / BUYER_PRIVATE_KEY in .env; token as the first arg:
npx tsx uat-x402.ts sk_YOUR_SESSION_TOKEN
```

You'll see `step1` (the 402), `payloadResult` (your signed payment), and
`step2`. Success looks like:

```json
{ "ok": true, "rakeHoliday": { "paid": "62.79 HBAR", "until": "2026-07-09T…",
  "settlementTx": "0.0.7162784@1781031765…" },
  "message": "Rake holiday active — 0% rake until 2026-07-09T…. You paid 62.79 HBAR." }
```

After that, any deposit you make for the next 30 days is credited at **0% rake** —
the audited `creditDeposit` path is unchanged; it simply receives `rakePercent = 0`
while the holiday is active.

To switch the script to the USDC option, change the `accepts.find(a => a.asset === '0.0.0')`
line to your USDC token id (and fund + associate the buyer first).
