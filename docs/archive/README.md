# Archive

These documents bootstrapped the implementation. They are kept for historical
reference and are NOT load-bearing for running the system.

If you're looking for current operational documentation, start at the repo root
[`README.md`](../../README.md), then drill into [`../`](../) for operator guides.

| File | What it is | Where the equivalent now lives |
|------|------------|-------------------------------|
| `AUTH_UX_PRD.md` | PRD for wallet-based auth replacing the shared `MCP_AUTH_TOKEN`. Implementation has shipped end-to-end. | README.md "Multi-User Authentication" section + `src/auth/` |
| `HEDERA_AUTH_ARCHITECTURE.md` | Architecture spec for the same auth system. Sequence diagrams + file-by-file change list, all matched by current code. | README.md "Multi-User Authentication" + the `src/auth/` source |
| `MCP_INTEGRATION_DESIGN.md` | Three-part design (contracts, dApp endpoint, agent project). Phases 0-2 marked complete. | The dApp's MCP endpoint lives in a separate repo; this repo's MCP surface is documented in README.md "MCP Server" |
| `MCP_SERVER_DAPP.md` | Reference for the **LazyLotto dApp's** MCP endpoint (a different repo's surface). | The dApp repo. The agent consumes that endpoint via `LAZYLOTTO_MCP_URL` — see Configuration in the root README. |

Do not link to these files from current docs. If something here is still useful,
extract it forward into an operational doc rather than keeping the bootstrap
artefact alive.
