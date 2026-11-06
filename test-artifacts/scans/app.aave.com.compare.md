# Before / after: https://app.aave.com/

Build `f1d35f147d22` → `273ee9ea57f8` · scanner `d36f3430409d` · each run used a fresh synthetic canary address.

| Recipient | Party | Without Canary (with address / requests) | With Canary |
|---|---|---|---|
| `app.aave.com` | first | 5/48 | 5/48 |
| `api.v3.aave.com` | first | 3/9 | 3/9 |
| `browser-intake-datadoghq.com` | third | 3/3 | 0/0 |
| `mainnet.gateway.tenderly.co` | third | 2/4 | 0/0 |
| `apps.aavechan.com` | third | 1/2 | 0/1 |
| `data-api.fun.xyz` | third | 0/6 | 0/6 |
| `app.family.co` | third | 0/3 | 0/3 |
| `static.cloudflareinsights.com` | third | 0/2 | 0/2 |
| `sr-client-cfg.amplitude.com` | third | 0/2 | 0/2 |
| `api.merkl.xyz` | third | 0/2 | 0/2 |
| `cca-lite.coinbase.com` | third | 0/2 | 0/2 |
| `accounts.google.com` | third | 0/1 | 0/1 |
| `o4508407151525888.ingest.de.sentry.io` | third | 0/1 | 0/0 |
| `sdk-cdn.fun.xyz` | third | 0/1 | 0/1 |
| `api.moonpay.com` | third | 0/1 | 0/1 |

| RPC | Without | With |
|---|---|---|
| Calls leaving the page directly | 13 | 11 |
| Calls via anon-rpc | 0 | 2 |
| Coverage | 0% | 15% |

Third parties that received the address: **3 → 0**.
