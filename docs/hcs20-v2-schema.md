# HCS-20 v2 Schema Spec — LazyLotto Audit Trail

> External-auditor-facing specification for the on-chain audit
> messages written by the LazyLotto Agent on Hedera Consensus
> Service. Anyone with mirror node access and this document can
> write a reader and verify the operator's bookkeeping.

This is the **wire format** spec. The reader implementation lives
at `src/custodial/hcs20-reader.ts` in the agent repo and is
licensed Apache-2.0. You don't need to read the source — this doc
is sufficient to write a conforming reader from scratch.

---

## Topic IDs

| Network | Topic ID | Schema |
|---|---|---|
| Testnet | `0.0.8499866` | Mixed v1 + v2 |
| Mainnet | TBD (recorded after first deploy) | v2 only |

The mainnet topic was created v2-only and will never contain v1
batch messages. Testnet started v1 and migrated to v2 partway
through; both shapes coexist there. A reader designed for
production should support both for the testnet's sake but does
not need v1 emission logic — only the v1 read path matters.

---

## Standards baseline

- **HCS-20** (Hashgraph Consensus Service - Token standard) is
  the underlying protocol. We use the message format only —
  ownership / submit-key validation is delegated to Hedera.
- All messages are JSON, base64-encoded by the mirror node when
  retrieved via REST.
- Single-line JSON only (no chunking via SDK chunk_info).
- Maximum message size: **1024 bytes** — enforced by Hedera, also
  enforced client-side by the writer with a hard fail.
- Submit key: operator account only. There is no shared write
  permission.

---

## Message envelope

Every message has:

```json
{
  "p": "hcs-20",
  "op": "<op type>",
  ...op-specific fields,
  "tick": "LLCRED",       // ONLY on balance-affecting ops
  "ts": "<ISO 8601>"      // Or "timestamp" on legacy v1 messages
}
```

The `p` and `op` fields identify the protocol and operation. The
`tick` field is the credit ledger token ("LLCRED") and is only
present on balance-affecting ops (mint, transfer, burn, refund).
Session lifecycle ops (`play_session_open`, `_close`, etc.) and
`prize_recovery` deliberately omit it because they're not balance
ops.

The `v` field (numeric, currently `2`) is present only on session
lifecycle messages and `prize_recovery`. It's a session-level
fence so future v3 readers can fast-fail on unknown shapes
without parsing every message in a session. Other ops are
disambiguated by op name alone.

---

## v1 message types (legacy, read-only)

### `op: "deploy"`

Topic deployment marker. One per topic, written at create time.

```json
{
  "p": "hcs-20",
  "op": "deploy",
  "name": "LazyLotto Credits",
  "tick": "LLCRED",
  "max": "999999999",
  "lim": "999999999"
}
```

### `op: "mint"` (deposits)

A user deposit was credited. Recorded AFTER the on-chain transfer
landed and the deposit watcher matched the memo to a registered
user.

```json
{
  "p": "hcs-20",
  "op": "mint",
  "tick": "LLCRED",
  "amt": "285",
  "to": "0.0.7349994",
  "memo": "deposit:0.0.X@1775596937.272650838"
}
```

- `amt` is the **net** deposit amount (after rake), in the
  underlying token's display units (HBAR for HBAR deposits, LAZY
  for LAZY deposits, etc.). The `tick: LLCRED` is the credit
  ledger label — it does NOT mean the amount is in some abstract
  credit unit.
- `to` is the user's Hedera account ID
- `memo` includes the original on-chain deposit transaction ID
  for cross-reference

### `op: "transfer"` (rake)

Rake taken at deposit time. Always paired with the corresponding
`mint` immediately preceding it on the topic (next consensus
sequence number).

```json
{
  "p": "hcs-20",
  "op": "transfer",
  "tick": "LLCRED",
  "amt": "15",
  "from": "0.0.7349994",
  "to": "0.0.8456987",
  "memo": "rake"
}
```

