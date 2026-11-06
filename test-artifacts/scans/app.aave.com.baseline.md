# Canary scan: https://app.aave.com/

**Baseline (no Canary).** Scanned 2026-11-06T04:26:50.211Z · build `f1d35f147d22` · scanner 0.1.0 (`d36f3430409d`) · canary address `0x0Cf35Bf35c87Da773d80db191F3d1c19db309ae0` (synthetic)

Flows: load https://app.aave.com/ → connect: no connect button; the dapp already read the account (eth_accounts) → scroll

## Who received the canary address

| Recipient | Party | Kind | Requests | With address | Encodings | Declared |
|---|---|---|---|---|---|---|
| `app.aave.com` | first | backend+rpc (eth_call, eth_getCode) | 48 | 5 | hex in body; hex in URL | yes |
| `api.v3.aave.com` | first | backend | 9 | 3 | hex in body | yes |
| `browser-intake-datadoghq.com` | third | analytics | 3 | 3 | hex in body | — |
| `mainnet.gateway.tenderly.co` | third | backend+rpc (eth_call) | 4 | 2 | hex in body | — |
| `apps.aavechan.com` | third | backend | 2 | 1 | hex in URL | — |
| `data-api.fun.xyz` | third | backend | 6 | 0 | — | — |
| `app.family.co` | third | backend | 3 | 0 | — | — |
| `static.cloudflareinsights.com` | third | analytics | 2 | 0 | — | — |
| `sr-client-cfg.amplitude.com` | third | analytics | 2 | 0 | — | — |
| `api.merkl.xyz` | third | backend | 2 | 0 | — | — |
| `cca-lite.coinbase.com` | third | backend | 2 | 0 | — | — |
| `accounts.google.com` | third | backend | 1 | 0 | — | — |
| `o4508407151525888.ingest.de.sentry.io` | third | analytics | 1 | 0 | — | — |
| `sdk-cdn.fun.xyz` | third | backend | 1 | 0 | — | — |
| `api.moonpay.com` | third | backend | 1 | 0 | — | — |

## RPC

- JSON-RPC calls the proxy saw leave the page directly: **13** (6 containing the address)
- JSON-RPC calls answered via anon-rpc (from Canary): **0**
- Coverage: **0%** of RPC calls went through anon-rpc

Canary's own egress seen by the proxy (an anonymizing worker sends over WebRTC and never shows up here; the passthrough test worker does): extension → update.googleapis.com ×1, extension → content-autofill.googleapis.com ×1

## Verdict

No manifest supplied: third-party recipients above are unchecked.

Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → scroll. "No leak observed" is not "no leak".
