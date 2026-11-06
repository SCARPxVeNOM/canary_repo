# tor-js patches

Changes to [ethereum/tor-js](https://github.com/ethereum/tor-js) that Canary wants upstream. They can't be shipped from here: the anon-rpc worker is pinned on chain by its keccak256, so a modified tor-js is a different worker. They need to land in tor-js (and a new worker be registered), or run under a specifier we publish.

Both apply cleanly to v0.4.4 (`git apply`), in either order.

## 0001-http-keep-alive.patch

tor-js sends `Connection: close`, so every request pays for a new Tor stream, TCP from the exit and a TLS handshake. This keeps HTTP/1.1 connections open and reuses them:

- one pool per isolation key + scheme + host + port: a connection never carries requests for two keys;
- reused only if the response length was framed (Content-Length or chunked) and the server didn't send `Connection: close`;
- idle connections dropped after 30 s, and any connection after 10 min (Arti's circuit rotation), at most 4 idle per key;
- a request on a reused connection that got no response bytes at all is sent once more on a new connection (the server closed it while idle); streamed bodies never use a pooled connection.

Tests: `cargo test -p tor-js` 118/118, including pool and header tests.

Measured (test-repo.md §14, `test-artifacts/latency/ka-bench.mjs`): same gateways, 3 interleaved rounds, the stock build hash-identical to the on-chain worker `0x5b62f358…818b`:

| | stock 0.4.4 | keep-alive |
|---|---|---|
| warm read, no key (75) | p50 775 ms, mean 794 | **p50 252 ms, mean 259** |
| warm read, isolation key (45) | p50 921 ms, mean 1,090 | **p50 262 ms, mean 291** |
| first read after 40 s idle | p50 832 ms | p50 985 ms (new connection) |
| 20 separate parallel reads | p50 1,250 ms | p50 1,478 ms |
| boot | 2.46 s | 2.49 s |
| failed reads | 0 | 0 |


## 0002-gateway-liveness-check.patch

A gateway that dies without closing its connection (crash, power, network) sends nothing, so tor-js only noticed when the WebRTC transport timed out (~20–30 s). Until then, every tunnel through that gateway hung, and so did every circuit and read on it.

- `ArtiSocketProvider` now checks a gateway that carries tunnels every 1.5 s with a one-round-trip `KpsGateway.ping()` (a `GET /metadata.json`, any status counts).
- After 2 misses in a row (3 s deadline each), the gateway is cooled off and `KpsGateway.reset()` drops its connection. Its tunnels close at once, and Arti rebuilds their circuits through another gateway.
- The thresholds are generous on purpose: dropping a slow but working gateway tears down every circuit through it.
- Relay choice is untouched: the same relays are reached through whichever gateway is up.
- There are no checks while a gateway carries no tunnels.

Tests: `npm run test:unit` 221/221, including 3 new liveness tests (a vanished gateway's tunnels close in < 1 s with test timings; a healthy gateway keeps its tunnels and isn't redialled; checks stop when idle).

Measured (`test-artifacts/latency/fo-bench.mjs`, 3 own gateways, a read every 500 ms, the busiest gateway killed twice per build):

| | stock 0.4.4 | patched (0001 + 0002) |
|---|---|---|
| failed reads per kill | 2, 2 | **0, 0** |
| until reads were normal again | 17.4 s, 18.2 s | **12.5 s, 10.0 s** |
| the read in flight at the kill | failed after 10 s, the next one too | answered after 11.6 s, 8.5 s |
| reads afterwards | 0.5–1.6 s | 0.23–0.55 s |

## Building

`scripts/build.sh --release` in Docker (rust 1.97.1, wasm-pack 0.14.0, binaryen 116 from npm on arm64). The unpatched tree built this way is hash-identical to the on-chain worker `0x5b62f358…818b`, so builds are reproducible here.