- `from` is the user, `to` is the agent operator account
- `memo: "rake"` is the canonical marker
- `amt` in token display units

### `op: "burn"` (withdrawal)

A user withdrew funds back to their Hedera account.

```json
{
  "p": "hcs-20",
  "op": "burn",
  "tick": "LLCRED",
  "amt": "50",
  "from": "0.0.7349994",
  "memo": "withdrawal"
}
```

The reader uses `memo` starting with `"withdraw"` (case-insensitive)
to classify; anything else is treated as a play burn (legacy).

### `op: "burn"` (operator withdrawal)

Operator withdrew accumulated rake. Same shape as user withdrawal
but `from` is the operator account and `memo` starts with
`"operator_withdrawal"` or `"operator-withdrawal"`.

### `op: "batch"` (legacy v1 play session)

Pre-migration play sessions wrote ONE batch message containing N
burn sub-ops. Only the cost side; wins were not on chain.

```json
{
  "p": "hcs-20",
  "op": "batch",
  "tick": "LLCRED",
  "sessionId": "uuid",
  "operations": [
    {
      "op": "burn",
      "amt": "20",
      "memo": "play:pool 2:2-entries",
      "from": "0.0.7349994"
    },
    {
      "op": "burn",
      "amt": "10",
      "memo": "play:pool 1:2-entries",
      "from": "0.0.7349994"
    }
  ],
  "timestamp": "..."
}
```

- The reader treats batch messages as v1 sessions, parses each
  burn sub-op, and reconstructs a `NormalizedSession` with
  `status: closed_success` and a "v1 legacy" warning.
- The `memo` of each burn encodes pool info as
  `play:pool <id>:<count>-entries` or
  `play:pool-<id>:<count>-entries` (both forms accepted).
- v1 sessions have NO win data, NO prize details, NO NFT serials,
  NO prize transfer status. Anything that needs that data has to
  fall back to a local store join — and external auditors can't
  do that.

### `op: "control"`

Operator control event (kill switch toggles, schema markers, etc.).
Not balance-affecting.

```json
{
  "p": "hcs-20",
  "op": "control",
  "tick": "LLCRED",
  "event": "killswitch_enabled",
  "reason": "investigating insolvency",
  "by": "0.0.OPERATOR",
  "timestamp": "..."
}
```

---

## v2 message types

### `op: "play_session_open"` (v2)

First message of a play session. Carries session metadata that
doesn't repeat per pool.

```json
{
  "p": "hcs-20",
  "op": "play_session_open",
  "v": 2,
  "sessionId": "uuid",
  "user": "0.0.7349994",
  "agent": "0.0.8456987",
  "agentSeq": 42,
  "strategy": "balanced",
  "boostBps": 0,
  "expectedPools": 5,
  "ts": "2026-04-08T01:00:00.000Z"
}
```

- `sessionId` is a fresh UUID per play session
- `user` is the playing user's Hedera account
- `agent` is the operator account that ran the play
- `agentSeq` is a monotonic per-agent counter (see "Drop detection"
  below)
- `strategy` is the strategy name from the user's strategy snapshot
- `boostBps` is the win-rate boost in basis points (0 if no LSH NFT
  delegation)
- `expectedPools` is a hint to the reader for the number of
  `play_pool_result` messages to expect

### `op: "play_pool_result"` (v2)

One per pool actually played in the session. The reader groups
these by `sessionId` and walks them in `seq` order.

```json
{
  "p": "hcs-20",
  "op": "play_pool_result",
  "sessionId": "uuid",
  "user": "0.0.7349994",
  "agentSeq": 43,
  "poolId": 2,
  "seq": 1,
  "entries": 2,
  "spent": "20",
  "spentToken": "HBAR",
  "wins": 1,
  "prizes": [
    { "t": "ft", "tk": "HBAR", "amt": 50 },
    { "t": "nft", "tk": "0.0.8221452", "sym": "WF", "ser": [15] }
  ],
  "strategyMeta": { "ev": 0.85, "budgetRemaining": 80 },
  "ts": "2026-04-08T01:00:01.000Z"
}
```

