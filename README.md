# Canary

**See what a dapp leaks before you connect, and stop it once you do. No dapp fork required.**

ETHGlobal Mumbai 2026. Built on the Ethereum Foundation's [anon-rpc](https://github.com/ethereum/anon-rpc).

Dapps built on wagmi/viem send your reads (`balanceOf(you)`, allowances, positions) straight from your browser to *their* RPC provider, and often send your address to analytics too. Your wallet's RPC settings never touch that traffic. Canary is a browser extension that:

1. **answers the dapp's own RPC reads through anon-rpc**, so the dapp's provider never sees them;
2. **blocks third-party requests that carry your wallet address** (fetch, XHR, WebSocket, beacons, pixels);
3. **reports measured coverage**: what was protected, blocked, left exposed, or not inspected.

The dapp itself can always see your address and your IP. Canary protects you from third parties: RPC providers, analytics, trackers.

**Live demo: https://canary-leakydash.vercel.app**: LeakyDash, a deliberately leaky Sepolia dashboard whose RPC provider, tracker and backend show what they received. Its ENSv2 name `leakydash.eth` declares who should receive your address, and carries an independent verifier's signed verdict on what it actually sends. With the extension installed, the provider and tracker receive nothing and every read goes through anon-rpc (scanner before/after on the live site over tor-js: third parties receiving the address 2 → 0, coverage 0% → 100%, [`test-artifacts/scans/`](test-artifacts/scans/)), and the popup shows the declared recipients and the verdict.

**Canary for agents** ([agent-sdk.md](agent-sdk.md)) applies the same core to autonomous agents, whose reads reveal their strategy before they act:
- a local **gateway** that any agent, in any language, points its RPC URL and proxy at;
- a TypeScript **SDK** that also pseudonymizes wallet addresses in LLM prompts;
- an **ENSv2 name per agent** whose `privacy.manifest` *is* the policy the gateway enforces, with signed egress reports written by a key that can write nothing else.

One core, two hosts: `extension/` and `packages/` share `@canary/core`.

## Status

