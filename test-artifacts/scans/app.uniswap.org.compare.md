# Before / after: https://app.uniswap.org/

Build `b008fb242580` → `c1b3ae2bf641` · scanner `d36f3430409d` · each run used a fresh synthetic canary address.

| Recipient | Party | Without Canary (with address / requests) | With Canary |
|---|---|---|---|
| `app.uniswap.org` | first | 2/7 | 2/7 |
| `entry-gateway.backend-prod.api.uniswap.org` | first | 1/17 | 0/12 |
| `metrics.interface.gateway.uniswap.org` | first | 0/4 | 1/5 |
| `nbstream.binance.info` | third | 0/3 | 0/3 |
| `tokens.coingecko.com` | third | 0/3 | 0/3 |
| `cdn.app.uniswap.org` | first | 0/2 | 0/2 |
| `auth.privy.io` | third | 0/2 | 0/2 |
| `privy.app.uniswap.org` | first | 0/2 | 0/2 |
| `raw.githubusercontent.com` | third | 0/2 | 0/2 |
| `accounts.google.com` | third | 0/1 | 0/1 |
| `explorer-api.walletconnect.com` | third | 0/1 | 0/1 |
| `nbstream.binance.com` | third | 0/1 | 0/1 |
| `nbstream.yshyqxx.com` | third | 0/1 | 0/1 |
| `api.web3modal.org` | third | 0/1 | 0/1 |
| `pulse.walletconnect.org` | third | 0/1 | 0/1 |

| RPC | Without | With |
|---|---|---|
| Calls leaving the page directly | 4 | 0 |
| Calls via anon-rpc | 0 | 6 |
| Coverage | 0% | 100% |

Third parties that received the address: **0 → 0**.
