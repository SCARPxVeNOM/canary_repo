# Canary scan: https://snapshot.box/

**Baseline (no Canary).** Scanned 2026-11-06T04:32:22.706Z · build `8d298afa358e` · scanner 0.1.0 (`d36f3430409d`) · canary address `0xbE1B7bC2A611c58C7DD031565A7ca64633C0eF3a` (synthetic)

Flows: load https://snapshot.box/ → connect: clicked → connect: picked the scanner wallet in a modal → scroll

## Who received the canary address

| Recipient | Party | Kind | Requests | With address | Encodings | Declared |
|---|---|---|---|---|---|---|
| `hub.snapshot.org` | third | backend | 9 | 2 | hex in body | — |
| `rpc.brovider.xyz` | third | backend+rpc (eth_blockNumber, eth_getCode) | 4 | 1 | hex in body | — |
| `stamp.fyi` | third | backend | 2 | 1 | hex in body | — |
| `cdn.stamp.fyi` | third | backend | 1 | 1 | hex in URL | — |
| `accounts.google.com` | third | backend | 1 | 0 | — | — |
| `snapshot.box` | first | analytics | 1 | 0 | — | yes |

## RPC

- JSON-RPC calls the proxy saw leave the page directly: **2** (1 containing the address)
- JSON-RPC calls answered via anon-rpc (from Canary): **0**
- Coverage: **0%** of RPC calls went through anon-rpc

Canary's own egress seen by the proxy (an anonymizing worker sends over WebRTC and never shows up here; the passthrough test worker does): extension → update.googleapis.com ×1, extension → content-autofill.googleapis.com ×2

## Verdict

No manifest supplied: third-party recipients above are unchecked.

Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → scroll. "No leak observed" is not "no leak".
