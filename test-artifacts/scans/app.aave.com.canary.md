# Canary scan: https://app.aave.com/

**With Canary.** Scanned 2026-11-06T04:27:07.797Z · build `273ee9ea57f8` · scanner 0.1.0 (`d36f3430409d`) · canary address `0xA069d5413124f1683A2f02F2E6Fcb5f921A402f0` (synthetic)

Flows: load https://app.aave.com/ → connect: no connect button; the dapp already read the account (eth_accounts) → scroll

## Who received the canary address

| Recipient | Party | Kind | Requests | With address | Encodings | Declared |
|---|---|---|---|---|---|---|
| `app.aave.com` | first | backend+rpc (eth_call, eth_getCode) | 48 | 5 | hex in body; hex in URL | yes |
| `api.v3.aave.com` | first | backend | 9 | 3 | hex in body | yes |
| `data-api.fun.xyz` | third | backend | 6 | 0 | — | — |
| `app.family.co` | third | backend | 3 | 0 | — | — |
| `static.cloudflareinsights.com` | third | analytics | 2 | 0 | — | — |
| `sr-client-cfg.amplitude.com` | third | analytics | 2 | 0 | — | — |
| `api.merkl.xyz` | third | backend | 2 | 0 | — | — |
| `cca-lite.coinbase.com` | third | backend | 2 | 0 | — | — |
| `accounts.google.com` | third | backend | 1 | 0 | — | — |
| `sdk-cdn.fun.xyz` | third | backend | 1 | 0 | — | — |
| `api.moonpay.com` | third | backend | 1 | 0 | — | — |
| `apps.aavechan.com` | third | backend | 1 | 0 | — | — |

## RPC

- JSON-RPC calls the proxy saw leave the page directly: **11** (4 containing the address)
- JSON-RPC calls answered via anon-rpc (from Canary): **2**
- Coverage: **15%** of RPC calls went through anon-rpc
- Canary's own counts: backend 34 · blocked 9 · detected 8 · notInspected 1 · protected 2 · latency p50 2366 ms, p95 2366 ms

Canary's own egress seen by the proxy (an anonymizing worker sends over WebRTC and never shows up here; the passthrough test worker does): extension → update.googleapis.com ×1, extension → app.aave.com ×1, extension → ethereum-rpc.publicnode.com ×2, extension → cdn.jsdelivr.net ×1, extension → content-autofill.googleapis.com ×1

## Verdict

No undeclared recipients observed in 3 flow steps on build `273ee9ea57f8`.

Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → scroll. "No leak observed" is not "no leak".
