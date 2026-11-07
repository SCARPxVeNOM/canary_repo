# tor-js patches

Changes to [ethereum/tor-js](https://github.com/ethereum/tor-js) that Canary wants upstream. They can't be shipped from here: the anon-rpc worker is pinned on chain by its keccak256, so a modified tor-js is a different worker. They need to land in tor-js (and a new worker be registered), or run under a specifier we publish. `extension/config/local-patched.json` runs the patched worker as a dev worker, for measuring.

Both apply cleanly to v0.4.4 (`git apply`), in either order. The patched worker built from both is keccak256 `0xd80132ce…c782`.

## 0001-http-keep-alive.patch

tor-js sends `Connection: close`, so every request pays for a new Tor stream, TCP from the exit and a TLS handshake: about three circuit round trips before the request leaves. This keeps HTTP/1.1 connections open and reuses them:

- one pool per isolation key + scheme + host + port. A connection never carries requests for two keys, or for a keyed and an unkeyed request. Unkeyed requests to one origin may share a connection; they already shared circuits and the TLS session cache.
- A connection goes back to the pool only if its response body ended exactly at its framed end (Content-Length, or chunked with the trailer section read), the response wasn't HTTP/1.0 without `Connection: keep-alive`, and the server didn't send `Connection: close`.
- Idle at most 30 s, or just under the server's `Keep-Alive: timeout`; retired 2 min after it was opened, so a pooled connection doesn't keep an old circuit in use. At most 4 idle per key and 32 in all (the longest idle goes first); expired keys are swept, so a fresh key per request leaves nothing behind.
- A request whose reused connection was closed before any response byte arrived (the server closed it while idle, so it never read the request) is sent once more on a new connection, as browsers do (RFC 9112 §9.3.1). A timeout or a partial response is never resent, and a streamed body always gets a new connection.

Tests: `cargo test -p tor-js` 121/121, including pool tests (never across keys, idle, age and server limits, caps, sweeping) and response-framing tests.

Measured (docs/test-log.md §14, `test-artifacts/latency/ka-bench.mjs`, raw: `res-keepalive.json`): our 3 gateways, 3 interleaved rounds, fresh profile each; the stock build is hash-identical to the on-chain worker `0x5b62f358…818b`:

| | stock 0.4.4 | keep-alive |
|---|---|---|
| warm read, no key (75) | p50 827 ms, p90 1,255, mean 875 | **p50 234 ms, p90 325, mean 255** |
| warm read, isolation key (45) | p50 1,140 ms, p90 1,626, mean 1,121 | **p50 203 ms, p90 250, mean 217** |
| 20 separate parallel reads (6) | p50 2,008 ms | **p50 982 ms** |
| first read after 40 s idle (3) | p50 1,043 ms | p50 1,014 ms (new connection) |
| boot | 2.5 s | 3.0 s |
| failed reads | 0 | 0 |

Stock varies a lot with the circuit: its warm-read p50 was 0.56, 1.12 and 0.83 s in the three rounds here, and 0.78 s in an earlier run. Keep-alive stayed at 0.19–0.31 s. Against the earlier patched build (`res-keepalive-old-vs-final.json`), this one is the same on warm reads and faster on 20 parallel reads (p50 1.2 s vs 1.9 s).

## 0002-gateway-liveness-check.patch

A gateway that dies without closing its connection (crash, power, network) sends nothing, so tor-js only noticed when the WebRTC transport timed out (~20–30 s). Until then every tunnel through it hung, and so did every circuit and read on it.

- A gateway is pinged (`KpsGateway.ping()`, one `GET /metadata.json`, any status counts) only when it has gone quiet while owing us bytes: tunnel bytes were sent and nothing came back over any of its tunnels for 2 s. A gateway whose traffic flows, or that is idle, is never pinged.
- After 2 missed pings in a row (3 s each), the gateway is cooled off and `KpsGateway.reset()` drops its connection. Its tunnels close at once, and Arti rebuilds their circuits through another gateway.
- A slow target that keeps the gateway quiet costs one ping, which the live gateway answers.
- Relay choice is untouched: the same relays are reached through whichever gateway is up.
- `GatewayTiming` gains `livenessCheckMs` (0 disables), `suspectAfterMs`, `pingTimeoutMs` and `pingMisses`.

Tests: `npm run test:unit` 222/222, including 4 new liveness tests (a vanished gateway's tunnels close in < 1 s with test timings; traffic both ways means no pings; a quiet but live gateway answers its ping and keeps its tunnels; no pings when idle).

Measured (`test-artifacts/latency/fo-bench.mjs`, raw: `res-failover-patched.json`): our 3 gateways, a read every 500 ms, the busiest gateway killed twice per build.

| | stock 0.4.4 | patched (0001 + 0002) |
|---|---|---|
| failed reads per kill | 2, every time | **1, every time** |
| until reads were normal again | 17–31 s (17.4, 18.2, 18.3, 23.9, 25.0, 30.8) | **10.5–14.0 s** in 5 of 6 (10.5, 11.2, 12.5, 12.9, 14.0); once 31.5 s |
| the read in flight at the kill | failed after 10 s, and so did the next one | failed after 7.9–8.9 s; the next one was answered |
| reads afterwards | 0.5–1.6 s | 0.2–0.6 s |

Stock: 6 kills over 3 runs (raw: this run's 2 in `res-failover-patched.json`, the first run's 17.4/18.2 in its git history; the second run's file was overwritten). Patched: 6 kills over 2 runs (`res-failover-patched.json`, `res-failover-final-x4.json`).
- The 31.5 s kill: the read after the failed one took 22 s. Not explained yet; there's no worker log from that run.
- The read in flight fails because it was already sent: the server may have received it, so it isn't resent (RFC 9112 §9.3.1). The first patched build re-sent it and showed 0 failed reads, but that's unsafe for anything that isn't a read, so it's gone.

## Building

`scripts/build.sh --release` in Docker (rust 1.97.1, wasm-pack 0.14.0, binaryen 116 from npm on arm64). The unpatched tree built this way is hash-identical to the on-chain worker `0x5b62f358…818b`, so builds are reproducible here.
