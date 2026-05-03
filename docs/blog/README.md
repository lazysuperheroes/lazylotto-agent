# LazyLotto Agent — Engineering Blog

Three perspectives on the same system.

| Post | Audience | What it covers |
|------|----------|----------------|
| [**Lazy Wins**](lazy-wins.md) | Players, the Web3-curious, anyone who'd rather not click buttons | Why we built an agent that plays the lottery so you don't have to. The product thesis, the "lazy is a virtue" philosophy, who it's for, and what's unique. |
| [**Trust by Design**](trust-by-design.md) | Savvy crypto / Web3 readers, builders, operators | Why a custodial lottery agent can still be yours. Hot-wallet blast radius, wallet-only privileged auth on hosted, per-user reservation isolation, layered Redis safety, an on-chain audit trail you can verify without us, and a tested key-rotation runbook. |
| [**How We Built It**](architecture-deep-dive.md) | Engineers, system designers, MCP / A2A enthusiasts | Dual-protocol surface (MCP + A2A in one Lambda), three deployment modes, the HCS-20 v2 audit trail, per-token reservation, layered Redis safety (individual fail-open + aggregate fail-closed), and the serverless × Hedera design choices. |

---

If you're new here, start with **[PLAYERS.md](../../PLAYERS.md)** for the
five-minute version, or the **[README](../../README.md)** for the
engineering entrypoint.
