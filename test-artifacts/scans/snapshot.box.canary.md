# Canary scan: https://snapshot.box/

**With Canary.** Scanned 2026-11-06T04:32:43.021Z · build `8d298afa358e` · scanner 0.1.0 (`d36f3430409d`) · canary address `0x4e05E7adEf36688fE5F6762578D0ba549D1B6187` (synthetic)

Flows: load https://snapshot.box/ → connect: clicked → connect: picked the scanner wallet in a modal → scroll

## Who received the canary address

| Recipient | Party | Kind | Requests | With address | Encodings | Declared |
|---|---|---|---|---|---|---|
| `hub.snapshot.org` | third | backend | 7 | 0 | — | — |
| `accounts.google.com` | third | backend | 1 | 0 | — | — |
| `snapshot.box` | first | analytics | 1 | 0 | — | yes |

## RPC

- JSON-RPC calls the proxy saw leave the page directly: **0** (0 containing the address)
- JSON-RPC calls answered via anon-rpc (from Canary): **2**
- Coverage: **100%** of RPC calls went through anon-rpc
- Canary's own counts: backend 4 · blocked 6 · protected 2 · latency p50 5328 ms, p95 5328 ms

Canary's own egress seen by the proxy (an anonymizing worker sends over WebRTC and never shows up here; the passthrough test worker does): extension → update.googleapis.com ×1, extension → ethereum-rpc.publicnode.com ×2, extension → content-autofill.googleapis.com ×2, extension → cdn.jsdelivr.net ×1

## Verdict

No undeclared recipients observed in 4 flow steps on build `8d298afa358e`.

Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → scroll. "No leak observed" is not "no leak".
