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

## Architecture

```mermaid
flowchart LR
  subgraph browser["Browser with the Canary extension"]
    page["dapp page"] -->|"fetch, XHR, WebSocket, beacons"| shim["shim, in the page"]
    shim -->|"third party + your address"| blocked["blocked"]
    shim -->|"JSON-RPC"| sw["service worker: policy, coverage"]
    sw --> sandbox["offscreen document, null-origin sandbox: anon-rpc worker (tor-js)"]
  end
  subgraph agenthost["Agent host"]
    agent["agent, any language"] -->|"RPC_URL, HTTPS_PROXY"| gw["canary-gateway: policy, ledger, reports"]
    gw --> chrome["headless Chrome: anon-rpc worker (tor-js)"]
  end
  sandbox -->|"WebRTC (KPS)"| kps["tor-js gateway: EF's, or ours from gateway/"]
  chrome -->|"WebRTC (KPS)"| kps
  kps --> tor["Tor: guard, middle, exit"] --> read["read endpoint, e.g. publicnode"]
  subgraph ens["ENSv2 on Sepolia"]
    dapp["leakydash.eth: url, privacy.manifest, privacy.verdict.canary"]
    agentname["trader-01.agents.canary.eth: privacy.manifest is the policy, privacy.report"]
  end
  sw -. "read over anon-rpc" .-> dapp
  gw -. "policy in, signed report out" .-> agentname
  scanner["scanner: Playwright, mitmproxy, synthetic address"] -. "baseline scan, verdict signed by verifier.canary.eth" .-> dapp
```

- **One anon path for both hosts.** The extension and the gateway run the same anon-rpc worker (tor-js, hash-pinned on chain). It builds Tor circuits in the browser and reaches relays through a tor-js gateway over WebRTC, so the read endpoint sees a Tor exit, not you.
- **Who learns what:** the tor-js gateway sees your IP but not destinations or contents; the read endpoint sees which addresses are queried but not your IP or which dapp you use; the dapp itself still sees your address and IP.
- **Shared core:** `@canary/core` (JSON-RPC classifier, address matching, coverage categories, manifest schema) is used by `extension/` and `packages/`.
- **Declared vs observed:** a name's `privacy.manifest` says who should receive your address. The scanner measures who does, and the verifier signs what it found into `privacy.verdict.canary` under a grant for that one key. For an agent, the manifest is enforced: the gateway blocks what it doesn't declare.

## Status

