# Canary scan: https://app.ens.domains/

**Baseline (no Canary).** Scanned 2026-11-06T03:05:27.354Z · build `5256f32b3c52` · scanner 0.1.0 (`d36f3430409d`) · canary address `0x323db7a889BCfC41b3B018CEAb0228A4b31DfFbF` (synthetic)

Flows: load https://app.ens.domains/ → connect: clicked → scroll

## Who received the canary address

| Recipient | Party | Kind | Requests | With address | Encodings | Declared |
|---|---|---|---|---|---|---|
| `lb.drpc.live` | third | backend+rpc (eth_getCode, eth_call) | 2 | 1 | hex in body | — |
| `api.bigname.sh` | third | backend | 1 | 1 | hex in URL | — |
| `app.ens.domains` | first | analytics+backend | 3 | 0 | — | yes |
| `accounts.google.com` | third | backend | 1 | 0 | — | — |
| `static.cloudflareinsights.com` | third | analytics | 1 | 0 | — | — |
| `widget.intercom.io` | third | analytics | 1 | 0 | — | — |
| `api.web3modal.org` | third | backend | 1 | 0 | — | — |
| `pulse.walletconnect.org` | third | analytics | 1 | 0 | — | — |
| `edge.ens.domains` | first | backend | 1 | 0 | — | yes |
| `mainnet.app-api.ens.domains` | first | backend | 1 | 0 | — | yes |

## RPC

- JSON-RPC calls the proxy saw leave the page directly: **3** (3 containing the address)
- JSON-RPC calls answered via anon-rpc (from Canary): **0**
- Coverage: **0%** of RPC calls went through anon-rpc

Canary's own egress seen by the proxy (an anonymizing worker sends over WebRTC and never shows up here; the passthrough test worker does): extension → update.googleapis.com ×1, extension → content-autofill.googleapis.com ×2

## Verdict

No manifest supplied: third-party recipients above are unchecked.

Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → scroll. "No leak observed" is not "no leak".
