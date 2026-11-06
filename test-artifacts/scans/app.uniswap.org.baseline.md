# Canary scan: https://app.uniswap.org/

**Baseline (no Canary).** Scanned 2026-11-06T04:24:12.579Z · build `b008fb242580` · scanner 0.1.0 (`d36f3430409d`) · canary address `0x5DC514e4c5aa25f9a66C1d75A6670fEA8899E893` (synthetic)

Flows: load https://app.uniswap.org/ → connect: no connect button; the dapp already read the account (eth_accounts) → scroll

## Who received the canary address

| Recipient | Party | Kind | Requests | With address | Encodings | Declared |
|---|---|---|---|---|---|---|
| `app.uniswap.org` | first | backend | 7 | 2 | hex in body | yes |
| `entry-gateway.backend-prod.api.uniswap.org` | first | backend+rpc (eth_blockNumber, eth_getBalance, eth_call) | 17 | 1 | hex in body | yes |
| `metrics.interface.gateway.uniswap.org` | first | backend | 4 | 0 | — | yes |
| `nbstream.binance.info` | third | backend | 3 | 0 | — | — |
| `tokens.coingecko.com` | third | backend | 3 | 0 | — | — |
| `cdn.app.uniswap.org` | first | analytics | 2 | 0 | — | yes |
| `auth.privy.io` | third | backend | 2 | 0 | — | — |
| `privy.app.uniswap.org` | first | backend | 2 | 0 | — | yes |
| `raw.githubusercontent.com` | third | backend | 2 | 0 | — | — |
| `accounts.google.com` | third | backend | 1 | 0 | — | — |
| `explorer-api.walletconnect.com` | third | backend | 1 | 0 | — | — |
| `nbstream.binance.com` | third | backend | 1 | 0 | — | — |
| `nbstream.yshyqxx.com` | third | backend | 1 | 0 | — | — |
| `api.web3modal.org` | third | backend | 1 | 0 | — | — |
| `pulse.walletconnect.org` | third | analytics | 1 | 0 | — | — |

## RPC

- JSON-RPC calls the proxy saw leave the page directly: **4** (1 containing the address)
- JSON-RPC calls answered via anon-rpc (from Canary): **0**
- Coverage: **0%** of RPC calls went through anon-rpc

Canary's own egress seen by the proxy (an anonymizing worker sends over WebRTC and never shows up here; the passthrough test worker does): extension → update.googleapis.com ×2, extension → content-autofill.googleapis.com ×1

## Verdict

No undeclared recipients observed in 3 flow steps on build `b008fb242580`.

Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → scroll. "No leak observed" is not "no leak".
