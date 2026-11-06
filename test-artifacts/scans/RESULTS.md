| Dapp | Third parties that got the address | RPC calls leaving the page directly | via anon-rpc | Coverage | Blocked | First-party requests with the address | Failed closed | anon-rpc latency p50 |
|---|---|---|---|---|---|---|---|---|
| app.aave.com | 3 → **0** | 13 → **11** | 2 | 0% → **15%** | 9 | 8 → 8 | 0 | 2366 ms (n=2) |
| app.ens.domains | 2 → **0** | 3 → **0** | 3 | 0% → **100%** | 2 | 0 → 0 | 0 | 3630 ms (n=1) |
| app.uniswap.org | 0 → **0** | 4 → **0** | 6 | 0% → **100%** | 0 | 3 → 3 | 0 | 835 ms (n=5) |
| revoke.cash | 3 → **0** | 3 → **0** | 2 | 0% → **100%** | 0 | 4 → 4 | 4 | 5265 ms (n=2) |
| snapshot.box | 4 → **0** | 2 → **0** | 2 | 0% → **100%** | 6 | 0 → 0 | 0 | 5328 ms (n=2) |

Before → **with Canary**. Each run used a fresh synthetic address. Blocked, failed closed and latency are Canary's own counts from the with-Canary run.

- **app.aave.com**: before, the address reached `browser-intake-datadoghq.com`, `mainnet.gateway.tenderly.co`, `apps.aavechan.com`. Flows: connect: no connect button; the dapp already read the account (eth_accounts) → scroll. Canary noted: unreadable body.
- **app.ens.domains**: before, the address reached `lb.drpc.live`, `api.bigname.sh`. Flows: connect: no connect button; the dapp already read the account (eth_accounts) → scroll.
- **app.uniswap.org**: before, the address reached no third party. Flows: connect: no connect button; the dapp already read the account (eth_accounts) → scroll.
- **revoke.cash**: before, the address reached `api.avax.network`, `eth-mainnet.g.alchemy.com`, `polygon-mainnet.g.alchemy.com`. Flows: connect: no connect button; the dapp already read the account (eth_accounts) → scroll. Canary noted: anon path failed: HTTP 403 from polygon-mainnet.g.alchemy.com; no read endpoint configured for chain 43114; forwarded instead.
- **snapshot.box**: before, the address reached `hub.snapshot.org`, `rpc.brovider.xyz`, `stamp.fyi`, `cdn.stamp.fyi`. Flows: connect: clicked → connect: picked the scanner wallet in a modal → scroll.

Scanner `d36f3430409d`. Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → scroll. "No leak observed" is not "no leak".
