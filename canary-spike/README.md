# Canary spike

> **Superseded by [`../extension/`](../extension/).** Kept for reference. It was built inside a clone of `ethereum/anon-rpc` at `impl/canary-spike/` and resolves the harness from `impl/node_modules`, so it doesn't build standalone.

MV3 extension on `@anon-rpc/browser-extension-harness`. A MAIN-world shim wraps
`window.fetch`; JSON-RPC POSTs are answered by the service worker through the
anon-rpc worker instead of reaching the dapp's provider.

- Standard read methods → **substituted**: sent to our read endpoint for the same chain (learned once with `eth_chainId` over the anon path).
- Other methods → **forwarded** to the dapp's URL over the anon path (IP hidden, dapp learned).
- Anon path down → **fail closed** (JSON-RPC error, never a direct request).

Build (inside `anon-rpc/impl/`, after `npm ci && npm run build --workspaces`):

    cd canary-spike && npm i && node build.mjs live.config.json dist-live

Offline e2e (local stub chain, passthrough worker, viem dapp, baseline vs Canary):

    CHROME_BIN=/path/to/chromium node test/e2e-offline.mjs

Not done yet: XHR / WebSocket / sendBeacon, third-party blocking, popup, isolationKey per address.
