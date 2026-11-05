# Canary extension (enforcement)

Part 1 of Canary (idea.md §3.1). An MV3 extension that:

1. **Answers a dapp's own RPC reads through anon-rpc.** Standard read methods are *substituted*: answered by Canary's read endpoint for the same chain, so the dapp's (often keyed) provider never sees them. Other methods are *forwarded* to the dapp's URL over the anon path (IP hidden, dapp still learned).
2. **Blocks third-party requests that carry your address**, through fetch, XHR, `sendBeacon`, WebSocket frames, and (via `declarativeNetRequest`) any URL: pixels, scripts, iframes.
3. **Measures coverage per page** using the categories in idea.md §4, and shows it in the popup.

The dapp itself can always see your address and IP. Canary is about third parties.

## Build and load

```sh
npm install
npm run build          # config/live.json → dist/
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`.

Default network is **tor-js** with EF's demonstration gateway. The first boot takes ~13 s; the worker is warmed when the extension starts and stays warm in the offscreen document. Use a separate Chrome profile for testing: the extension runs on every site.

## Test

```sh
CHROME_BIN=/path/to/chromium npm test
```

`test/e2e.mjs` loads the extension into Chromium against a deliberately leaky fixture dapp on six fake domains (`*.test`, mapped to 127.0.0.1). The worker is EF's passthrough reference bundle, hash-verified exactly as on chain. Five runs: baseline, with Canary, anon path down (fail closed), "allow direct" on, protection off. 24 checks; latest output is in `test/e2e.log` and the popup screenshot in `test/out/popup.png`.

Needs the full Chromium build or Chrome for Testing: branded Chrome 137+ ignores `--load-extension`, and Playwright's headless shell has no extension support. In sandboxes that set `HTTPS_PROXY`, the test passes `--no-proxy-server` so WebSockets reach the local server.

## How it works

```
page JS ──fetch / XHR / WebSocket / sendBeacon──► shim.js (MAIN world, document_start, all frames)
   │  JSON-RPC? ─► MessagePort ─► bridge.js (ISOLATED) ─► background.js (service worker)
   │                                                      ├ standard read → read endpoint for that chain, via anon-rpc
   │                                                      ├ other method  → dapp's URL, via anon-rpc ("IP only")
   │                                                      └ anon path down → JSON-RPC error (or direct, if you allowed it)
   │  your address + third party ─► blocked (and counted)
   │  your address + first party  ─► allowed, "detected, unprotected"
   └  anything else              ─► allowed, "backend / indexer"
declarativeNetRequest session rules: third-party URLs containing your address → blocked
offscreen document → null-origin sandbox → anon-rpc worker (tor-js) → KPS gateway → Tor
```

- **Your address** is learned from the wallet (EIP-1193 `eth_accounts`/`eth_requestAccounts`, EIP-6963 announcements, `accountsChanged`), or added in the popup. Matching is exact: the 40 hex digits case-insensitively (covers checksummed, lowercase, no-`0x`, ABI-padded, URL-encoded), plus base64 of the raw bytes and of the hex string.
- **Which chain an RPC URL is on**, in order: a table of well-known providers whose URLs name the chain (Alchemy, Infura, dRPC, publicnode, …); one `eth_chainId` probe over the anon path, cached; and only if the probe fails (e.g. the provider refuses Tor), the wallet's chain, labelled in the popup as assumed. The wallet is never asked first because dapps often read chains other than the wallet's (app.ens.domains reads mainnet whatever the wallet is on).
- **Per-address isolation:** a request containing one of your addresses is sent with `anonOptions.isolationKey = "addr:<address>"`, so the network can keep different addresses unlinkable at the exit (if it supports it; ask EF whether tor-js does).
- **Fail closed:** if the anon path fails, the dapp gets a JSON-RPC error. "If the anon path is down, send directly from my IP" is a per-site opt-in, and those calls are counted as *Direct*.

## Config (`config/live.json`)

| Key | Meaning |
|---|---|
| `network` | anon-rpc worker: `specifier` (on-chain), `bootstrapRpc` (to read it), `workerConfig` (network-defined, e.g. tor-js gateways) |
| `readEndpoints` | chainId → the RPC Canary answers substituted reads from. Must accept Tor traffic (Tenderly doesn't; see test-repo.md §5) |
| `timeoutMs` | per request over the anon path |
| `matches`, `hostPermissions` | where the content scripts run |

## Shared core

`src/shared.ts` re-exports [`@canary/core`](../packages/core/) (JSON-RPC classifier, address matching, chain detection). The agent gateway and SDK use the same code; esbuild bundles it from source, so building the extension needs nothing outside `extension/`. The popup labels and the page-side `Observation` type stay here. After the switch the e2e still passes 24/24.

## Known gaps (next)

- `eth_subscribe` and other WebSocket methods that can't be substituted go out as-is and are reported "detected".
- `sendBeacon` with a Blob body can't be read synchronously → "not inspected".
- Page ↔ extension channel: the shim offers a `MessagePort` via `window.postMessage` at `document_start`, before page scripts run. Another extension's MAIN-world script could still race it. The page itself is not in the threat model.
- Registrable-domain check uses a short public-suffix list, not the full PSL.
- Service workers and WebRTC traffic from the page are not inspected.
- Canary's own ENS lookups (for the ENSv2 manifest) are part 3 and not here yet.
