# Before / after: http://leakydash.localhost:3000/

Build `e36522b683b8` → `e36522b683b8` · scanner `296015c80bdd` · each run used a fresh synthetic canary address.

| Recipient | Party | Without Canary (with address / requests) | With Canary |
|---|---|---|---|
| `tracker.localhost` | third | 3/3 | 0/0 |
| `rpc.provider.localhost` | third | 1/6 | 0/0 |
| `leakydash.localhost` | first | 1/1 | 1/1 |

| RPC | Without | With |
|---|---|---|
| Calls leaving the page directly | 3 | 0 |
| Calls via anon-rpc | 0 | 3 |
| Coverage | 0% | 100% |

Third parties that received the address: **2 → 0**.
