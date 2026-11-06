# Canary scan: https://app.ens.domains/

**With Canary.** Scanned 2026-11-06T03:05:44.955Z · build `5569cd2fa907` · scanner 0.1.0 (`d36f3430409d`) · canary address `0x783585A4DBE03f050D7c9d1D76FF168E9631CFa6` (synthetic)

Flows: load https://app.ens.domains/ → connect: no connect button; the dapp already read the account (eth_accounts) → scroll

## Who received the canary address

| Recipient | Party | Kind | Requests | With address | Encodings | Declared |
|---|---|---|---|---|---|---|
| `app.ens.domains` | first | analytics+backend | 3 | 0 | — | yes |
| `accounts.google.com` | third | backend | 1 | 0 | — | — |
| `static.cloudflareinsights.com` | third | analytics | 1 | 0 | — | — |
| `api.web3modal.org` | third | backend | 1 | 0 | — | — |
| `pulse.walletconnect.org` | third | analytics | 1 | 0 | — | — |
| `widget.intercom.io` | third | analytics | 1 | 0 | — | — |
| `edge.ens.domains` | first | backend | 1 | 0 | — | yes |

## RPC

- JSON-RPC calls the proxy saw leave the page directly: **0** (0 containing the address)
- JSON-RPC calls answered via anon-rpc (from Canary): **3**
- Coverage: **100%** of RPC calls went through anon-rpc
- Canary's own counts: backend 5 · blocked 2 · protected 3 · latency p50 3630 ms, p95 3630 ms

Canary's own egress seen by the proxy (an anonymizing worker sends over WebRTC and never shows up here; the passthrough test worker does): extension → update.googleapis.com ×1, extension → app.ens.domains ×1, extension → content-autofill.googleapis.com ×2, extension → ethereum-rpc.publicnode.com ×2, extension → cdn.jsdelivr.net ×1

## Verdict

No undeclared recipients observed in 3 flow steps on build `5569cd2fa907`.

Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → scroll. "No leak observed" is not "no leak".
