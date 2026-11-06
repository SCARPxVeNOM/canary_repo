# Canary scan: https://canary-leakydash.vercel.app/

**With Canary.** Scanned 2026-11-06T02:44:15.852Z · build `0678454eabf8` · scanner 0.1.0 (`296015c80bdd`) · canary address `0x5d5e09Da0DA0A70475d232033e6c2a0aCa03e3fF` (synthetic)

Flows: load https://canary-leakydash.vercel.app/ → connect: clicked → scroll

## Who received the canary address

| Recipient | Party | Kind | Requests | With address | Encodings | Declared |
|---|---|---|---|---|---|---|
| `canary-leakydash.vercel.app` | first | backend | 1 | 1 | hex in URL | yes |
| `accounts.google.com` | third | backend | 1 | 0 | — | **no** |

## RPC

- JSON-RPC calls the proxy saw leave the page directly: **0** (0 containing the address)
- JSON-RPC calls answered via anon-rpc (from Canary): **6**
- Coverage: **100%** of RPC calls went through anon-rpc
- Canary's own counts: blocked 3 · detected 1 · protected 6 · latency p50 2112 ms, p95 2305 ms

Canary's own egress seen by the proxy (an anonymizing worker sends over WebRTC and never shows up here; the passthrough test worker does): extension → update.googleapis.com ×1, extension → ethereum-rpc.publicnode.com ×2, extension → canary-leakydash.vercel.app ×1, extension → cdn.jsdelivr.net ×1, extension → content-autofill.googleapis.com ×2

## Verdict

No undeclared recipients observed in 3 flow steps on build `0678454eabf8`.

Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → scroll. "No leak observed" is not "no leak".
