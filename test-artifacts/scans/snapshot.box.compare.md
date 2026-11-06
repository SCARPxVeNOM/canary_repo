# Before / after: https://snapshot.box/

Build `8d298afa358e` → `8d298afa358e` · scanner `d36f3430409d` · each run used a fresh synthetic canary address.

| Recipient | Party | Without Canary (with address / requests) | With Canary |
|---|---|---|---|
| `hub.snapshot.org` | third | 2/9 | 0/7 |
| `rpc.brovider.xyz` | third | 1/4 | 0/0 |
| `stamp.fyi` | third | 1/2 | 0/0 |
| `cdn.stamp.fyi` | third | 1/1 | 0/0 |
| `accounts.google.com` | third | 0/1 | 0/1 |
| `snapshot.box` | first | 0/1 | 0/1 |

| RPC | Without | With |
|---|---|---|
| Calls leaving the page directly | 2 | 0 |
| Calls via anon-rpc | 0 | 2 |
| Coverage | 0% | 100% |

Third parties that received the address: **4 → 0**.
