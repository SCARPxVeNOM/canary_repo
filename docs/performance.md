# Performance: making anon-rpc fast enough to use

Every read Canary protects goes through a Tor circuit that tor-js builds inside the browser, reaching Tor through a tor-js gateway over WebRTC. When we started, a read cost about 1.4 s and the default gateway took 18–43 s to boot. A few hours later it stopped completing boots at all. A privacy tool that makes a dapp feel broken gets turned off, so we spent a large part of the hackathon finding out where the time goes and taking it out.

This page covers where the time goes, what we changed in Canary, what we changed in tor-js (patches written for upstream), and the bugs we found along the way. Raw numbers and method are in [test-log.md §14](test-log.md). Scripts and raw results are in [`test-artifacts/latency/`](../test-artifacts/latency/).

## Results

| | Before | After | How |
|---|---|---|---|
| Browser launch → Tor ready | 18–43 s on EF's demo gateway; > 180 s once it degraded (6 Nov) | **4.6–4.8 s** | own gateways, packaged directory snapshot |
| A page firing 20 reads at once (median) | 3,237 ms, **73/80 answers OK** | **1,680 ms, 80/80 OK** | batching, dedupe, cache, pre-warm |
| 20 reads (bare worker) | 43–55 s one by one | **1.6–2.1 s** as one JSON-RPC batch | batching |
| First read for a newly connected wallet | p50 2,036 ms (new circuit) | ~0.9 s less | pre-warm the wallet's circuit |
| Reads after a gateway dies (recovered) | ~4.2 s each | **~0.8 s** | hedge, then adopt the winning circuit |
| Warm read, through the extension | p50 653 ms (stock tor-js) | **p50 222 ms** | keep-alive patch for tor-js (0001) |
| A gateway dies silently | 2 failed reads, 17–31 s to recover | **1 failed read, 10.5–14.0 s** (5 of 6 kills) | liveness patch for tor-js (0002) |

