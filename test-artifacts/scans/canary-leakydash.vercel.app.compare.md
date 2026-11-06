# Before / after: https://canary-leakydash.vercel.app/

Build `0678454eabf8` → `0678454eabf8` · scanner `296015c80bdd` · each run used a fresh synthetic canary address.

| Recipient | Party | Without Canary (with address / requests) | With Canary |
|---|---|---|---|
| `canary-leakydash-tracker.vercel.app` | third | 3/3 | 0/0 |
| `canary-leakydash-rpc.vercel.app` | third | 1/9 | 0/0 |
| `canary-leakydash.vercel.app` | first | 1/1 | 1/1 |
| `accounts.google.com` | third | 0/1 | 0/1 |

| RPC | Without | With |
|---|---|---|
| Calls leaving the page directly | 3 | 0 |
| Calls via anon-rpc | 0 | 6 |
| Coverage | 0% | 100% |

Third parties that received the address: **2 → 0**.
