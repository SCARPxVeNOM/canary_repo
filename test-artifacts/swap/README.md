# Canary Swap, live runs (6 Nov 2026)

| File | What |
|---|---|
| `live-canary.json` | The deployed page (https://canary-swap.vercel.app) with Canary (`extension/dist-local`, our tor-js gateways): quote, connect, swap ETH → CNRY, mint, swap CNRY → ETH; every transaction's receipt; Canary's counts (all 50 reads `protected`); the popup's badge and summary rows |
| `popup-canary.png`, `swap-canary.png` | The popup for that tab, and the page at the end of the run |
| `live-local.json` | The local page without Canary, from a fresh wallet: the same flow, five transactions including the two Permit2 approvals |
| `agent-swap.log` | `examples/viem-agent/swap.mjs` through `npm run gateway:local`: every call the gateway made, and its coverage |

Made with `swap/test/live.mjs` and `examples/viem-agent/swap.mjs` (see `swap/README.md`). The wallets are Sepolia test wallets made for these runs.
