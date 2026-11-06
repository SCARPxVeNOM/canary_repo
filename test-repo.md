# anon-rpc repo: test log

Tests run against the local clone of `ethereum/anon-rpc`, to check the assumptions in [idea.md](idea.md) before hacking starts.

- **Date:** 5 Nov 2026 (IST)
- **Repo:** `anon-rpc/` at commit `c8980fb` (Merge PR #15, spec **0.4.0**)
- **Machine:** macOS (Darwin 27.0.0, arm64), Node v24.22.1, npm 11.19.1, Docker 29.9.2
- **Browser used by the tests:** Playwright Chromium 149 (headless shell, plus full Chromium for extension tests)

---

## Summary

| Area | Result |
|---|---|
| Unit tests (harness-core, browser-harness, node-harness, specifier) | ✅ pass |
| Browser-extension harness e2e (MV3 + offscreen) | ✅ 18/18 |
| Demo-extension e2e | ✅ pass |
| Root KPS e2e (real WebRTC) | ❌ on macOS (missing native binding) · ✅ in Docker (Linux) |
| Firefox e2e | ⏭ skipped (no `FIREFOX_BIN` / `GECKODRIVER`) |
| Specifier contract + site smoke tests | ⏭ skipped (Foundry not installed) |
| Live benchmark, mainnet specifiers | ✅ passthrough, tor-js, Nym · ❌ Nox (its specifier is on Sepolia) |
| Live benchmark, Sepolia specifier | ✅ Nox |
| Which public RPCs accept Tor/Nym traffic | see section 5 |

---

## 1. Setup

```sh
cd anon-rpc/impl
npm ci
```

npm 11 skips install scripts unless approved. Two are needed:

```sh
npm install-scripts approve esbuild node-datachannel   # writes an "allowScripts" block into impl/package.json
npm rebuild esbuild node-datachannel
npx playwright install chromium
npm run build
```

- `esbuild`: builds every workspace.
- `node-datachannel`: WebRTC for the KPS tests.
- Side effect: `impl/package.json` gains `"allowScripts": {...}`. Run `git checkout impl/package.json` to undo.

Build output: all workspaces built; the site build produced `dist/` (demo, spec, networks, wallets, adopters pages, plus `anon-rpc-demo-extension.zip`, 78 KB). One harmless Vite warning about `@kpstreams/webrtc-client` being both dynamically and statically imported.

---

## 2. Workspace tests: `npm test` (exit 0)

### harness-core / browser-harness
- ✓ spec-version check: package 0.4.0 ≥ spec 0.4.0
- ✓ plain-value rules (§9.4): non-plain entries, cycles and other values refused with `TypeError` naming the path

### browser-extension-harness (real Chromium, MV3)
- ✓ extension loaded, service worker running
- ✓ `eth_blockNumber` answered through the extension's worker
- ✓ §4 specifier read + hash-verified bundle fetch happened in the offscreen document
- ✓ worker requests carry `Origin: null` (opaque origin)
- ✓ offscreen document not enumerable by Playwright (expected)
- ✓ a second call reused the booted worker: no re-read, no re-fetch, no re-verify
- ✓ offscreen document fetched a bundle from a no-CORS endpoint (it has host permissions)
- ✓ worker code cannot reach the extension API (`typeof chrome === "undefined"`)
- ✓ `anonOptions` crossed the service worker → offscreen hop intact (§9.1, §9.3)
- ✓ a `ReadableStream` request body reached the worker as a stream
- ✓ response streamed (first chunk 2 ms, last 813 ms)
- ✓ worker's own origin is `"null"`, not `chrome-extension://…`
- ✓ worker cannot reach the same no-CORS endpoint (no host permissions)
- ✓ a failed boot is evicted from the cache, so a retry is real
- ✓ §13 logs reach the service worker intact
- ✓ missing packaged assets reported by name, with the fix
- ✓ cross-origin `iframeUrl` refused (§6)
- ✓ no console errors (no CSP violations)
- ⏭ Firefox e2e skipped: set `FIREFOX_BIN` and `GECKODRIVER`

### node-harness (QuickJS-in-WASM isolate)
- ✓ worker booted: specifier read, bundle keccak-verified, running in a QuickJS isolate
- ✓ `eth_blockNumber` answered through the isolated worker
- ✓ unmodified reference bundle ran (`fetch` as a grant)
- ✓ five concurrent calls each got their own response (§8)
- ✓ fetch after `close()` rejects
- ✓ bundle rejected when keccak256 doesn't match `workerHash` (§4)
- ✓ realm escape closed; no `process`, `require` or module loader
- ✓ raw host bridge unreachable; 80 globals, all accounted for
- ✓ ungranted optional capability absent; unimplemented required one throws "unsupported" (§12)
- ✓ granted fetch refuses loopback, RFC1918 and `file://`
- ✓ bridged socket carried a real connection; address policy refused a non-allow-listed destination
- ✓ config and forwarded init entries arrived exactly (§9.4); non-plain values refused
- ✓ hostile guests contained: infinite loop (interrupted at 822 ms), deep recursion, heap exhaustion; host survived

### specifier
- ✓ env parsing (5 tests), github-resolver (10 tests: raw URLs, content-addressed storage, orphan branch, re-upload no-op)
- ⏭ contract/publish tests skipped: Foundry not installed

### demo-extension
- ✓ archive is a valid zip (9 entries, 76.6 KB), manifest shipping-clean
- ✓ extension loaded; fields prefilled (`https://ethereum-rpc.publicnode.com`)
- ✓ a bootstrap URL that never booted isn't persisted
- ✓ popup watched a balance through the worker
- ✓ §4 ran once: bundle fetched and hash-verified once
- ✓ **cold boot in 137 ms** (specifier read, bundle fetched, keccak256 verified)
- ✓ reopened popup resumed with no re-read, re-fetch or re-verify, and kept polling
- ✓ log survived the popup closing
- ✓ no console errors

### site
- ⏭ smoke test skipped: Foundry not installed

---

## 3. Root e2e: `npm run test:e2e` (real KPS over WebRTC)

### On macOS: ❌ fails before running

```
Error: Failed requiring possible native bindings: .../@infisical/quic/prebuild/quic-darwin-arm64.node, ...
```

- `@kpstreams/server@0.2.1` → `@infisical/quic@1.0.8`.
- The lockfile names `@infisical/quic-darwin-arm64@1.0.8`, but npm returns **404**: no macOS build is published.
- **The in-process KPS server can't run natively on a Mac. Use Docker or Linux.**

### In Docker (Linux arm64): ✅ all pass

```sh
docker run --rm -v "$PWD/anon-rpc:/src:ro" mcr.microsoft.com/playwright:v1.56.0-noble bash -lc '
  cp -r /src /w && cd /w/impl && rm -rf node_modules */node_modules &&
  npm ci && npm rebuild esbuild node-datachannel &&
  npx playwright install chromium && npm run build && npm run test:e2e'
```

- ✓ iframe sandbox is `allow-scripts` only (§6)
- ✓ `acceptLog` delivers a line logged before anyone listened; args cross as a list, level intact (§13.1)
- ✓ plain fetch passthrough body
- ✓ init config delivered (§7.1); absent config is `undefined`
- ✓ `anonOptions` forwarded to the worker (§9.1, §9.3)
- ✓ custom init entry forwarded, bytes intact; non-plain entry rejects with `TypeError`
- ✓ **kps-routed echo round-trips bytes**; worker sees `conn.remoteAddress` (§10.1)
- ✓ Request-object POST body honored; `ReadableStream` body crosses the boundary
- ✓ pre-aborted fetch rejects with `AbortError`; a fetch after an aborted one still works (§8)
- ✓ worker-persisted call counter; storage persists across reloads (IndexedDB, §11)
- ✓ minimal passthrough template serves fetch and adds no extra headers
- ✓ bundle resolved over a kps resolver; unrecognized entry ignored (§4.1–4.2)
- ✓ every §4.2 failure mode attempted in order; boot rejects with diagnostics when all resolvers fail
- ✓ gzip-encoded bundle advertised, decoded, verified (§4.2)
- ✓ `signalFailed` rejects `ready` with the reason; a late `signalReady` is ignored (§7)

---

## 4. Live latency benchmark: `impl/site/bench/run.mjs`

Boots each worker in `adopters.json5` from its **real on-chain specifier**, then samples `eth_getBalance(0x00000000219ab540356cBB839Cbe05303d7705Fa)`. Arms are interleaved; `direct` is the control.

### 4a. Mainnet RPC (n = 8)

```sh
cd anon-rpc/impl/site
node bench/run.mjs --rpc https://ethereum-rpc.publicnode.com --n 8 --boot-timeout 120000
```

| arm | bootstrap | p50 | p90 | p99 | discarded |
|---|---|---|---|---|---|
| direct | — | 220 ms | 294 ms | 294 ms | 0 |
| passthrough | 1517 ms | 399 ms | 522 ms | 522 ms | 0 |
| **tor-js** | **13022 ms** | **1531 ms** | 1995 ms | 1995 ms | 0 |
| nym | 65809 ms | 824 ms | 6314 ms | 6314 ms | 0 |
| nox | did not boot: `short bytes32 return` | — | — | — | — |

Overhead vs direct (p50): passthrough +179 ms (1.8×), tor-js +1310 ms (6.9×), nym +604 ms (3.7×).

- Nox fails because its specifier lives on **Sepolia** (`chainId: 11155111` in adopters.json5), and the bench reads specifiers from the same RPC it samples.
- Nym kept logging `tunnel setup failed … one (or more) of mixing layers does not have any valid nodes available` while it booted.
- publicnode accepted all Tor and Nym requests (0 discarded).

### 4b. Sepolia RPC (n = 5)

```sh
node bench/run.mjs --rpc https://ethereum-sepolia-rpc.publicnode.com --n 5 --boot-timeout 120000
```

| arm | bootstrap | p50 | p90 | discarded |
|---|---|---|---|---|
| direct | — | 235 ms | 349 ms | 0 |
| **nox** | **3738 ms** | **1242 ms** | 1590 ms | 0 |
| passthrough, tor-js, nym | did not boot (their specifiers are on mainnet) | — | — | — |

Nox overhead: +1008 ms (5.3×).

---

## 5. Which public RPC endpoints accept anonymized traffic

Custom driver over the repo's bench page: [test-artifacts/tor-endpoints.mjs](test-artifacts/tor-endpoints.mjs) (run from `anon-rpc/impl/site`). It boots tor-js and Nym once (specifiers read via mainnet publicnode), then sends 3 × `eth_getBalance` per endpoint per arm, with a 30 s timeout each. The same address is used on Sepolia (it only tests reachability).

| net | endpoint | direct | tor-js | nym |
|---|---|---|---|---|
| mainnet | ethereum-rpc.publicnode.com | 3/3 ~4726 ms | 3/3 ~9568 ms | 0/3 (timed out) |
| mainnet | eth.llamarpc.com | 0/3 (Failed to fetch) | 0/3 (HTTP 525) | 0/3 (timed out) |
| mainnet | cloudflare-eth.com | 0/3 (Internal error) | 0/3 (peer closed) | 0/3 (timed out) |
| mainnet | eth.drpc.org | 3/3 ~3836 ms | 3/3 ~9929 ms | 0/3 (timed out) |
| mainnet | 1rpc.io/eth | 3/3 ~395 ms | 3/3 ~825 ms | 0/3 (timed out) |
| mainnet | rpc.flashbots.net | 1/3 ~1168 ms | 1/3 ~1271 ms | 0/3 (timed out) |
| mainnet | eth.merkle.io | 0/3 (Failed to fetch) | 0/3 (HTTP 429) | 0/3 (timed out) |
| sepolia | **ethereum-sepolia-rpc.publicnode.com** | 3/3 ~220 ms | **3/3 ~952 ms** | 0/3 (timed out) |
| sepolia | sepolia.drpc.org | 0/3 (HTTP 400) | 0/3 (HTTP 400) | 0/3 (timed out) |
| sepolia | **1rpc.io/sepolia** | 2/3 ~523 ms | **3/3 ~1621 ms** | 0/3 (timed out) |
| sepolia | rpc.sepolia.org | 0/3 (timeout) | 0/3 (HTTP 522) | 0/3 (timed out) |
| sepolia | sepolia.gateway.tenderly.co | 3/3 ~879 ms | **0/3 (HTTP 403)** | 0/3 (timed out) |

How to read it:
- "Failed to fetch" on `direct` from a browser page usually means CORS or the endpoint is down, not a Tor issue.
- **Tenderly Sepolia works directly but returns 403 over Tor: it refuses Tor exits.**
- Nym booted but timed out on every request, which matches the "no valid nodes in mixing layers" warnings: the Nym network was degraded at test time.
- Latencies in this sweep are noisier than in section 4 (mainnet publicnode direct ~4.7 s here vs 220 ms there), so treat them as reachability, not as benchmarks.

---

## 6. What this means for Canary (idea.md)

1. **tor-js cold boot is about 13 s.** Boot it when the extension starts and keep it warm in the offscreen document (the harness's reuse cache is tested and works), and show a "warming up" state in the popup.
2. **About 1–1.5 s per read over tor-js** (Sepolia publicnode p50 ~952 ms). A wagmi dashboard making ~20 reads needs batching or caching (`eth_chainId`, `eth_getCode`).
3. **Read endpoint for LeakyDash (Sepolia):** `ethereum-sepolia-rpc.publicnode.com`, with `1rpc.io/sepolia` as fallback. **Don't use Tenderly** (403 over Tor). Re-test on demo day.
4. **Demo network: tor-js only.** Nym was down at test time; Nox works but its specifier is on Sepolia (a different bootstrap chain).
5. **Passthrough runs through the browser's own fetch** (1.8× overhead, CORS preflight per request), so mitmproxy will see it. Don't count passthrough reads as protected in the scanner.
6. **`isolationKey` gets through every harness hop** (tested in the extension and the root e2e). Whether tor-js acts on it is up to the worker; ask EF.
7. **Mac teammates need Docker** for anything that runs the in-process KPS server.
8. The extension harness's guarantees Canary relies on are tested and pass: worker at a null origin, no `chrome.*` access, no host permissions, warm reuse, streamed bodies.

---

## 7. Not tested

- Firefox extension e2e (needs Firefox 140+ and geckodriver).
- `WorkerSpecifier.sol` contract and publish flow, and the site smoke test (need Foundry).
- Bandwidth (the bench notes it needs byte counters in the KPS gateway).
- Whether tor-js separates circuits per `isolationKey` (tor-js source isn't in this repo).
- Manual checks in a real Chrome profile (done in round 2, §9–10). All round-1 browser testing used Playwright's Chromium.

## Artifacts

All in [test-artifacts/](test-artifacts/):

- `test.log`: full `npm test` output
- `docker-e2e.log`: root KPS e2e run in Docker
- `bench.json`, `bench.md`: mainnet bench raw samples and summary
- `bench-sepolia.md`: Sepolia bench summary
- `tor-endpoints.mjs`, `tor-endpoints.log`: endpoint sweep script and its output
- `canary-spike-e2e.log`: Canary spike offline e2e output (round 2)

---

# Round 2: Canary-specific checks (5 Nov 2026, evening)

Round 1 tested what the repo does on its own. This round tests the assumption Canary depends on: **can an extension answer a dapp's own RPC reads through anon-rpc?**

## 8. Repo and adopters status

- Upstream `main` is still `c8980fb` (spec 0.4.0). The clone is current.
- **adopters.json5 now lists two shipping apps:** Kiwi News (added 14 Oct) and Privacy Pools (added 15 Oct). Both use tor-js. Both are **opt-in toggles built into the app itself** (off by default). There are still no wallets.
  - ⚠️ idea.md §1.3 ("the adopters page listed no shipping wallet or app") is out of date. Suggested wording: *"Two apps (Kiwi News, Privacy Pools) offer anon-rpc as an opt-in setting. No wallet ships it, and nothing routes a dapp's traffic by default or works on dapps that didn't integrate it."*

## 9. Real Chrome, hosted demo

`https://ethereum.github.io/anon-rpc/demo/?worker=tor-js`, mainnet publicnode, default watch address:

- ✅ Balance read over Tor: **1,410 ms** for the request.
- Boot log: tor-js "fast bootstrap" downloads the Tor consensus (`bootstrap.zip.zst`, **1.46 MB compressed → 8.0 MB**, 9,594 microdescriptors) through the gateway. **11.4 s of the boot is this download.** Consistent with the 13 s cold boot in §4a.
- Loading an unpacked extension can't be scripted from a page: `chrome://extensions` isn't reachable from browser automation. A person has to click "Load unpacked".

## 10. Canary spike: interception + substitution

Code: `canary-spike/` (source + `dist-live/` unpacked build). Built on `@anon-rpc/browser-extension-harness`.

```
page JS (viem http transport) ─fetch─► MAIN-world shim (document_start, all frames)
   JSON-RPC POST? ──yes──► postMessage ─► ISOLATED bridge ─► service worker
                                                              │ standard read method?
                                     substitute: worker.fetch(READ_ENDPOINT[chainId])   → "protected"
                                     other method: worker.fetch(original URL)           → "protected-ip-only"
                                     anon path down: JSON-RPC error, never direct       → "failed-closed"
```

### Offline e2e (`canary-spike/test/e2e-offline.mjs`): ✅ 8/8

Local stub chain + the repo's **passthrough** worker (hash-verified the same way as on chain), a viem dapp whose `http()` transport points at a logging "provider", and a logging "read endpoint". Run in Chrome for Testing 153, headless.

| | Baseline (no extension) | With Canary |
|---|---|---|
| Dapp's provider received | `eth_chainId, eth_blockNumber, eth_getBalance, alchemy_getTokenBalances, eth_blockNumber, eth_getBalance`, all with `Origin: <page>` | `eth_chainId` (Canary's one-time chain probe), `alchemy_getTokenBalances` (forwarded), both `Origin: null` |
| Read endpoint received | nothing | `eth_chainId, eth_blockNumber, eth_getBalance` + a batch of 2, all `Origin: null` |
| Dapp result | provider's values | read endpoint's values; dapp works normally |

- ✓ the provider saw **no** read methods
- ✓ nothing left with the page's Origin; everything left from the worker's null origin
- ✓ viem batch requests (`http(url, {batch:true})`) substituted as a batch
- ✓ non-standard method (`alchemy_*`) forwarded to the original URL, labeled IP-only
- Overhead of shim → service worker → offscreen → worker hop: ~4–7 ms per call once warm (first call 24–74 ms, two runs). Tor latency dominates everything else.

### What the spike surfaced (feed into the build)

1. **Chain learning is a weak spot.** Asking the dapp's provider for `eth_chainId` over the anon path tells the provider "someone uses this dapp" (not who). It also breaks if the provider refuses Tor exits (Tenderly returned 403 in §5): Canary then fails closed and the dapp breaks. **Fix:** take the chain from the connected wallet (`eth_chainId` via EIP-1193/6963) or a known-host table, and probe the provider only as a last resort.
2. **viem's `http()` transport is caught** because it calls `fetch` with a string body at request time. Not yet covered: XHR (some ethers v5 setups), WebSocket transports, `sendBeacon`, `Request` objects with stream bodies.
3. **The page ↔ bridge channel is `window.postMessage`**, which the page can read and spoof. That's fine for a spike (the page only gets its own answers), but switch to a `MessageChannel` handed over at `document_start` before shipping.
4. **No harness changes were needed.** `worker.fetch` from the service worker worked for page-originated requests as-is, which answers mentor question 3 in idea.md §12 in practice.

### Live run in real Chrome over tor-js: ✅

`canary-spike/dist-live` loaded unpacked in your Chrome (tor-js, demo gateway, read endpoint = `ethereum-rpc.publicnode.com`). Driven through browser automation in that profile.

**Controlled test on example.com** (page calls `fetch("https://eth.drpc.org", …)` as a dapp would):

| Call | Label | Time |
|---|---|---|
| `eth_blockNumber` (first; includes the chain probe) | protected | 2,295 ms |
| `eth_getBalance` ×6 | protected | 1,000–1,443 ms (median ~1.1 s) |
| batch `[eth_blockNumber, eth_chainId]` | protected (answered as a batch) | — |
| `debug_traceTransaction` | protected-ip-only (forwarded to drpc over Tor) | — |

- ✓ The tab's network log shows **zero** requests to drpc. Everything left via the worker (WebRTC → Tor).

**Real dapp: app.ens.domains** (unmodified production app, wagmi/viem):

- The page renders correctly (owner, registration and expiry dates, records) with Canary on.
- During navigation to `vitalik.eth`, the app sent **8 JSON-RPC requests**, all Multicall3 `eth_call` batches, to its **own keyed dRPC endpoint** (`lb.drpc.live/ethereum/<key>`). **8/8 were substituted** (100% of RPC reads on this flow), at 1,251–2,789 ms each.
- Not inspected (non-RPC, left directly): `api.bigname.sh` (indexer REST: name records), `edge.ens.domains/flags`, `pulse.walletconnect.org`, `api.web3modal.org`, `api-iam.intercom.io`. With no wallet connected, none of these carried an address, but this is the "backend/indexer" channel Canary can only label, not substitute.

### Conclusions for the build

- **The core EF claim is demonstrable today on a real dapp**: "the dapp's own keyed RPC provider saw none of your reads", with coverage measured.
- Real dapps lean on **indexer/REST APIs** as much as on RPC. Report them in coverage as their own category ("backend/indexer"); this matches EF's "how much of the app's traffic" criterion.
- ~1–3 s per batched read is usable for a profile/dashboard page. Keep the worker warm.

---

# Round 3: Canary for agents (6 Nov 2026)

Tests of `packages/` (agent-sdk.md §0) and of the extension after moving it onto `@canary/core`.

- **Machine:** Linux container, Node v22.23.4, Google Chrome for Testing 153.0.8010.12 (headless), Python 3.13.18.
- **Packages:** playwright-core 1.64.1 (drives Chrome), viem 2.57.16, ganache 7.9.2 + solc 0.8.38 (local chain and mock ENSv2 contracts).
- **anon-rpc:** `@anon-rpc/browser-harness` 0.4.0 from npm, with EF's passthrough reference worker, hash-verified exactly as on chain. `@anon-rpc/node-harness` is not on npm (404).

## 11. Results

| Suite | Result | Covers |
|---|---|---|
| `@canary/core` | ✅ 5/5 | classifier, address encodings, manifest validation and host rules |
| `@canary/ens` | ✅ 4/4 | manifest load; one-key report role with **both** documented delegation APIs; signed report; revocation via simulated `setText` and `EACRolesChanged`; tampering, forged reporter, policy drift |
| `@canary/gateway` | ✅ 39/39 | bridge (16 MB streamed in 64 frames, aborts, 10 concurrent calls); Chrome killed mid-request (fails closed, one relaunch); boot failure (recovers); JSON-RPC routing, per-wallet batch split, fail closed; proxy and CONNECT rules; MITM CA; reports; jitter; ENS policy with live updates and publishing over anon-rpc; Python agent |
| `@canary/agent` | ✅ 13/13 | viem and ethers through the gateway; fetch policy; LLM round trip (provider sees `WALLET_1`, agent gets the address back); `wrapTools`; events; report; embedded mode |
| `extension/` e2e | ✅ 24/24 | unchanged checks, now on `@canary/core` |

## 12. Findings

1. **Chrome uses the environment's proxy.** In a sandbox that sets `HTTPS_PROXY`, the anon backend's HTTPS went to that proxy. Pass `--no-proxy-server` there (the fixtures do; the extension e2e already did).
2. **The passthrough worker is the page's own `fetch`,** so CORS applies: non-RPC hosts need preflight answers in tests. tor-js doesn't use the browser's fetch for the exit request; recheck this live.
3. **Shutdown with open CONNECT tunnels hung:** `server.close()` waits for tunnel sockets that Node's HTTP server doesn't track. Fixed by ending tunnels before closing. The gateway would otherwise hang on stop.
4. **The ENSv2 docs show two delegation APIs** (`authorizeTextRoles` and `grantSetterRoles`/`revokeRoles`). Both are supported and tested against mocks; which one Sepolia runs is a mentor question (agent-sdk.md §10).
5. **The passthrough worker hands over a large body in one piece;** the bridge re-frames it (≤256 KB) so one big `eth_getLogs` doesn't become one giant WebSocket message.

## 13. Not tested yet

- The gateway over **tor-js** (this container can't reach EF's KPS gateway). First thing to run: `examples/viem-agent` with `npm run gateway`.
- **ENS on Sepolia** (live Permissioned Resolver, Universal Resolver address, which delegation API).
- Windows and macOS runs of `npm test` (the scripts avoid Unix-only syntax; the tests find Chrome via `CHROME_BIN` or the installed Chrome).

---

## 14. Latency: where it goes and what we changed (6 Nov)

Scripts and raw results: [test-artifacts/latency/](test-artifacts/latency/). All runs use the real tor-js worker from its on-chain specifier (`0x700dA319…`, bundle = `tor-js@0.4.4/dist/anon-rpc-worker.js`, keccak matches `workerHash`).

### Why a read costs ~1 s

- tor-js sends `Connection: close` on every request (`crates/tor-js-wasm/src/fetch.rs:382`): each read is a new Tor stream + TCP + TLS through three relays, about 3 circuit round trips. TLS sessions are resumed per isolation key.
- The WASM is not the bottleneck: the 5.08 MB Arti binary (embedded as base64 in a 6.87 MB bundle) compiles in 8 ms; loading a directory snapshot takes 0.7 s.
- EF's demo gateway is in Frankfurt (ipinfo), 125 ms RTT from this machine (Maharashtra, IN).

### Probes over the demo gateway (`drive.mjs all`)

| What | Result |
|---|---|
| Direct, no Tor | p50 171 ms |
| Warm read, one at a time | p50 1,446 ms (935–3,469) |
| 20 reads: sequential / parallel / **one JSON-RPC batch** / Multicall3 | 43–55 s / 3.5–6.4 s / **1.6–2.1 s** / 2.1–4.2 s |
| `isolationKey` | real: no key → exit A; key a → exit B, B again; key b → exit C |
| First read on a new key vs the next | p50 2,036 vs 1,152 ms |
| Racing one read on two circuits | p50 1,087 → 1,051 ms, p90 unchanged: not worth it |
| Read endpoints over Tor (p50) | drpc 1.8 s, blast 2.0, ankr 2.1, publicnode 2.2, 1rpc 3.7 (2/8 failed) |

Real dapps, no wallet (`traffic.mjs`): app.uniswap.org 24 RPC calls, **20 exact duplicates**, 12 `eth_chainId`/`net_version`; curve 10 calls, 2 duplicates + 3 static; app.ens.domains 8 calls, 7 of them Multicall3, 1 duplicate.

### Boot

- Demo gateway, 6 Nov ~00:15 IST: boots 18–43 s. Snapshot download over the gateway 12.7 s (1.46 MB); dial alone 2.8 s; then `Could not connect to guard … retrying in 30 s`. A host-supplied snapshot (`config.bootstrap`) worked: directory ready at 0.7 s instead of the download, but the guard failures still cost 18–28 s.
- ~02:00 IST the demo gateway stopped completing KPS handshakes (`kps: HELLO timeout` / `dial timed out`, two Chromium versions) and no boot finished within 5 min.
- **Own gateway** (`gateway/`, Docker on this laptop, 127.0.0.1): directory synced in ~30 s after start; snapshot served in **414 ms**; tor-js cold boot **4.0 s**, warm-storage boots 4.1–4.3 s; reads p50 1,242 ms, p90 1,296 ms (mainnet publicnode), Sepolia p50 1,412 ms.
- With our gateway serving the snapshot that fast, packaging it saves little (extension boot 3.4 s vs 3.2 s). It matters when the gateway is slow or loaded.

### Old vs new extension, live (`ab.mjs`, own gateway, 4 interleaved rounds, fresh browser each)

| | Old (one worker.fetch per request) | New (batch + cache + dedupe + pre-warm) |
|---|---|---|
| Dashboard page: 20 parallel reads incl. 3× chainId, 3× blockNumber, 4 duplicates — median | 3,237 ms, **73/80 answers OK** (read endpoint dropped some of 20 parallel requests) | **1,680 ms, 80/80 OK** |
| Same view again a few seconds later | 1,137 ms | 1,055 ms |
| app.ens.domains/vitalik.eth, page settled | 7,929 ms | 7,643 ms |
| Extension boot (incl. 3 s idle in the script) | 6,403 ms | 6,776 ms |

Reading it:
- Batching wins where a page fires many reads at once: ~2× faster and no dropped answers. It doesn't help ENS: its 8 Multicall requests depend on each other, so they arrive one after another.
- 25× (sequential vs batch) is the upper bound for a page that awaits each read; real dapps mostly fire in parallel, so ~2× is the honest number.
- Pre-warm isn't in this table (no wallet connected). Its effect is the first-read-on-a-new-key cost above (~0.9 s).

### Final run through the extension (`ext-final.mjs`, dist-local, 3 own gateways, 6 Nov)

| | Result |
|---|---|
| Browser launch → Tor ready, no tab opened | 4.6–4.8 s (boot 3.3–3.4 s, packaged snapshot) |
| First dapp read after startup | 1.5–2.1 s |
| Single read, warm (30) | p50 0.86–1.02 s, p90 1.27–1.36 s, mean 0.93–1.09 s |
| `eth_chainId` (answered by Canary) | 1 ms |
| 20 parallel reads (5 runs) | p50 0.96–1.06 s, 100/100 OK |
| app.uniswap.org/explore/tokens | 13/13 RPC calls protected, 0 failed closed |
| Kill the busiest gateway (×2), retry only | 1 failed read per kill, 20–36 s until reads were normal |
| Same, hedged (3 s) on a fresh circuit | 1 failed read per kill (11–13 s), 19–21 s gap, then normal |

The hedge shortens the stall but can't remove it: for a few seconds after a gateway dies, tor-js still builds the new circuit through it, because it only marks a gateway cooling after a failure. Getting this to zero needs a change in tor-js's gateway health checks, not in Canary.

### EF's gateway vs ours (`gw-matrix.mjs`, `boot-log.mjs`, 6 Nov, ~04:00 IST)

Builds: `dist/` (EF's demo gateway only), `dist-mixed/` (`config/mixed-gateway.json`: EF + our 3).

| | EF only | EF + our 3 |
|---|---|---|
| Browser launch → Tor ready | **>180 s** (still booting) | 4.0–5.2 s |
| First dapp read | 43 s (waited for boot) | 2.1–4.9 s |
| Single read, warm (30) | p50 1.52 s, p90 1.91 s, 0 failed | p50 0.84–1.64 s, p90 1.55–1.92 s, 0 failed |
| 20 parallel reads | p50 1.85 s, 100/100 | p50 1.37–1.60 s, 100/100 |
| app.uniswap.org / app.ens.domains | 9/9 and 8/8 protected | 9–13/9–13 and 8/8 protected |

Failover in the mixed pool:
- Kill ours one by one: 0, 1 and 1 failed reads; recovery gaps 5 s and 36 s.
- Kill all three of ours at once, so only EF is left: every read failed for over 150 s, then reads recovered through EF.
  - Before the fix below, recovered reads took 3.1–5.8 s each.
  - After the fix: one 4.6 s read, then 0.6–1.1 s.

Found and fixed:
- **Recovered reads stayed slow (fixed):** tor-js keeps giving a key the circuit through the dead gateway, so every later read waited the 3 s hedge and was answered by it. Now, when the hedge wins, its circuit becomes that key's circuit (`circuitFor` in background.ts). Recovered reads went from ~4.2 s to ~0.8 s.
- **Unclear error (fixed):** a timed-out read said "signal is aborted without reason"; it now says "no answer within 30 s".

Not fixable in Canary:
- **EF's gateway can't reach Tor guards reliably.** `ef-boot.log`: "Could not connect to guard … Retrying in 2m 30s" from 13 s on, then "Unable to select a guard relay" and "Unable to download a usable directory" at 177 s. The same guards work through our gateway at the same time, and the packaged consensus was valid (valid until 23:00 UTC; the run was at 22:50). The problem is in EF's gateway (load, limits or network); only its operator can fix it. This is why falling back to EF alone takes minutes.
- **A pool with EF in it is a little slower:** some circuits go via Frankfurt (125 ms RTT, several round trips per read).
- **The first failed read after a gateway dies:** tor-js only marks a gateway cooling after a failure through it (see above).

### HTTP keep-alive in tor-js (`ka-bench.mjs`, 6 Nov)

tor-js patched to reuse HTTP/1.1 connections per isolation key ([tor-js-patches/](tor-js-patches/)). Built in Docker with the pinned toolchain; the unpatched build came out hash-identical to the on-chain worker (`0x5b62f358…818b`), so the baseline is exactly what Canary runs. Both loaded through the real harness with hash verification (a stand-in specifier pointing at the local bundle), our 3 gateways, 3 interleaved rounds, fresh profile each.

| | stock 0.4.4 | keep-alive |
|---|---|---|
| warm read, no key (75) | p50 827 ms, p90 1,255, mean 875 | **p50 234 ms, p90 325, mean 255** |
| warm read, isolation key (45) | p50 1,140 ms, p90 1,626, mean 1,121 | **p50 203 ms, p90 250, mean 217** |
| first read after 40 s idle (new connection) | p50 1,043 ms | p50 1,014 ms |
| 20 separate parallel reads | p50 2,008 ms | **p50 982 ms** |
| boot | 2.5 s | 3.0 s |
| failed | 0 | 0 |

This is the final build (`0xd80132ce…`, after the review fixes below); raw: `res-keepalive.json`. Stock varies with the circuit (warm-read p50 0.56, 1.12 and 0.83 s in its three rounds; 0.78 s in the first run, which had keep-alive at 0.25 s). Against the first patched build (`res-keepalive-old-vs-final.json`): warm reads the same (p50 259 vs 244 ms), 20 parallel reads faster (p50 1.2 vs 1.9 s).

- A warm read now costs about one circuit round trip instead of three: about 3× faster.
- After 30 s idle the pool drops the connection, so the next read pays full price again.
- 20 separate parallel requests gain less (the pool keeps 4 per key). Canary sends those as one batch anyway.
- It can't ship from Canary alone: the worker is pinned on chain by hash. It has to land upstream in tor-js, or run under a specifier we publish.

### Gateway liveness check in tor-js (`fo-bench.mjs`, 6 Nov)

The patched worker (keep-alive + liveness check, [tor-js-patches/](tor-js-patches/)) vs stock 0.4.4. 3 own gateways, a read every 500 ms, the busiest gateway killed twice per build and run. Final build (`0xd80132ce…`); raw: `res-failover-patched.json` (stock vs final), `res-failover-final-x4.json` (final only).

| | stock 0.4.4 | patched (0001 + 0002) |
|---|---|---|
| failed reads per kill | 2, every time | **1, every time** |
| until reads were normal again | 17–31 s (17.4, 18.2, 18.3, 23.9, 25.0, 30.8) | **10.5–14.0 s** in 5 of 6 (10.5, 11.2, 12.5, 12.9, 14.0); once 31.5 s |
| the read in flight at the kill | failed after 10 s, and so did the next one | failed after 7.9–8.9 s; the next one was answered |
| reads afterwards | 0.5–1.6 s | 0.2–0.6 s |

Stock: 6 kills over 3 runs (raw: this run's 2 in `res-failover-patched.json`, the first run's 17.4/18.2 in its git history; the second run's file was overwritten). Patched: 6 kills over 2 runs (`res-failover-patched.json`, `res-failover-final-x4.json`).
- The 31.5 s kill: the read after the failed one took 22 s. Not explained yet; there's no worker log from that run.
- The read in flight fails because it was already sent: the server may have received it, so it isn't resent (RFC 9112 §9.3.1). The first patched build re-sent it and showed 0 failed reads, but that's unsafe for anything that isn't a read, so it's gone.

What's left: the read in flight still fails (about 8 s for detection), and one kill in six still took 31.5 s.

### Patched tor-js through the whole extension (`ext-ka-bench.mjs`, 6 Nov)

`dist-local` (on-chain tor-js) vs `dist-patched` (`config/local-patched.json`: the patched worker as a dev worker, hash pinned at build time). Same 3 own gateways, 3 interleaved rounds, fresh profile each, a dapp-style page reading through Canary.

| | on-chain tor-js | patched |
|---|---|---|
| warm read (90) | p50 653 ms, p90 877, mean 715 | **p50 222 ms, p90 451, mean 305** |
| 20 parallel reads (Canary batches them) | mean 723 ms | **mean 355 ms** |
| first read after 40 s idle | mean 882 ms | mean 1,108 ms (new connection) |
| failed | 0 | 0 |

- One patched session was slower (p50 434 ms against ~215 ms in the other two), probably a slower circuit.
- Extension overhead (batch window, messaging) is a fixed slice, so the gain is ~2.3× here vs ~3× on the bare worker.
- The 3.0 vs 4.1 s browser-to-ready difference isn't from the patch, which doesn't touch boot.

This run used the first patched build (`0x4f4812b9…`), before the review fixes below.

A review of the patches turned up issues, now fixed in the final build:
- the pool never evicted keys it wouldn't see again: expired keys are now swept, with at most 32 idle connections in all (the longest idle goes first);
- the chunked decoder could leave the final CRLF or trailers on a reused connection: a connection is now pooled only if its body ended exactly at its framed end, trailers read;
- the gateway check ran for the whole session: a gateway is now pinged only when it has owed us bytes for 2 s, and never while its traffic flows;
- the patch re-sent a POST after any failure on a reused connection: it now resends only when the connection closed before any response byte (RFC 9112 §9.3.1), never after a timeout or a partial response.

Also: idle connections respect the server's `Keep-Alive: timeout`, HTTP/1.0 responses without `Connection: keep-alive` aren't pooled, and connections retire 2 min after opening (was 10). A check before reuse that the idle connection was still open was tried and dropped: it slowed 20 parallel reads to 2.3–2.7 s.

### Found along the way

- **Shim race (fixed):** if the wallet handed out an address before the extension's config reply arrived, `applyConfig` replaced the address list and dropped it, so every leak check failed (e2e 20/24 on Chrome for Testing 156, also on the old code). Now merged. e2e 26/26, twice.
- **app.uniswap.org failed closed (fixed):** its RPC proxy (`/rpc/<chainId>`) answers HTTP 401 to the `eth_chainId` probe over Tor (it wants Cloudflare cookies; even the real site's first request gets 401), so Canary couldn't learn the chain and every call failed closed. Fixed by taking the chain from the URL for that host (and as a hint for `/rpc/<n>`-style URLs after a failed probe), so reads are substituted to our read endpoint: 13/13 protected, 0 failed closed.
- Claude in Chrome can't load an unpacked extension (`chrome://extensions` isn't scriptable), so live runs used Chrome for Testing 156 with `--load-extension`.

## 15. Real-dapp scans (6 Nov)

`scanner/scan.mjs --compare` on five mainnet dapps, with `extension/dist-local` (tor-js through our 3 gateways). Flow: load → connect → scroll, a fresh synthetic address per run. None of them publishes a manifest, so "declared" isn't checked. Table: [`test-artifacts/scans/RESULTS.md`](test-artifacts/scans/RESULTS.md) (`scanner/summary.mjs`), with each site's reports beside it.

- **Third parties that received the address: 12 → 0** across the five. RPC calls leaving the page directly: 0 on four of them.
- **Aave: coverage 15%.** Most of its reads go to its own `/api/rpc-proxy/` as `{chainId, method, params}`, not JSON-RPC 2.0, so Canary doesn't recognize them: 11 calls left the page directly, 4 with the address, and Aave's server passes them on to its provider. Canary counts the ones with the address as detected (first party). Its third-party RPC (`mainnet.gateway.tenderly.co`) went through anon-rpc.
- **Blocking has a cost.** Blocked requests included ones the apps use: app.ens.domains' name list (`api.bigname.sh`), Snapshot's profile and follows (`hub.snapshot.org`, a different site from snapshot.box) and avatars (`stamp.fyi`), Aave's merit APRs (`apps.aavechan.com`). Others were analytics: Aave's Datadog logs (3 requests with the address). Without a manifest, all are undeclared third parties. We didn't check what the pages showed without them.
- **revoke.cash: 4 failed closed.** Its Polygon reads go to Alchemy with the dapp's key, and over anon-rpc Alchemy answered 403, so they failed instead of going direct. Avalanche has no read endpoint configured, so it was forwarded to the dapp's URL over anon-rpc (IP only). Ethereum reads went to our read endpoint.
- **First parties still get the address**, by design: Uniswap's feature-flag and metrics endpoints (`app.uniswap.org/config/rgstr`, `metrics.interface.gateway.uniswap.org`), revoke.cash's own pages and API, Aave's GraphQL API and compliance check. Uniswap's own RPC gateway (`entry-gateway…/rpc/1`, an `eth_getBalance` of the address) went through anon-rpc.
- **Latency:** p50 0.8–5.3 s per read, 1–5 reads per site: too few to compare sites.
- **Build fingerprints differ between the two runs of each dapp.** On app.ens.domains the HTML document and Cloudflare's challenge script change on every load, so on real dapps the fingerprint names a run, not a release. LeakyDash's is stable (`0678454eabf8` again today, as in its published verdict).
- The fake wallet answers `eth_accounts`, so Uniswap, Aave and revoke.cash had the address on load without a click.
- snapshot.box timed out on page load twice through mitmproxy (once in each mode) before a clean run; direct requests to it took < 0.4 s.

Scanner fixes from these runs:
- JSON-RPC methods in a custom envelope count as RPC (`lib/matcher.mjs`). Before, Aave showed 100% coverage.
- The build fingerprint no longer includes what Canary itself fetched (`/.well-known/canary.json`), which made every with-Canary fingerprint differ from the baseline.
- The step log says when the dapp read the account without a click.

## 16. Gateway and SDK live over tor-js (6 Nov)

- `canary-gateway` with `examples/viem-agent/canary.config.json` (EF's demo gateway only): Tor never bootstrapped. The dial to the gateway timed out, then "Reached circuit build retry limit" at ~70 s. The same config with our 3 gateways: worker ready in 3.6 s.
- Through it: Sepolia `eth_blockNumber` (one block behind publicnode queried directly), `eth_getBalance`, a batch of `eth_chainId` + `eth_call`, and mainnet `eth_blockNumber`, all answered in 0.84–0.87 s. `eth_sendTransaction` was refused locally. Report: 6 RPC calls, 5 protected, 1 blocked.
- `examples/viem-agent` (`node agent.mjs`, no LLM key): its 3 reads were protected (0.9–1.0 s), the prompt it would send names `WALLET_1` and `AGENT_NAME`, and it printed coverage and the on-chain report form.
- On a fresh clone, `npm install && npm run build` left `canary-gateway` and `canary-ens` unlinked (their `dist/` doesn't exist yet at install), so `npm run gateway` failed with "command not found". Fixed: the root `build` ends with `npm rebuild @canary/gateway @canary/ens`, which links them. `examples/viem-agent` gained `npm run gateway:local` (our gateways).
- **The agent's names on ENSv2 Sepolia** (`packages/ens/scripts/sepolia-setup.mjs`, run with `--rpc` = the gateway): `agents.canary.eth` (its own UserRegistry) and `trader-01.agents.canary.eth` (its own Permissioned Resolver), plus a funded report key. All 6 transactions, and the 5 record writes after them, went through the gateway, so `eth_sendRawTransaction` over anon-rpc now works live (write mode `anon`). A second run of the setup sent nothing.
- **Policy from ENS** (`npm run gateway:ens:local`): the gateway started fail-closed, then loaded the manifest from the name (policy `0x280b5592…`, reporter declared). The agent's 3 reads were protected (1.1–1.6 s), and `POST /canary/publish` wrote the signed report. `canary-ens read`: `reportSigned`, `signerIsReporter`, `policyMatches`, `reporterCanWrite` true. After `revoke-reporter`: `reporterCanWrite` false, and the gateway's publish got HTTP 409; after `grant-reporter`, true again.
- Not run live yet: an LLM call, `examples/python-agent`.

---

# Round 3: full test pass against the prize criteria (6 Nov 2026)

Fresh clone of `main` at `83d52aa`, plus live runs in a real Chrome with the Canary extension loaded.

## 15. Offline suites (fresh clone, Chrome for Testing): all pass

| Suite | Result |
|---|---|
| `@canary/core` | 11/11 |
| `@canary/ens` (mock ENSv2) | 8/8 |
| `@canary/gateway` (passthrough worker) | 39/39 |
| `@canary/agent` | 13/13 |
| `extension` unit + e2e | 20/20 + 41/41 checks |
| `leakydash` | 4/4 |

The root suite is 71 tests; the README says 61.

## 16. Live: the extension on the deployed LeakyDash

`https://canary-leakydash.vercel.app`, leaky mode, watching vitalik.eth's address on Sepolia.

- **The data is correct.** Every value matches Blockscout's independent REST API, read at the same moment:

  | Value | LeakyDash via Canary | Blockscout |
  |---|---|---|
  | ETH balance | 61.7233 | 61.7233 |
  | USDC | 1,831.3359 | 1,831.3359 |
  | WETH | 0.1371 | 0.1371 |
  | LINK | 67.111 | 67.1110 |
  | latest block | 12,074,871 | 12,074,871 |

- **It went through anon-rpc.** On refresh, the page made two JSON-RPC calls (`eth_call` multicall, `eth_gasPrice`) to its own provider. Both were answered in 1.46–1.66 s, which is Tor latency. The tab's network log recorded **no** request to the provider host. As a control, a plain `fetch` to Blockscout from the same tab did show up in that log.
- **What the other parties received.** The log viewer, per visitor, showed **0** provider entries. The first-party `/api/points` call and the tracker pings appeared there. (The watched address isn't one of *your* addresses, so Canary correctly let those through. Blocking your own address is covered by the e2e and the scanner.)
- **Flaky:** the deployed tracker answered 503 to all three pings once, and only one of the three was logged. A minute later it answered 204. The logs live in each serverless instance's memory, so the viewer can miss entries on Vercel. Warm the deployment up before demoing.

## 17. Live: the extension on an unmodified real dapp (app.ens.domains)

- Navigating to `vitalik.eth` produced **7 JSON-RPC batches** to the app's own keyed dRPC endpoint. All 7 were answered through Canary in 1.2–6.4 s.
- The network log shows only the two non-RPC calls to the indexer (`api.bigname.sh`), and **zero** requests to dRPC.
- The page rendered correctly: registered Feb 6 2020, expires Jan 31 2048.

## 18. Findings, and what was done about them

| # | Finding | Fix |
|---|---|---|
| 1 | The default configs (`extension/config/live.json`, `examples/viem-agent/canary.config.json`, `canary.ens.config.json`) listed only EF's demo gateway, which was down: in §19 it was still "warming" after 123 s. | The defaults now list our gateways. New `npm run gateways -- <address> … [--with-ef]` (`scripts/set-gateways.mjs`) points all three configs at anyone's gateway. The README Quick start starts with running one in Docker. |
| 2 | The gateway sent each anon read once, so a stuck Tor circuit or exit stalled an agent's read until the timeout. The extension already hedged reads. | The gateway now hedges reads like the extension (`hedgeMs`, default 3000): the read is re-sent under a fresh isolation key, the first answer wins, and the working circuit is kept for that wallet. Never for broadcasts. New `test/hedge.test.mjs` (2 tests). Gateway suite 41/41, root suite 73/73. |
| 3 | The LeakyDash log viewer on Vercel lost entries: logs are per serverless instance. Probe: 20 tracker pings, then 10 reads of the log; the first read saw 19 entries and the other 9 saw **0**. | Entry ids are now unique per instance (`<instance>-<seq>`), and the viewer merges what every poll returns ("merged from N server instances"). "Clear" hides everything before it, on every instance. Simulated with two instances behind a round-robin proxy: one poll sees 5 of 10 entries, and the viewer shows 10/10 from its first poll. No database (chosen). |
| 4 | The deployed tracker answered 503 to all three pings once, and 1 of 20 probe pings failed. A minute later it was fine. Most likely cold starts; Vercel's logs weren't readable from here. | Open the site once before demoing. |
| 5 | The README said 61 tests. | It now says 73. |
| 6 | No demo video yet. | Out of scope for this pass. |

## 19. Agents (gateway + SDK) live over tor-js: 24/24 on our gateways

`scripts/live-e2e.mjs` (double-click `run-live-e2e.command` or `run-live-e2e-own.command` next to the repo). Run on macOS (arm64), Node 24, Chrome. Ground truth is direct reads at a pinned block (latest − 12) of a public address (vitalik.eth's).

| Gateways | Result |
|---|---|
| EF's demo gateway (the old default) | ✗ the worker was still "warming" after 123 s: no boot |
| Our three gateways (before the hedge) | 22/22 (the ENS step wasn't in the script yet). Boot 7.6–8.0 s; reads 0.85–2.3 s |
| Our three gateways (after the hedge, final) | **24/24.** Boot 4.4 s; reads 0.68–0.90 s |

What the 24 checks cover:

- **Any-language path:** JSON-RPC to the gateway's endpoint on Sepolia and mainnet. `eth_chainId`; `eth_getBalance`, `eth_call` (USDC `balanceOf`) and `eth_getBlockByNumber` at the pinned block: every value **identical** to the direct read. The latest block was within 1 block of direct.
- **TypeScript SDK:** viem `getBalance` and `readContract` on both chains, and ethers `getBalance`: identical.
- **Tor:** `check.torproject.org` through the SDK's policy-checked `fetch` answers `IsTor: true`, from an IP that isn't this machine's (direct: `IsTor: false`).
- **LLM:** a local echo server playing the provider received `You manage wallet WALLET_1…`. The allow-listed USDC contract passed unchanged, and the reply came back with the real address restored.
- **Policy:** `example.com` (undeclared) → 403 `blocked`. Report: `total 14, protected 14, direct 0, failedClosed 0`.
- **Python agent** (`examples/python-agent`, standard library only): read block and balance through the gateway with no code changes.
- **ENSv2 on Sepolia, read over anon-rpc:**
  - `leakydash.eth` → own resolver `0xD9aB…99ba`, `url` = the deployed site, `privacy.manifest`, and the verifier's signed verdict: **`undeclared`**, host `canary-leakydash-tracker.vercel.app`, signer `0x0f17…51De`.
  - `trader-01.agents.canary.eth` → resolver `0x9365…1Fb0`; `reportSigned`, `signerIsReporter`, `policyMatches` and `reporterCanWrite` all **true**.

Raw results: `../live-check/results.json` (outside the repo: it holds this machine's IP via the direct Tor check).

## 20. Privacy labels, the connect notice, receipts, 69 read endpoints (6 Nov)

**Offline suites:** `@canary/core` 13/13 (two new chain-detection tests), `@canary/ens` 10/10 (`addressRecipients`, label names), `@canary/gateway` 41/41, `@canary/agent` 13/13: root suite 77/77. Extension: unit 22/22 (two new: the label fallback), e2e **50/50** (a seventh run: a site with no manifest and Canary's label; the connect notice, shown once per site; receipts). The gateway's "Chromium dies mid-request" test failed once (relaunch not ready within 15 s) while 12 Chrome processes from a live run were open, and passed alone.

**Read endpoints:** 69 chains in every shipped config, each one checked through our gateways over Tor with `eth_chainId` and an `eth_getBalance`. Official RPCs that refused Tor exits with HTTP 403: mainnet.optimism.io, rpc.gnosischain.com, mainnet.unichain.org, both zkSync Era RPCs, zkevm-rpc.com, rpc.api.lisk.com, rpc.soneium.org, both abs.xyz RPCs, Flare's API, Kaia's public node, rpc.taiko.xyz; publicnode or drpc is used for those chains instead. drpc's Kaia and Blast answer `eth_getBalance` with "method does not exist", so those two chains have no read endpoint (their reads are forwarded). Chain detection no longer maps an L2 or testnet provider URL to another chain's id (`linea-mainnet.infura.io` was read as mainnet); unknown provider network names are probed instead of guessed.

**Labels on Sepolia** (`packages/ens/scripts/sepolia-setup.mjs --label …`): `labels.canary.eth` (UserRegistry `0x0C7D…be28`, labels resolver `0x1b46…3443`, one grant to the verifier), and labels for app.uniswap.org (no third party got the address), app.aave.com (3), app.ens.domains (2), revoke.cash (3), snapshot.box (4). 20 transactions, all in `packages/ens/sepolia.json`. Read back with the extension's reader (`extension/test/ens-live.mjs <origin>`): signed, signer = `verifier.canary.eth`'s `addr`, role held, bound, not expired, for all five; the deployed LeakyDash still reads from `leakydash.eth`.

**Live, the extension over our tor-js gateways (`dist-local`):**

| Site | Result |
|---|---|
| app.aave.com | worker ready in 4.5 s; label read from `app-aave-com.labels.canary.eth`; the notice appeared 10 s after load: "3 third parties got your address in Canary's scan", apps.aavechan.com, browser-intake-datadoghq.com, mainnet.gateway.tenderly.co, signed by verifier.canary.eth. 9 requests blocked, 2 reads protected |
| canary-leakydash.vercel.app | its own manifest: "The site says 1 third party gets your address" (its RPC), and "verifier.canary.eth saw it send your address to more: canary-leakydash-tracker.vercel.app" |
| app.uniswap.org | label read from `app-uniswap-org.labels.canary.eth`; notice 12.5 s after load: "No third party got your address in Canary's scan"; popup "12 of 12 observed requests protected or blocked": 11 reads through anon-rpc (0.9–3.9 s), nothing exposed |
| app.ens.domains | label read from `app-ens-domains.labels.canary.eth`; notice 10.7 s after load: "2 third parties got your address in Canary's scan" (api.bigname.sh, lb.drpc.live); 3 reads protected, 2 requests carrying the address blocked |

**Fixed: the scanner's fake wallet froze Uniswap.** `scanner/lib/wallet.js` emitted `connect` on every `eth_accounts`; Uniswap re-reads accounts on `connect`, so the two looped and its main thread stalled 10–90 s in Chrome for Testing, with or without Canary (2 ms with no wallet). It now emits `connect` once, as a wallet does: main thread back to 1–2 ms with the wallet. Earlier Uniswap scans finished despite the stall, so their results stand.

