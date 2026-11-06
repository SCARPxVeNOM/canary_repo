# Canary scan: https://revoke.cash/

**With Canary.** Scanned 2026-11-06T04:27:42.207Z · build `bbba8860b01a` · scanner 0.1.0 (`d36f3430409d`) · canary address `0x571a180Ca305Fbc963a84F848fa10267d096B434` (synthetic)

Flows: load https://revoke.cash/ → connect: no connect button; the dapp already read the account (eth_accounts) → scroll

## Who received the canary address

| Recipient | Party | Kind | Requests | With address | Encodings | Declared |
|---|---|---|---|---|---|---|
| `revoke.cash` | first | backend | 30 | 4 | hex in URL; hex in body | yes |
| `auth.privy.io` | third | backend | 6 | 0 | — | — |
| `accounts.google.com` | third | backend | 1 | 0 | — | — |
| `static.cloudflareinsights.com` | third | analytics | 1 | 0 | — | — |
| `api.web3modal.org` | third | backend | 1 | 0 | — | — |
| `api-eu.mixpanel.com` | third | analytics | 1 | 0 | — | — |
| `pulse.walletconnect.org` | third | analytics | 1 | 0 | — | — |

## RPC

- JSON-RPC calls the proxy saw leave the page directly: **0** (0 containing the address)
- JSON-RPC calls answered via anon-rpc (from Canary): **2**
- Coverage: **100%** of RPC calls went through anon-rpc
- Canary's own counts: backend 27 · detected 4 · failedClosed 4 · protected 1 · protectedIpOnly 1 · latency p50 5265 ms, p95 5265 ms

Canary's own egress seen by the proxy (an anonymizing worker sends over WebRTC and never shows up here; the passthrough test worker does): extension → update.googleapis.com ×1, extension → content-autofill.googleapis.com ×2, extension → ethereum-rpc.publicnode.com ×2, extension → revoke.cash ×1, extension → cdn.jsdelivr.net ×1

## Verdict

No undeclared recipients observed in 3 flow steps on build `bbba8860b01a`.

Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → scroll. "No leak observed" is not "no leak".
