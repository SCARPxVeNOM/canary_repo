# Canary scan: https://canary-swap.vercel.app/

**Baseline (no Canary).** Scanned 2026-11-06T10:53:25.179Z · build `c1f1b8e5427e` · scanner 0.1.0 (`6f23dc32b0a4`) · canary address `0x1F60F9ce39eFA18E646E5908c28cB77b51e91241` (synthetic)

Flows: load https://canary-swap.vercel.app/ → connect: clicked → quote: typed 0.0001 into the amount field → scroll

## Who received the canary address

| Recipient | Party | Kind | Requests | With address | Encodings | Declared |
|---|---|---|---|---|---|---|
| `ethereum-sepolia-rpc.publicnode.com` | third | backend+rpc (eth_call, eth_getBalance) | 7 | 2 | hex in body | yes |
| `accounts.google.com` | third | backend | 1 | 0 | — | **no** |

## RPC

- JSON-RPC calls the proxy saw leave the page directly: **5** (2 containing the address)
- JSON-RPC calls answered via anon-rpc (from Canary): **0**
- Coverage: **0%** of RPC calls went through anon-rpc

Canary's own egress seen by the proxy (an anonymizing worker sends over WebRTC and never shows up here; the passthrough test worker does): extension → update.googleapis.com ×1, extension → content-autofill.googleapis.com ×2

## Verdict

No undeclared recipients observed in 4 flow steps on build `c1f1b8e5427e`.

Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → quote → scroll. "No leak observed" is not "no leak".
