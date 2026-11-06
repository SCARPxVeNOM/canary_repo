# Canary scan: http://leakydash.localhost:3000/

**Baseline (no Canary).** Scanned 2026-11-05T17:34:46.891Z · build `e36522b683b8` · scanner 0.1.0 (`296015c80bdd`) · canary address `0x2C77B313AF2C99c70e753337e6c142FF20fe1886` (synthetic)

Flows: load http://leakydash.localhost:3000/ → connect: clicked → scroll

## Who received the canary address

| Recipient | Party | Kind | Requests | With address | Encodings | Declared |
|---|---|---|---|---|---|---|
| `tracker.localhost` | third | analytics | 3 | 3 | hex in body; base64(raw) in body; hex in URL | **no** |
| `rpc.provider.localhost` | third | backend+rpc (eth_call, eth_blockNumber, eth_gasPrice) | 6 | 1 | hex in body | yes |
| `leakydash.localhost` | first | backend | 1 | 1 | hex in URL | yes |

## RPC

- JSON-RPC calls the proxy saw leave the page directly: **3** (1 containing the address)
- JSON-RPC calls answered via anon-rpc (from Canary): **0**
- Coverage: **0%** of RPC calls went through anon-rpc

## Verdict

Undeclared recipients of the address observed: `tracker.localhost`.

Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → scroll. "No leak observed" is not "no leak".
