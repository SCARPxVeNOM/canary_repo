# Canary

**See what a dapp leaks before you connect, and stop it once you do. No dapp fork required.**

ETHGlobal Mumbai 2026. Built on the Ethereum Foundation's [anon-rpc](https://github.com/ethereum/anon-rpc).

Dapps built on wagmi/viem send your reads (`balanceOf(you)`, allowances, positions) straight from your browser to *their* RPC provider, and often send your address to analytics too. Your wallet's RPC settings never touch that traffic. Canary is a browser extension that:

1. **answers the dapp's own RPC reads through anon-rpc**, so the dapp's provider never sees them;
2. **blocks third-party requests that carry your wallet address** (fetch, XHR, WebSocket, beacons, pixels);
3. **reports measured coverage**: what was protected, blocked, left exposed, or not inspected.

Planned next: an ENSv2 privacy manifest per dapp (declared vs observed) and a scanner that produces signed verdicts. See [idea.md](idea.md).

The dapp itself can always see your address and your IP. Canary protects you from third parties: RPC providers, analytics, trackers.

## Status

| Part | State |
|---|---|
| Enforcement extension ([`extension/`](extension/)) | Working. End-to-end test 24/24 against a leaky fixture dapp. |
| Live over Tor | The earlier spike ran on the unmodified app.ens.domains: 8/8 of its RPC batches to its own keyed provider were answered via anon-rpc instead (1.3–2.8 s each). |
| Scanner (Playwright + mitmproxy) | Not started |
| ENSv2 manifest + signed verdicts | Not started |

## Repo layout

| Path | What |
|---|---|
| [`extension/`](extension/) | The Canary MV3 extension: shim, policy, popup, e2e test |
| [`idea.md`](idea.md) | Team working doc: product, architecture, coverage model, build plan, risks, tracks |
| [`agent-sdk.md`](agent-sdk.md) | Blueprint: Canary for autonomous agents (gateway + SDK + ENSv2 agent names) |
| [`test-repo.md`](test-repo.md) | Test log of the anon-rpc repo and of the Canary spike, with numbers |
| [`test-artifacts/`](test-artifacts/) | Raw logs and benchmark output referenced by test-repo.md |
| [`canary-spike/`](canary-spike/) | The first proof of concept (superseded by `extension/`) |

## Quick start

```sh
cd extension
npm install
npm run build        # → extension/dist, configured for tor-js
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist`. Use a separate Chrome profile: it runs on every site. The first boot of the Tor worker takes about 13 s.

Tests: `CHROME_BIN=/path/to/chromium npm test` (needs full Chromium or Chrome for Testing; see [`extension/README.md`](extension/README.md)).

## CROPS

- **C (censorship resistance):** Canary depends on the anon-rpc network's gateway (EF's demo gateway by default; configurable) and on the read endpoints in `extension/config/live.json`. If they go away, Canary fails closed and the popup says so; a per-site opt-in allows direct requests instead.
- **O (open source):** MIT. Everything builds from this repo with `npm install && npm run build`.
- **P (privacy):** the read endpoint learns which addresses are queried, but not your IP or which dapp you're using. Forwarded non-standard calls reveal the dapp to its provider, not your IP. The dapp itself still sees your address and IP. Canary has no analytics or telemetry.
- **S (security):** Canary never holds keys or signs anything. The anon-rpc worker is hash-pinned on chain and runs in a null-origin sandbox with none of the extension's permissions. Read endpoints could lie about responses; proof verification is future work.

## License

MIT. `extension/test/fixtures/passthrough-worker.js` is the reference worker from [ethereum/anon-rpc](https://github.com/ethereum/anon-rpc) (MIT, © 2026 Ethereum Foundation), used only by the tests.
