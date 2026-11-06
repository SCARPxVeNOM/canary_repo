# Canary scan: https://revoke.cash/

**Baseline (no Canary).** Scanned 2026-11-06T04:27:25.027Z · build `46574feaf526` · scanner 0.1.0 (`d36f3430409d`) · canary address `0x2a5A283aAf98Aa19787e1d63FB83e53cd46C8D38` (synthetic)

Flows: load https://revoke.cash/ → connect: no connect button; the dapp already read the account (eth_accounts) → scroll

## Who received the canary address

| Recipient | Party | Kind | Requests | With address | Encodings | Declared |
|---|---|---|---|---|---|---|
| `revoke.cash` | first | backend | 30 | 4 | hex in URL; hex in body | yes |
| `api.avax.network` | third | backend+rpc (eth_call) | 2 | 1 | hex in body | — |
| `eth-mainnet.g.alchemy.com` | third | backend+rpc (eth_call) | 2 | 1 | hex in body | — |
| `polygon-mainnet.g.alchemy.com` | third | backend+rpc (eth_call) | 2 | 1 | hex in body | — |
| `auth.privy.io` | third | backend | 6 | 0 | — | — |
| `accounts.google.com` | third | backend | 1 | 0 | — | — |
| `static.cloudflareinsights.com` | third | analytics | 1 | 0 | — | — |
| `api.web3modal.org` | third | backend | 1 | 0 | — | — |
| `api-eu.mixpanel.com` | third | analytics | 1 | 0 | — | — |
| `pulse.walletconnect.org` | third | analytics | 1 | 0 | — | — |

## RPC

- JSON-RPC calls the proxy saw leave the page directly: **3** (3 containing the address)
- JSON-RPC calls answered via anon-rpc (from Canary): **0**
- Coverage: **0%** of RPC calls went through anon-rpc

Canary's own egress seen by the proxy (an anonymizing worker sends over WebRTC and never shows up here; the passthrough test worker does): extension → update.googleapis.com ×1, extension → content-autofill.googleapis.com ×2

## Verdict

No manifest supplied: third-party recipients above are unchecked.

Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → scroll. "No leak observed" is not "no leak".
