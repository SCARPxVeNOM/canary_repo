# Before / after: https://revoke.cash/

Build `46574feaf526` → `bbba8860b01a` · scanner `d36f3430409d` · each run used a fresh synthetic canary address.

| Recipient | Party | Without Canary (with address / requests) | With Canary |
|---|---|---|---|
| `revoke.cash` | first | 4/30 | 4/30 |
| `api.avax.network` | third | 1/2 | 0/0 |
| `eth-mainnet.g.alchemy.com` | third | 1/2 | 0/0 |
| `polygon-mainnet.g.alchemy.com` | third | 1/2 | 0/0 |
| `auth.privy.io` | third | 0/6 | 0/6 |
| `accounts.google.com` | third | 0/1 | 0/1 |
| `static.cloudflareinsights.com` | third | 0/1 | 0/1 |
| `api.web3modal.org` | third | 0/1 | 0/1 |
| `api-eu.mixpanel.com` | third | 0/1 | 0/1 |
| `pulse.walletconnect.org` | third | 0/1 | 0/1 |

| RPC | Without | With |
|---|---|---|
| Calls leaving the page directly | 3 | 0 |
| Calls via anon-rpc | 0 | 2 |
| Coverage | 0% | 100% |

Third parties that received the address: **3 → 0**.
