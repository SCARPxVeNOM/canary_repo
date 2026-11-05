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

# Round 4: Canary for agents, live over tor-js (5–6 Nov 2026)

The packages from round 3, on a Windows machine and the real network.

- **Machine:** Windows 11, Node v25.2.1, installed Google Chrome (gateway backend), Playwright Chromium 156 (extension e2e).
- **anon-rpc:** `@anon-rpc/browser-harness` 0.4.0, the tor-js specifier `0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e`, EF's one KPS gateway `152.236.3.22:12298`.

## 14. Local suites on Windows

| Suite | Result |
|---|---|
| `@canary/core` | ✅ 5/5 |
| `@canary/ens` | ✅ 4/4 |
| `@canary/gateway` | ✅ 40/40 (one new: path health) |
| `@canary/agent` | ✅ 13/13 |

## 15. Live runs over tor-js

| Run | Worker `ready` | First read through | Reads after that |
|---|---|---|---|
| 5 Nov (`scripts/live-check.mjs`) | not within 180 s | ~204 s (23.6 s for the first read) | 0.8–0.9 s; 18/19 checks passed, the only fail was the 180 s boot limit |
| 6 Nov, probe 1 | 304 s | not before the run ended | — |
| 6 Nov, probe 2 | 69 s | ~229 s | 0.86–2.3 s (7 reads) |
| 6 Nov, live check | not within 300 s | not within the next 300 s (9 tries) | — |

The 5 Nov run passed everything else over tor-js: mainnet and Sepolia reads, batches split per wallet, the SDK's viem client, an undeclared host blocked, CoinGecko (declared `anon`) answered from a Tor exit, and the coverage report (14/14 RPC calls protected, nothing direct, nothing failed closed).

## 16. Findings

1. **`ready` is not serving.** tor-js signals ready once it has a directory. Circuits through the KPS gateway came minutes later (69 s against ~229 s in probe 2), and in that gap every read timed out after 30 s while the status said `ready`. The backend now tracks call outcomes: `status().path.serving` is `unknown` / `yes` / `no`. `/canary/status` and the CLI show it, and the live check waits for the first read that gets through and reports both times.
2. **The slow part is the KPS gateway, not Canary.** Fast bootstrap failed every time ("all gateways failed for /bootstrap.zip.zst"). Directory downloads and circuit builds timed out in a loop ("Problem downloading directory object", "All tunnel attempts failed due to timeout", "Could not connect to guard"). The gateway reports itself as "a demo instance: limited capacity, and it may disappear at any time". Same code, same machine: boot in 69 s in one run, nothing after 10 min in another.
3. **Canary failed closed throughout.** No read went direct while the path was down; each returned a JSON-RPC error (`anon path failed: … timeout`).
4. **"Chromium page crashed" was the test harness.** All three crashes landed ~2 s before the deadline of the `timeout` command wrapping the probe (58 s of 60, 327 of 330, 378 of 380): on Windows it kills Chrome first. Not a Canary bug; don't wrap the gateway in `timeout` on Windows.

## 17. Next

- Ask EF (agent-sdk.md §10): is the demo KPS gateway shared and rate-limited, and can we run our own? With a reliable gateway the demo needs boot + first circuit to be predictable.
- Rerun `run-live-check.cmd` when the gateway is quiet. Warm the gateway well before a demo: boot to first read took 3.5–4 min when it worked.
- ENS on live Sepolia still untested (needs a Sepolia name; `--ens-name`).
