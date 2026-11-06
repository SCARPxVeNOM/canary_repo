# Canary scan: https://canary-leakydash.vercel.app/

**Baseline (no Canary).** Scanned 2026-11-06T02:43:43.480Z · build `0678454eabf8` · scanner 0.1.0 (`296015c80bdd`) · canary address `0x2cb73C35206b5d4082711468e065f70CaCdeb834` (synthetic)

Flows: load https://canary-leakydash.vercel.app/ → connect: clicked → scroll

## Who received the canary address

| Recipient | Party | Kind | Requests | With address | Encodings | Declared |
|---|---|---|---|---|---|---|
| `canary-leakydash-tracker.vercel.app` | third | analytics | 3 | 3 | hex in body; hex in URL; base64(raw) in body; base64url(raw) in body | **no** |
| `canary-leakydash-rpc.vercel.app` | third | backend+rpc (eth_blockNumber, eth_call, eth_gasPrice) | 9 | 1 | hex in body | yes |
| `canary-leakydash.vercel.app` | first | backend | 1 | 1 | hex in URL | yes |
| `accounts.google.com` | third | backend | 1 | 0 | — | **no** |

## RPC

- JSON-RPC calls the proxy saw leave the page directly: **3** (1 containing the address)
- JSON-RPC calls answered via anon-rpc (from Canary): **0**
- Coverage: **0%** of RPC calls went through anon-rpc

Canary's own egress seen by the proxy (an anonymizing worker sends over WebRTC and never shows up here; the passthrough test worker does): extension → update.googleapis.com ×1, extension → content-autofill.googleapis.com ×2

## Verdict

Undeclared recipients of the address observed: `canary-leakydash-tracker.vercel.app`.

Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → scroll. "No leak observed" is not "no leak".
