### anon-rpc bench — n=8 per arm

`eth_getBalance` on `0x00000000219ab540356cBB839Cbe05303d7705Fa` via `ethereum-rpc.publicnode.com`.

| arm | bootstrap | p50 | p90 | p99 | discarded |
|---|---|---|---|---|---|
| direct | — | 220ms | 294ms | 294ms | 0 |
| passthrough | 1517ms | 399ms | 522ms | 522ms | 0 |
| tor-js | 13022ms | 1531ms | 1995ms | 1995ms | 0 |
| nym | 65809ms | 824ms | 6314ms | 6314ms | 0 |
| nox | **did not boot** — short bytes32 return | — | — | — | 0 |

An arm that did not boot is a result, not a broken run: whether a worker comes
up at all is part of what this measures, and the schedule is what makes that
visible over time.

Bootstrap is one sample per arm and varies widely between runs — treat it as
indicative, not a measurement. Bandwidth is not measured: tor-js's bytes ride a
WebRTC data channel and need counters in the KPS gateway.