- `poolId` is the LazyLotto pool numeric ID
- `seq` is the 1-indexed position of this pool within the session
  (used for ordering, especially when multiple sessions interleave
  on the topic)
- `entries` is how many lottery entries the agent bought
- `spent` is the amount spent in this pool, in `spentToken` units
- `spentToken` is `"HBAR"` for native HBAR pools or a Hedera token
  ID like `"0.0.8011209"` for FT pools
- `wins` is the prize count (number of distinct prize objects won)
- `prizes` is a discriminated array of prize entries:
  - `{ t: "ft", tk: <token>, amt: <number> }` for fungible prizes
  - `{ t: "nft", tk: <hedera token id>, sym: <symbol>, ser: [<serials>] }` for NFT prizes
- `strategyMeta` is optional decision-input data (the agent's EV
  estimate, budget remaining at decision time) — useful for
  defensible audit ("here's why the agent thought this play was
  good"), can be absent on older messages

### `op: "play_session_close"` (v2)

Final message of a successful play session. Carries the totals
and the prize-transfer outcome.

```json
{
  "p": "hcs-20",
  "op": "play_session_close",
  "sessionId": "uuid",
  "user": "0.0.7349994",
  "agentSeq": 48,
  "poolsPlayed": 5,
  "poolsRoot": "sha256:abcdef0123456789...",
  "totalWins": 2,
  "prizeTransfer": {
    "status": "succeeded",
    "txId": "0.0.X@1775596937.272650838",
    "attempts": 1,
    "gasUsed": 5450000
  },
  "ts": "2026-04-08T01:00:05.000Z"
}
```

- `poolsPlayed` is the number of `play_pool_result` messages the
  reader should have seen for this session
- `poolsRoot` is the **canonical Merkle hash** of the pool data
  (see "poolsRoot derivation" below). The reader recomputes this
  from the pool messages it actually saw and rejects the close if
  they disagree — the tamper-evidence layer.
- `totalWins` is the sum of `wins` across all pool messages (a
  convenience field, also derivable)
- `prizeTransfer` is the outcome of the `transferPendingPrizes`
  contract call:
  - `status`: `succeeded | skipped | failed | recovered`
  - `txId`: the contract tx ID (only on `succeeded` and `recovered`)
  - `attempts`: how many retry attempts before success
  - `gasUsed`: the final gas value used
  - `lastError`: error message (only on `failed`, truncated to
    ~200 chars)

### `op: "play_session_aborted"` (v2)

Written instead of `play_session_close` if the v2 emission sequence
dies mid-stream. Positive terminal marker — distinct from "close
is missing" (which the reader treats as `in_flight` or `orphaned`).

```json
{
  "p": "hcs-20",
  "op": "play_session_aborted",
  "sessionId": "uuid",
  "user": "0.0.7349994",
  "agentSeq": 47,
  "completedPools": 3,
  "reason": "v2_write_failure",
  "lastError": "topic temporarily unavailable",
  "abortedAt": "2026-04-08T01:00:04.000Z"
}
```

- `completedPools` is how many `play_pool_result` messages were
  successfully written before the abort
- `reason` is a free-text classification (current values:
  `v2_write_failure`, `agent_restart`, `manual_abort`)

### `op: "refund"` (v2)

Operator-initiated refund of a stuck deposit. The inverse of `mint`.

```json
{
  "p": "hcs-20",
  "op": "refund",
  "tick": "LLCRED",
  "amt": "100",
  "from": "0.0.8456987",
  "to": "0.0.7349994",
  "originalDepositTxId": "0.0.X@...",
  "refundTxId": "0.0.X@...",
  "reason": "stuck_deposit",
  "performedBy": "0.0.OPERATOR",
  "ts": "..."
}
```

- `from` is the agent (paying out)
- `to` is the user (receiving)
- `originalDepositTxId` is the deposit being refunded (cross-ref
  to a `mint` op earlier in the topic)
- `refundTxId` is the on-chain Hedera transfer that actually
  moved the funds back
- `reason` is one of `stuck_deposit | operator_initiated | admin`
  or other free-text values

### `op: "prize_recovery"` (v2)

Operator-initiated stuck-prize recovery. Records when the
in-flight `transferPendingPrizes` failed and an operator pushed
the prizes through manually.

```json
{
  "p": "hcs-20",
  "op": "prize_recovery",
  "tick": "LLCRED",
  "v": 2,
  "user": "0.0.7349994",
  "agent": "0.0.8456987",
  "prizesTransferred": 22,
  "prizesByToken": { "HBAR": 668, "LAZY": 50 },
  "contractTxId": "0.0.X@...",
  "reason": "INSUFFICIENT_GAS recovery",
  "performedBy": "0.0.OPERATOR",
  "affectedSessions": ["uuid-1", "uuid-2"],
  "attempts": 1,
  "gasUsed": 5450000,
  "timestamp": "..."
}
```

---

## poolsRoot derivation

The Merkle hash on `play_session_close` is computed as follows
(both the writer and any conforming reader MUST use this exact
algorithm):

1. Take the array of pool data tuples for the session, where each
   tuple is `{ poolId, spent, spentToken, wins, prizes }`
2. Sort the array ascending by `poolId`
3. For each pool, canonicalize the prizes array:
   - Split into fungible (`t === "ft"`) and NFT (`t === "nft"`)
     entries
   - Sort fungible entries ascending by `tk` (token id)
   - For each NFT entry, sort `ser[]` ascending
   - Sort NFT entries ascending by `tk`
   - Concatenate: fungible entries first, then NFT entries
4. Hash the canonical prizes array as `prizesHash =
   sha256(JSON.stringify(canonicalPrizes))` (hex digest)
5. For each pool, build the line:
   `${poolId}|${spent}|${spentToken}|${wins}|${prizesHash}`
6. Join all lines with `\n`
7. Hash the joined string: `sha256(joined).hexDigest()`
8. Prepend `"sha256:"` to get the final `poolsRoot` value

Example:

```js
// Pool data
const pools = [
  { poolId: 0, spent: 4, spentToken: 'HBAR', wins: 0, prizes: [] },
  { poolId: 2, spent: 20, spentToken: 'HBAR', wins: 1,
    prizes: [{ t: 'ft', tk: 'HBAR', amt: 50 }] }
];
// Canonical lines:
// "0|4|HBAR|0|<sha256 of '[]'>"
// "2|20|HBAR|1|<sha256 of '[{\"t\":\"ft\",\"tk\":\"HBAR\",\"amt\":50}]'>"
// Joined with \n, then sha256, then prefix.
```

The reader recomputes this from the pool messages it actually
saw and rejects the close if the result doesn't match what the
writer claimed. Any mismatch is logged as `corrupt` and the
session is rendered with a red warning.

---

## State machine for play session reconstruction

For each `sessionId`, the reader walks the messages in consensus
order and produces one of these terminal states:

| Status | Condition |
|---|---|
| `closed_success` | `open` + N `pool_result` + `close` seen, AND poolsRoot matches AND `poolsPlayed` matches observed pool count |
| `closed_aborted` | `open` + N `pool_result` + `aborted` seen |
| `corrupt` | `close` seen but poolsRoot or pool count disagrees with observed messages — possible tampering or bug |
| `in_flight` | `open` seen, no terminal yet, within `SESSION_INFLIGHT_TIMEOUT_MS` (5 minutes) of open timestamp |
| `orphaned` | One of: pool messages without preceding `open`; OR `open` with no terminal past the 5-minute timeout |

The v1 fallback path (`op: "batch"`) always produces
`closed_success` with a "v1 legacy session — wins not tracked on
chain" warning.

---

## Drop detection via `agentSeq`

Every v2 message stamps an `agentSeq` field — a monotonic counter
maintained by the writer. Recovery on writer restart: scan the
topic backwards for the agent's last seen `agentSeq` and start
from `last + 1`.

A conforming reader walks all v2 messages, groups them by agent
(via the session's `open.agent` field), and checks for gaps in
the per-agent sequence. Gaps indicate dropped messages — likely
because a write transaction failed without a retry.

Per-agent gaps are reported in the reader's stats output:

```json
{
  "agentSeqGaps": [
    { "agent": "0.0.8456987", "afterSeq": 42 }
  ]
}
```

A non-empty `agentSeqGaps` is an audit-quality concern, not a
data-loss event — the missing message can be reconstructed from
the local store if it ever exists, or just acknowledged as a
known unknown.

---

## Reconciliation math (for external auditors)

Given a stream of messages from the topic, you can reconstruct a
user's complete ledger using ONLY the on-chain data:

```
For user X:
  totalDeposited(X) = Σ mint.amt where to == X
  totalRake(X)      = Σ transfer.amt where from == X AND memo == 'rake'
  totalSpent(X)     = Σ play_pool_result.spent where user == X
                    + Σ batch.operations[].amt where memo starts with 'play:'
                      AND from == X (v1 legacy fallback)
  totalWithdrawn(X) = Σ burn.amt where from == X AND memo starts with 'withdraw'
  totalRefunded(X)  = Σ refund.amt where to == X

  ledger_balance(X) = totalDeposited(X) - totalRake(X) - totalSpent(X)
                    - totalWithdrawn(X) - totalRefunded(X)
```

The agent's wallet on-chain HBAR balance should equal:

```
sum(all_users.ledger_balance) + operator_rake_collected - operator_gas_spent
```

(plus a small drift for tracked-but-not-yet-settled transactions).

Discrepancies indicate one of:
- Operator-side accounting bug (compare to the agent's local
  ledger snapshot)
- Refunds, prize recoveries, or other ops not yet recorded on
  chain (look for incomplete sessions or stale dead letters)
- Phantom funds (HBAR sent to the agent without a `mint` —
  external top-ups, ghost deposits, etc.)

---

## What's NOT on chain

These intentionally live OFF chain (in the agent's local store)
and are NOT recoverable from the topic:

- The mapping from internal `userId` (UUID) to `hederaAccountId`
  — but the topic is keyed by `hederaAccountId` so this doesn't
  matter for reconstruction
- The user's chosen rake percentage (defaults to 5% per the
  config)
- The user's `depositMemo` — issued at registration, used by the
  deposit watcher to match incoming transfers; reconstructable
  by enumerating live registrations
- Auth sessions, locks, rate-limit counters — all ephemeral

---

## Versioning + future migrations

If a future v3 schema is introduced:

- New op names will be added — readers should fall through to
  `unknown` for unrecognized ops, NOT crash
- Existing ops will not change shape (backward compat)
- The `v` field on session lifecycle messages will indicate the
  shape version — readers should fast-fail on `v > supported`
- The mainnet topic will continue to receive v3 messages
  alongside v2; no separate topic per version
- A new schema spec doc will be published with the same structure
  as this one

---

## Reference reader

The agent repo's reader is at `src/custodial/hcs20-reader.ts`,
licensed Apache-2.0. It's pure (no I/O), state-machine based, and
covers everything in this spec. Tests are in
`src/custodial/hcs20-reader.test.ts` (16 tests).

A simpler standalone CLI verifier — designed to be runnable
without depending on the agent's Redis store — is at
`src/scripts/verify-audit.ts`. It takes a topic ID + account ID
and prints a per-user ledger reconstruction. Useful for
external auditors who want to spot-check a specific user.

---

## Contact

For schema questions or to report a discrepancy:
**hello@lazysuperheroes.com** — include the topic ID, the
session ID (if applicable), and the symptom.
