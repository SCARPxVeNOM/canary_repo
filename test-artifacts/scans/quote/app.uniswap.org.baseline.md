# Canary scan: https://app.uniswap.org/swap?chain=mainnet&inputCurrency=ETH&outputCurrency=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48

**Baseline (no Canary).** Scanned 2026-11-06T10:23:46.011Z · build `cac3dc07a9ea` · scanner 0.1.0 (`6f23dc32b0a4`) · canary address `0xA683CdaA4cCfeF93863dDa136BD6554f33e6d4b8` (synthetic)

Flows: load https://app.uniswap.org/swap?chain=mainnet&inputCurrency=ETH&outputCurrency=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 → connect: no connect button; the dapp already read the account (eth_accounts) → quote: typed 1 into the amount field → scroll

## Who received the canary address

| Recipient | Party | Kind | Requests | With address | Encodings | Declared |
|---|---|---|---|---|---|---|
| `entry-gateway.backend-prod.api.uniswap.org` | first | backend+rpc (eth_blockNumber, eth_call, eth_getBalance, eth_chainId) | 124 | 31 | hex in body | yes |
| `app.uniswap.org` | first | backend | 8 | 2 | hex in body | yes |
| `metrics.interface.gateway.uniswap.org` | first | backend | 7 | 0 | — | yes |
| `cdn.app.uniswap.org` | first | analytics+backend | 3 | 0 | — | yes |
| `nbstream.binance.com` | third | backend | 3 | 0 | — | — |
| `auth.privy.io` | third | backend | 2 | 0 | — | — |
| `privy.app.uniswap.org` | first | backend | 2 | 0 | — | yes |
| `raw.githubusercontent.com` | third | backend | 2 | 0 | — | — |
| `accounts.google.com` | third | backend | 1 | 0 | — | — |
| `explorer-api.walletconnect.com` | third | backend | 1 | 0 | — | — |
| `nbstream.binance.info` | third | backend | 1 | 0 | — | — |
| `api.web3modal.org` | third | backend | 1 | 0 | — | — |
| `nbstream.yshyqxx.com` | third | backend | 1 | 0 | — | — |
| `pulse.walletconnect.org` | third | analytics | 1 | 0 | — | — |

## RPC

- JSON-RPC calls the proxy saw leave the page directly: **25** (8 containing the address)
- JSON-RPC calls answered via anon-rpc (from Canary): **0**
- Coverage: **0%** of RPC calls went through anon-rpc

Canary's own egress seen by the proxy (an anonymizing worker sends over WebRTC and never shows up here; the passthrough test worker does): extension → update.googleapis.com ×1, extension → content-autofill.googleapis.com ×1

## Verdict

No undeclared recipients observed in 4 flow steps on build `cac3dc07a9ea`.

Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → quote → scroll. "No leak observed" is not "no leak".