| Part | State |
|---|---|
| Enforcement extension ([`extension/`](extension/)) | Working. End-to-end test 32/32 against a leaky fixture dapp, including declared vs observed from the dapp's ENSv2 records. |
| Live over Tor | The earlier spike ran on the unmodified app.ens.domains: 8/8 of its RPC batches to its own keyed provider were answered via anon-rpc instead (1.3–2.8 s each). |
| Dapp scanner ([`scanner/`](scanner/)) | Working: Playwright + mitmproxy + a fake wallet with a synthetic canary address, every encoding, runs with and without Canary. On the live LeakyDash over tor-js (our own gateways), third parties receiving the address went 2 → 0 with Canary and RPC coverage 0% → 100% ([`test-artifacts/scans/`](test-artifacts/scans/)). On five mainnet dapps (ENS, Uniswap, Aave, revoke.cash, Snapshot): 12 → 0, coverage 100% on four and 15% on Aave, whose own RPC proxy Canary doesn't recognize ([`RESULTS.md`](test-artifacts/scans/RESULTS.md)). |
| Demo dapp ([`leakydash/`](leakydash/)) | Live at https://canary-leakydash.vercel.app: provider, tracker, first-party backend, a per-visitor log viewer, and a native anon-rpc mode. |
| ENSv2 manifest + signed verdicts for dapps | **Live on Sepolia:** `leakydash.eth` (own Permissioned Resolver, `url` + `privacy.manifest`), `canary.eth` with a subname registry, and `verifier.canary.eth`, whose signed verdict from a scan of the live site is published under a one-key EAC grant. Revocation is visible to readers ([`packages/ens`](packages/ens/README.md#live-on-sepolia)). |
| **Agents:** `@canary/core` ([`packages/core`](packages/core/)) | Done; the extension imports it. 11/11 tests (+ the extension's 32/32). |
| **Agents:** gateway ([`packages/gateway`](packages/gateway/)) | Working: anon-rpc in headless Chrome, JSON-RPC endpoint, HTTP(S) proxy, opt-in MITM CA, policy from ENS with live updates, signed reports, timing jitter, crash recovery. 39/39 tests on EF's passthrough worker. **Not yet run live over tor-js.** |
| **Agents:** ENSv2 ([`packages/ens`](packages/ens/)) | Working against mock ENSv2 contracts: manifest loader, one-key report role (both documented delegation APIs), signed `privacy.report`, revocation detection, `canary-ens` CLI. 8/8 tests on mock ENSv2 contracts. The dapp records are live on Sepolia (above); agents' names aren't yet. |
| **Agents:** SDK ([`packages/agent`](packages/agent/)) | viem transport, ethers provider, `fetch`, LLM pseudonymizer, `wrapTools`, embedded mode. 13/13 tests. |
| **Agents:** examples | [`viem-agent`](examples/viem-agent/) (with `--leaky` before/after) and [`python-agent`](examples/python-agent/) (zero code changes, tested). |
| **Agents:** AgentKit / Eliza / LangChain adapters | Not started |
| tor-js patches ([`tor-js-patches/`](tor-js-patches/)) | For upstream: HTTP keep-alive per isolation key (warm reads p50 827 → 234 ms) and a gateway liveness check (1 failed read per dead gateway instead of 2, recovery 10.5–14 s instead of 17–31 s). Measured in [test-repo.md §14](test-repo.md). |

## Repo layout

| Path | What |
|---|---|
| [`extension/`](extension/) | The Canary MV3 extension: shim, policy, popup, e2e test |
| [`scanner/`](scanner/) | The dapp scanner: who received a synthetic canary address, with and without Canary |
| [`leakydash/`](leakydash/) | The demo dapp, runnable locally (`npm start`) or on Vercel |
| [`idea.md`](idea.md) | Team working doc: product, architecture, coverage model, build plan, risks, tracks |
| [`agent-sdk.md`](agent-sdk.md) | Blueprint: Canary for autonomous agents (gateway + SDK + ENSv2 agent names) |
| [`test-repo.md`](test-repo.md) | Test log of the anon-rpc repo and of the Canary spike, with numbers |
| [`test-artifacts/`](test-artifacts/) | Raw logs and benchmark output referenced by test-repo.md |
| [`gateway/`](gateway/) | Dockerfile for our own tor-js gateway (EF's `tor-js-gateway`, pinned commit) |
| [`tor-js-patches/`](tor-js-patches/) | Patches to tor-js we want upstream (keep-alive, gateway liveness), with measurements |
| [`canary-spike/`](canary-spike/) | The first proof of concept (superseded by `extension/`) |
| [`packages/core/`](packages/core/) | `@canary/core`: JSON-RPC classifier, address matching, coverage categories, privacy manifest. Platform-neutral; shared with the extension |
| [`packages/gateway/`](packages/gateway/) | `@canary/gateway`: anon-rpc in headless Chrome, JSON-RPC endpoint, HTTP(S) proxy, MITM CA, ledger, signed reports, ENS binding, `canary-gateway` CLI |
| [`packages/ens/`](packages/ens/) | `@canary/ens`: ENSv2 manifest/report records, one-key role, revocation checks, `canary-ens` CLI |
| [`packages/agent/`](packages/agent/) | `@canary/agent`: in-process SDK for TypeScript agents |
| [`examples/viem-agent/`](examples/viem-agent/) | A small Sepolia agent (viem + one LLM) wired through Canary, with a leaky mode for before/after |
| [`examples/python-agent/`](examples/python-agent/) | The same idea in Python with no SDK: only `RPC_URL` and `HTTPS_PROXY` |

## Quick start

```sh
cd extension
npm install
npm run build        # → extension/dist, configured for tor-js
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist`. Use a separate Chrome profile: it runs on every site. The first boot of the Tor worker takes about 13 s.

Tests: `CHROME_BIN=/path/to/chromium npm test` (needs full Chromium or Chrome for Testing; see [`extension/README.md`](extension/README.md)).

## Canary for agents (quick start)

```sh
npm install && npm run build     # at the repo root: packages/core, ens, gateway, agent
npm test                         # 61 tests; needs Chrome (CHROME_BIN, else your installed Chrome); python3 optional
cd examples/viem-agent
npm run gateway                  # terminal 1: tor-js boots in ~13 s
WALLET=0x… npm run agent         # terminal 2 (npm run agent:leaky for the same agent without Canary)
```

- **Any language:** point the agent's RPC URL at `http://127.0.0.1:18545/<chainId>`; its chain reads go through anon-rpc. `HTTPS_PROXY=http://127.0.0.1:18080` adds per-host rules. Without the local CA, HTTPS can only go directly or be blocked; with it (`canary-gateway ca`, then `"mitm": true`), `anon` hosts go through anon-rpc too.
- **TypeScript:** `createCanary()` from `@canary/agent` gives a viem transport, an ethers provider, a policy-checked `fetch`, and `llmFetch`, which replaces wallet addresses with `WALLET_1` before a prompt leaves.
- **Policy:** the manifest, from a local file (`examples/viem-agent/manifest.json`) or from the agent's ENSv2 name (`npm run gateway:ens`). Undeclared hosts are blocked by default.
- **Reference:** each package has a README with its API and config; the design and its rationale are in [agent-sdk.md](agent-sdk.md).

## CROPS

- **C (censorship resistance):** Canary depends on a tor-js gateway and on the read endpoints in `extension/config/live.json`. Gateways are a list: tor-js spreads clients across them and fails over on its own, and anyone can run one from [`gateway/`](gateway/) (one Docker container, one UDP port). If all of them or the read endpoint go away, Canary fails closed and the popup says so; a per-site opt-in allows direct requests instead.
- **O (open source):** MIT. Everything builds from this repo with `npm install && npm run build`.
- **P (privacy):** the gateway learns your IP, that you use Tor, and traffic volume and timing; not destinations or contents (circuits are built and encrypted in the browser). The read endpoint learns which addresses are queried, but not your IP or which dapp you're using. We never run both a gateway and a read endpoint, so no single operator can match the two by timing. Batching never mixes calls about different addresses. Forwarded non-standard calls reveal the dapp to its provider, not your IP. The dapp itself still sees your address and IP. Canary has no analytics or telemetry.
- **S (security):** Canary never holds keys or signs anything. The anon-rpc worker is hash-pinned on chain and runs in a null-origin sandbox with none of the extension's permissions. Read endpoints could lie about responses; proof verification is future work.
- **Agents:**
  - The gateway never touches the agent's wallet keys and refuses node-side signing.
  - Its report key can write one text record (`privacy.report`) and nothing else.
  - The MITM CA is opt-in, local, and trusted only in the agent's runtime; its key never leaves `~/.canary/ca`.
  - Prompts reach LLM providers with wallet addresses pseudonymized.
  - Reports published on chain are coarse (whole days, bucketed counts), because detailed ones would reveal the agent's activity pattern.

## License

MIT. `extension/test/fixtures/passthrough-worker.js` (and its copy in `packages/gateway/test/fixtures/`) is the reference worker from [ethereum/anon-rpc](https://github.com/ethereum/anon-rpc) (MIT, © 2026 Ethereum Foundation), used only by the tests.