The first five rows are shipped in the extension. The last two need a new tor-js release (see [Patches for tor-js](#patches-for-tor-js)).

## Where the time goes

- **tor-js sends `Connection: close` on every request** (`crates/tor-js-wasm/src/fetch.rs:382`). Every read opens a new Tor stream, then TCP from the exit, then a TLS handshake: about three circuit round trips before the request leaves. TLS sessions are resumed per isolation key, but nothing else is reused.
- **The WASM is not the bottleneck.** The 5.08 MB Arti binary compiles in 8 ms, and loading a directory snapshot takes 0.7 s.
- **Distance to the gateway adds up.** EF's demo gateway is in Frankfurt, 125 ms RTT from our machine in India, and every circuit round trip pays it several times.
- **Direct, a read takes p50 171 ms.** Over EF's demo gateway, a warm read took p50 1,446 ms (935–3,469).
- **Dapps repeat themselves.** With no wallet connected, app.uniswap.org made 24 RPC calls, 20 of them exact duplicates and 12 of them `eth_chainId`/`net_version`. app.ens.domains made 8 calls, 7 of them Multicall3, which depend on each other and so arrive one after another.

The cost is in the number of requests, not their size. That shaped everything below.

## What we changed in Canary (shipped)

All of these are in `extension/src/rpc-pipeline.ts` and `extension/src/background.ts`. They are covered by the extension's unit tests and e2e test.

1. **One request instead of many** (`RpcPipeline`):
   - **batch**: calls for the same endpoint and the same isolation key that arrive within 15 ms leave as one JSON-RPC batch, at most 20 calls. Calls for different keys are never batched together, because that would put two addresses' reads on one circuit.
   - **dedupe**: an identical call already in flight shares its answer.
   - **cache**: `eth_chainId` and `net_version` are cached for good, which answers them in 1 ms. Non-empty `eth_getCode` is cached per block, and `eth_blockNumber` for 2 s.
   - **split**: an endpoint that refuses a batch for its size (HTTP 400/413; dRPC's free plan does past 3 calls) gets it again in halves, and no larger batches from then on.
   - Writes are never batched, shared, cached or retried.
2. **Pre-warm.** When a wallet connects, Canary opens that address's circuit with a cheap `eth_blockNumber` before the dapp asks for anything. A first read on a new isolation key costs ~0.9 s more than the next one (p50 2,036 vs 1,152 ms), so pre-warming takes that cost off the dapp's first real read.
3. **Packaged directory snapshot.** The build packages a tor-js bootstrap snapshot (1.46 MB). The build fetches a new one when the packaged one is more than 3 h old, and the extension uses it for up to 72 h. Over EF's gateway, downloading it took 12.7 s. Packaged, the directory is ready at 0.7 s.
4. **Our own gateways, in a list.** [`gateway/`](../gateway/) builds EF's `tor-js-gateway` at a pinned commit as one Docker container. On it, tor-js boots cold in 4.0 s and the snapshot is served in 414 ms. tor-js spreads clients across the configured gateways and fails over on its own, so EF's gateway stays in the list as a fallback. Ours plus EF's: ready in 4.0–5.2 s, against more than 180 s with EF's alone.
5. **Hedge, then adopt the winner.** A read with no answer after 3 s goes out again on a fresh circuit, and the first answer wins. This alone wasn't enough: tor-js kept giving the key the circuit through the dead gateway, so every later read waited the full 3 s and was answered by the hedge (~4.2 s per read). Now, when the hedge wins, its circuit becomes that key's circuit (`circuitFor`). Recovered reads went from ~4.2 s to ~0.8 s.
6. **Clear errors.** A timed-out read used to say "signal is aborted without reason". It now says "no answer within 30 s".

Final run through the extension (own gateways, packaged snapshot):

| | Result |
|---|---|
| Browser launch → Tor ready | 4.6–4.8 s |
| First dapp read after startup | 1.5–2.1 s |
| Single read, warm (30) | p50 0.86–1.02 s, p90 1.27–1.36 s |
| 20 parallel reads (5 runs) | p50 0.96–1.06 s, 100/100 OK |
| app.uniswap.org/explore/tokens | 13/13 RPC calls protected, 0 failed closed |

Under load, the Canary Swap stress run sent 651 calls (10 swaps, 30 quotes, bursts to 11 RPC URLs). All 651 went through anon-rpc, 397 of 397 checked answers equalled a direct read, and the mean was 1.37 s per request ([test-log.md §22](test-log.md)).

## Patches for tor-js

Two of the bottlenecks are inside tor-js, so we fixed them there. Patches, tests and build steps are in [`tor-js-patches/`](../tor-js-patches/). Both apply cleanly to tor-js v0.4.4, in either order.

**They can't ship from Canary.** The anon-rpc worker is pinned on chain by its keccak256 (stock `0x5b62f358…818b`), and the patched build (`0xd80132ce…c782`) is a different worker. They have to land in tor-js and a new worker be registered. Our Docker build of unpatched v0.4.4 is hash-identical to the on-chain worker, so the baselines below are exactly what Canary runs today.

### 0001: HTTP keep-alive per isolation key

This keeps HTTP/1.1 connections open and reuses them, with one pool per isolation key, scheme, host and port. A connection never carries requests for two keys, so reusing connections doesn't link anything that wasn't already linked. A warm read now costs one circuit round trip instead of three.

Measured on the bare worker (`ka-bench.mjs`, 3 own gateways, 3 interleaved rounds, a fresh profile each):

| | stock 0.4.4 | keep-alive |
|---|---|---|
| warm read, no key (75) | p50 827 ms, p90 1,255 | **p50 234 ms, p90 325** |
| warm read, isolation key (45) | p50 1,140 ms, p90 1,626 | **p50 203 ms, p90 250** |
| 20 separate parallel reads | p50 2,008 ms | **p50 982 ms** |
| first read after 40 s idle | p50 1,043 ms | p50 1,014 ms (new connection) |
| failed reads | 0 | 0 |

Measured through the whole extension (`ext-ka-bench.mjs`):

| | stock 0.4.4 | keep-alive |
|---|---|---|
| warm read (90) | p50 653 ms, p90 877 | **p50 222 ms, p90 451** |
| 20 parallel reads (Canary batches them) | mean 723 ms | **mean 355 ms** |

### 0002: gateway liveness check

A gateway that dies without closing its connection (a crash, a power cut, a network drop) just goes silent. tor-js only noticed when the WebRTC transport timed out (~20–30 s), and until then every tunnel, circuit and read through it hung. With the patch, a gateway that owes us bytes and has sent nothing for 2 s is pinged. After 2 missed pings it is cooled off and dropped, its tunnels close, and Arti rebuilds their circuits through another gateway. A gateway whose traffic flows, or that is idle, is never pinged.

Measured with `fo-bench.mjs` (3 own gateways, a read every 500 ms, the busiest gateway killed):

| | stock 0.4.4 | patched (0001 + 0002) |
|---|---|---|
| failed reads per kill | 2, every time | **1, every time** |
| until reads were normal again | 17–31 s | **10.5–14.0 s** in 5 of 6 kills (once 31.5 s) |
| reads afterwards | 0.5–1.6 s | 0.2–0.6 s |

### Getting the edge cases right

tor-js has many edge cases, so the patches were reviewed before they were measured again. The review found four problems, and the final build fixes all of them:

- **The pool never forgot keys.** Expired keys are now swept, with at most 4 idle connections per key and 32 in all.
- **Chunked responses could be cut short.** The chunked decoder could leave the final CRLF or trailers on a reused connection. A connection now goes back to the pool only if its body ended exactly at its framed end, trailers read, and the server didn't ask to close.
- **The liveness check ran for the whole session.** A gateway is now pinged only while it owes us bytes, never while its traffic flows.
- **A POST could be sent twice.** The first build re-sent a request after any failure on a reused connection. Now it resends only if the connection closed before any response byte arrived (RFC 9112 §9.3.1), and never after a timeout or a partial response. The first build showed 0 failed reads per kill, but resending like that is unsafe for anything that isn't a read, so it's gone.

Tests: `cargo test -p tor-js` 121/121, and `npm run test:unit` 222/222 including 4 new liveness tests.

## Issues we found

| # | Where | Issue | What we did |
|---|---|---|---|
| 1 | tor-js | `Connection: close` on every request (`fetch.rs:382`): each read pays for a new stream, TCP and TLS, about 3 circuit round trips | Patch [0001](../tor-js-patches/0001-http-keep-alive.patch): warm reads ~3× faster |
| 2 | tor-js | A gateway that dies silently is only noticed when the WebRTC transport times out, and is marked cooling only after a failure through it: 2 failed reads and 17–31 s of stall per dead gateway | Patch [0002](../tor-js-patches/0002-gateway-liveness-check.patch): 1 failed read, 10.5–14 s |
| 3 | tor-js | After a gateway dies, an isolation key keeps getting the circuit through it, so every read stalls until a hedge answers | Worked around in Canary: the hedge's circuit becomes the key's circuit (`circuitFor`) |
| 4 | EF's demo gateway | Can't reach Tor guards reliably ("Could not connect to guard … Retrying in 2m 30s", then "Unable to select a guard relay" at 177 s), while the same guards work through ours. From ~02:00 IST on 6 Nov it stopped completing KPS handshakes, so no boot finished | We run our own gateways ([`gateway/`](../gateway/)), with EF's as a fallback. Only its operator can fix the cause |
| 5 | anon-rpc | The root e2e can't run on macOS: the lockfile names `@infisical/quic-darwin-arm64@1.0.8`, which returns 404 on npm | Ran it in Docker (Linux arm64): all pass ([test-log.md §3](test-log.md)) |
| 6 | RPC providers over Tor | Tenderly and the official OP, Gnosis, zkSync, Taiko and other RPCs answer HTTP 403 to Tor exits. Uniswap's `/rpc/<chainId>` proxy answers 401 without its Cloudflare cookies. dRPC's free plan answers HTTP 400 to batches of more than 3 | Read endpoints chosen per chain and each checked over Tor (71 chains). Chain taken from the URL for Uniswap's proxy (13/13 protected, from 0). Batches split in halves on 400/413 |

## Reproducing

Everything above was measured with the scripts in [`test-artifacts/latency/`](../test-artifacts/latency/), against the real tor-js worker loaded through the anon-rpc harness with hash verification.

| Script | Measures |
|---|---|
| `drive.mjs` | bare-worker probes: direct vs warm, sequential vs parallel vs batch vs Multicall3, isolation keys |
| `traffic.mjs` | the RPC calls real dapps make |
| `ab.mjs` | old vs new extension on a dapp-style page |
| `ext-final.mjs` | the shipped extension: boot, reads, parallel reads, gateway kills |
| `gw-matrix.mjs`, `boot-log.mjs` | EF's gateway vs ours, and EF's boot log |
| `ka-bench.mjs`, `ext-ka-bench.mjs` | keep-alive on the bare worker and through the extension |
| `fo-bench.mjs` | gateway kills, stock vs patched |
