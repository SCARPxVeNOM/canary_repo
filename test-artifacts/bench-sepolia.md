### anon-rpc bench — n=5 per arm

`eth_getBalance` on `0x00000000219ab540356cBB839Cbe05303d7705Fa` via `ethereum-sepolia-rpc.publicnode.com`.

| arm | bootstrap | p50 | p90 | p99 | discarded |
|---|---|---|---|---|---|
| direct | — | 235ms | 349ms | 349ms | 0 |
| passthrough | **did not boot** — short bytes32 return | — | — | — | 0 |
| tor-js | **did not boot** — short bytes32 return | — | — | — | 0 |
| nym | **did not boot** — short bytes32 return | — | — | — | 0 |
| nox | 3738ms | 1242ms | 1590ms | 1590ms | 0 |

An arm that did not boot is a result, not a broken run: whether a worker comes
up at all is part of what this measures, and the schedule is what makes that
visible over time.

Bootstrap is one sample per arm and varies widely between runs — treat it as
indicative, not a measurement. Bandwidth is not measured: tor-js's bytes ride a
WebRTC data channel and need counters in the KPS gateway.