| Part | State |
|---|---|
| Enforcement extension ([`extension/`](extension/)) | Working. End-to-end test 41/41 against a leaky fixture dapp, including declared vs observed from the dapp's ENSv2 records. |
| Live over Tor | The earlier spike ran on the unmodified app.ens.domains: 8/8 of its RPC batches to its own keyed provider were answered via anon-rpc instead (1.3–2.8 s each). |
| Dapp scanner ([`scanner/`](scanner/)) | Working: Playwright + mitmproxy + a fake wallet with a synthetic canary address, every encoding, runs with and without Canary. On the live LeakyDash over tor-js (our own gateways), third parties receiving the address went 2 → 0 with Canary and RPC coverage 0% → 100% ([`test-artifacts/scans/`](test-artifacts/scans/)). On five mainnet dapps (ENS, Uniswap, Aave, revoke.cash, Snapshot): 12 → 0, coverage 100% on four and 15% on Aave, whose own RPC proxy Canary doesn't recognize ([`RESULTS.md`](test-artifacts/scans/RESULTS.md)). |
| Demo dapp ([`leakydash/`](leakydash/)) | Live at https://canary-leakydash.vercel.app: provider, tracker, first-party backend, a per-visitor log viewer, and a native anon-rpc mode. |
| ENSv2 manifest + signed verdicts for dapps | **Live on Sepolia:** `leakydash.eth` (own Permissioned Resolver, `url` + `privacy.manifest`), `canary.eth` with a subname registry, and `verifier.canary.eth`, whose signed verdict from a scan of the live site is published under a one-key EAC grant. Revocation is visible to readers ([`packages/ens`](packages/ens/README.md#live-on-sepolia)). |
| **Agents:** `@canary/core` ([`packages/core`](packages/core/)) | Done; the extension imports it. 11/11 tests (+ the extension's 41/41). |
| **Agents:** gateway ([`packages/gateway`](packages/gateway/)) | Working: anon-rpc in headless Chrome, JSON-RPC endpoint, HTTP(S) proxy, opt-in MITM CA, policy from ENS with live updates, signed reports, timing jitter, crash recovery. Reads re-sent on a fresh Tor circuit when one stalls (as in the extension). 41/41 tests on EF's passthrough worker. **Live over tor-js on our gateways: 24/24 checks** (`scripts/live-e2e.mjs`, [test-repo.md §19](test-repo.md)): every read through the RPC endpoint and the SDK (viem, ethers) matched a direct read exactly at a pinned block, the exit was a Tor exit, the LLM saw `WALLET_1`, undeclared hosts got 403, the Python agent worked, and both ENSv2 names read correctly over anon-rpc. |
| **Agents:** ENSv2 ([`packages/ens`](packages/ens/)) | Working against mock ENSv2 contracts: manifest loader, one-key report role (both documented delegation APIs), signed `privacy.report`, revocation detection, `canary-ens` CLI. 8/8 tests on mock ENSv2 contracts. **Live on Sepolia:** `agents.canary.eth` (a subname registry) and `trader-01.agents.canary.eth`; the gateway loads its policy from that name over anon-rpc and publishes the signed `privacy.report`, and revoking the report key's role shows ([`packages/ens`](packages/ens/README.md#live-on-sepolia)). |
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

**1. A tor-js gateway.** Browsers can't open the raw TCP Tor needs, so tor-js reaches Tor through a gateway. EF's demo gateway stopped completing boots on 6 Nov 2026, so run your own (one Docker container, ~10 min to build the first time; details in [`gateway/README.md`](gateway/README.md)):

```sh
docker build -t canary-gateway gateway/
docker run -d --name canary-gateway --restart unless-stopped -p 12298:12298/udp \
  -e ADVERTISE=127.0.0.1 -v canary-gateway:/data canary-gateway
docker logs canary-gateway            # prints this gateway's address: 127.0.0.1:12298:<certhash>
npm run gateways -- <that address>    # at the repo root: writes it into every default config (--with-ef adds EF's as a fallback)
```

**2. The extension.**

```sh
cd extension
npm install
npm run build        # → extension/dist, using the gateways from step 1
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist`. Use a separate Chrome profile: it runs on every site. The first boot of the Tor worker takes about 13 s.

Tests: `CHROME_BIN=/path/to/chromium npm test` (needs full Chromium or Chrome for Testing; see [`extension/README.md`](extension/README.md)).

## Canary for agents (quick start)

```sh
npm install && npm run build     # at the repo root: packages/core, ens, gateway, agent
npm test                         # 73 tests; needs Chrome (CHROME_BIN, else your installed Chrome); python3 optional
cd examples/viem-agent
npm run gateway                  # terminal 1 (after Quick start step 1): tor-js boots in ~8–13 s
WALLET=0x… npm run agent         # terminal 2 (npm run agent:leaky for the same agent without Canary)
```

- **Any language:** point the agent's RPC URL at `http://127.0.0.1:18545/<chainId>`; its chain reads go through anon-rpc. `HTTPS_PROXY=http://127.0.0.1:18080` adds per-host rules. Without the local CA, HTTPS can only go directly or be blocked; with it (`canary-gateway ca`, then `"mitm": true`), `anon` hosts go through anon-rpc too.
- **TypeScript:** `createCanary()` from `@canary/agent` gives a viem transport, an ethers provider, a policy-checked `fetch`, and `llmFetch`, which replaces wallet addresses with `WALLET_1` before a prompt leaves.
- **Policy:** the manifest, from a local file (`examples/viem-agent/manifest.json`) or from the agent's ENSv2 name (`npm run gateway:ens`). Undeclared hosts are blocked by default.
- **Reference:** each package has a README with its API and config; the design and its rationale are in [agent-sdk.md](agent-sdk.md).

## CROPS

- **C (censorship resistance):** Canary depends on a tor-js gateway and on the read endpoints in `extension/config/live.json`. Gateways are a list: tor-js spreads clients across them and fails over on its own, and anyone can run one from [`gateway/`](gateway/) (one Docker container, one UDP port). That matters: EF's demo gateway, the default, stopped completing boots on 6 Nov, and our live runs since then went through three of our own (`extension/config/local-gateway.json`). If every gateway or the read endpoint goes away, Canary fails closed and the popup says so; a per-site opt-in allows direct requests instead. Manifests, verdicts and agent reports are ENS records, readable over anon-rpc through any Ethereum RPC; if our verifier stops, its verdict expires and the popup shows it as expired.
- **O (open source):** MIT. Everything builds from this repo with `npm install && npm run build`, and the scripts behind the measurements are here too (`scanner/`, `test-artifacts/latency/`).
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
