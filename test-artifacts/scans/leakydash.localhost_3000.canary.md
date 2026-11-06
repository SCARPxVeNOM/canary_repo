# Canary scan: http://leakydash.localhost:3000/

**With Canary.** Scanned 2026-11-05T17:35:03.459Z · build `e36522b683b8` · scanner 0.1.0 (`296015c80bdd`) · canary address `0xc224d9780633e8244FF78D4d00851De83009eeB3` (synthetic)

Flows: load http://leakydash.localhost:3000/ → connect: clicked → scroll

## Who received the canary address

| Recipient | Party | Kind | Requests | With address | Encodings | Declared |
|---|---|---|---|---|---|---|
| `leakydash.localhost` | first | backend | 1 | 1 | hex in URL | yes |

## RPC

- JSON-RPC calls the proxy saw leave the page directly: **0** (0 containing the address)
- JSON-RPC calls answered via anon-rpc (from Canary): **3**
- Coverage: **100%** of RPC calls went through anon-rpc
- Canary's own counts: blocked 3 · detected 1 · protected 3 · latency p50 44 ms, p95 45 ms

Canary's own egress seen by the proxy (an anonymizing worker sends over WebRTC and never shows up here; the passthrough test worker does): extension → 127.0.0.1 ×3, extension → rpc.provider.localhost ×1, canary-worker → 127.0.0.1 ×6

## Verdict

No undeclared recipients observed in 3 flow steps on build `e36522b683b8`.

Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → scroll. "No leak observed" is not "no leak".
