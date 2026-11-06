# Before / after: https://app.ens.domains/

Build `5256f32b3c52` → `5569cd2fa907` · scanner `d36f3430409d` · each run used a fresh synthetic canary address.

| Recipient | Party | Without Canary (with address / requests) | With Canary |
|---|---|---|---|
| `lb.drpc.live` | third | 1/2 | 0/0 |
| `api.bigname.sh` | third | 1/1 | 0/0 |
| `app.ens.domains` | first | 0/3 | 0/3 |
| `accounts.google.com` | third | 0/1 | 0/1 |
| `static.cloudflareinsights.com` | third | 0/1 | 0/1 |
| `widget.intercom.io` | third | 0/1 | 0/1 |
| `api.web3modal.org` | third | 0/1 | 0/1 |
| `pulse.walletconnect.org` | third | 0/1 | 0/1 |
| `edge.ens.domains` | first | 0/1 | 0/1 |
| `mainnet.app-api.ens.domains` | first | 0/1 | 0/0 |

| RPC | Without | With |
|---|---|---|
| Calls leaving the page directly | 3 | 0 |
| Calls via anon-rpc | 0 | 3 |
| Coverage | 0% | 100% |

Third parties that received the address: **2 → 0**.
