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

`test/e2e.mjs` loads the extension into Chromium against a deliberately leaky fixture dapp on six fake domains (`*.test`, mapped to 127.0.0.1). The worker is EF's passthrough reference bundle, hash-verified exactly as on chain. Five runs: baseline, with Canary, anon path down (fail closed), "allow direct" on, protection off. 32 checks, including LeakyDash's ENS manifest and verdict answered by a fake Universal Resolver on the read endpoint; latest output is in `test/e2e.log` and the popup screenshot in `test/out/popup.png`.

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
- **Which chain an RPC URL is on**, in order: a table of well-known providers whose URLs name the chain (Alchemy, Infura, dRPC, publicnode, …); one `eth_chainId` probe over the anon path, cached; and only if the probe fails (e.g. the provider refuses Tor), a chain id the URL names (`/rpc/8453`, `?chainId=10`, only if Canary has a read endpoint for it), then the wallet's chain, both labelled in the popup as assumed. Dapp proxies that refuse every probe over Tor are listed by host (`PROXY_CHAIN` in `src/shared.ts`; Uniswap's answers 401 without its Cloudflare cookies, so before this all its reads failed closed; now all 13 on /explore/tokens are protected). The wallet is never asked first because dapps often read chains other than the wallet's (app.ens.domains reads mainnet whatever the wallet is on).
- **Per-address isolation:** a request containing one of your addresses is sent with `anonOptions.isolationKey = "addr:<address>"`. tor-js (0.4.4+) puts each key on its own circuit and TLS session cache, so the exit can't link two of your addresses. Verified live: different keys left through different exits, a repeated key through the same one.
- **Fewer Tor round trips** (`src/rpc-pipeline.ts`). Each request over tor-js costs ~1 s whatever its size (a new stream, TCP and TLS through three relays), so Canary sends fewer of them:
  - *batch*: calls for the same endpoint and the same isolation key that arrive within 15 ms leave as one JSON-RPC batch (max 20). Never across keys. If an endpoint rejects batches, or drops a call from one, those calls are retried singly.
  - *cache*: `eth_chainId`/`net_version` for good (seeded from the chain Canary already resolved, so they never go out), deployed `eth_getCode` for good, `eth_blockNumber` for 2 s.
  - *dedupe*: an identical call already in flight shares its answer.
  - *pre-warm*: when the wallet reveals an address, Canary sends one `eth_blockNumber` under that address's key, so its circuit is built before the dapp's first read (first read on a new key: ~2.0 s cold vs ~1.15 s warm). Redone after ~9 min, when arti stops reusing a circuit.
  - *hedge*: if a read fails, or hasn't answered within 3 s, it goes out again on a fresh circuit (a new isolation key derived from the original, so still one address per circuit) and the first answer wins. Without it a dead gateway stalls reads until the 15 s timeout.
  - *starts at load*: the worker boots, and pre-warms, when the browser or extension starts, not on the first dapp request.
  - Writes (`eth_sendRawTransaction`, signing, anything not in `SUBSTITUTABLE`) skip all of this: the original body is forwarded byte for byte, once.
  - The popup shows "N calls sent as M anon-rpc requests".
- **Packaged Tor directory snapshot** (`"torBootstrap": true`): `build.mjs` fetches tor-js's fast-bootstrap snapshot (~1.5 MB) from a gateway and ships it in the extension, refreshed when over 3 h old. A first boot then skips downloading it (11–13 s on EF's demo gateway). It's ignored once the worker's storage holds a consensus, and not used if older than 72 h. Fetch it on its own with `npm run snapshot`.
- **Gateway:** `network.workerConfig.gateways`. EF's demo gateway is shared and unreliable (on 6 Nov it stopped completing boots); run your own from [`../gateway/`](../gateway/) and build with `config/local-gateway.json` for a laptop demo (`node build.mjs --config config/local-gateway.json --out dist-local`).
- **Declared vs observed** (`src/ens.ts`, `compareDeclared` in `@canary/core`). On each page load Canary looks for `/.well-known/canary.json` (`{"ens": "leakydash.eth"}`) on the site, then reads that name's `url` and `privacy.manifest` text records through the Universal Resolver (`resolve(name, text(node, key))`, which follows ENSv2 names to their resolver). The reads are `eth_call`s over the anon path on their own circuit (`canary:ens`), so no RPC provider learns which dapp you're on. The manifest counts only if the binding holds both ways: the site names the ENS name, and the name's `url` record (and the manifest's `origin`, if set) is the site. The popup then lists every third party the page sent your address or JSON-RPC calls to as *declared* or *not declared*, plus declared recipients not seen on the page. It also reads `privacy.verdict.canary`, an independent verifier's signed verdict (format and CLI: `packages/ens/README.md`), and shows it only if the EIP-712 signature recovers to the `addr` of the verifier name the verdict names, and the verdict is about this name and site. It then checks whether the verifier still holds its one-key role: `findResolver` gives the name's resolver, and if that has Enhanced Access Control, Canary simulates the verifier's `setText` of that key. If the simulation reverts, the popup says *independent verification revoked*. If the resolver has no EAC (an ENSv1 name behind the v1 adapter), it says the role can't be checked, never "revoked". Expired verdicts are labelled. The verdict's build hash isn't compared with the page (the scanner's fingerprint needs the raw first-party HTML/JS). Read once per origin every 10 min. Limits: lowercase ASCII names only (no ENSIP-15 normalization), and names that need an offchain (CCIP-read) lookup read as having no records. Checked against live Sepolia ENSv2 (`npm run test:ens-live`, against the deployed LeakyDash at https://canary-leakydash.vercel.app): the reader finds the manifest, the signed verdict from `verifier.canary.eth`, and the verifier's role through `leakydash.eth`'s own Permissioned Resolver, and shows the role revoked after `canary-ens revoke-verifier` (names and transactions: `packages/ens/README.md`, *Live on Sepolia*). The manifest format is LeakyDash's (`{name, origin, recipients: [{host, kind, purpose}], rpc}`).
- **Fail closed:** if the anon path fails, the dapp gets a JSON-RPC error. "If the anon path is down, send directly from my IP" is a per-site opt-in, and those calls are counted as *Direct*.

## Config (`config/live.json`)

| Key | Meaning |
|---|---|
| `network` | anon-rpc worker: `specifier` (on-chain), `bootstrapRpc` (to read it), `workerConfig` (network-defined, e.g. tor-js gateways) |
| `readEndpoints` | chainId → the RPC Canary answers substituted reads from. Must accept Tor traffic (Tenderly doesn't; see test-repo.md §5) |
| `ens` | where dapps' ENS names live: `chainId` (default 11155111, needs a `readEndpoints` entry), `universalResolver` (default `0xeeeeeeee14d718c2b47d9923deab1335e144eeee`) and `verifier` (the verdict record read, `privacy.verdict.<verifier>`, default `canary`) |
| `timeoutMs` | per request over the anon path |
| `torBootstrap` | `true`: package a tor-js directory snapshot fetched from the configured gateways at build time |
| `matches`, `hostPermissions` | where the content scripts run |

## Shared core

`src/shared.ts` re-exports [`@canary/core`](../packages/core/) (JSON-RPC classifier, address matching, chain detection). The agent gateway and SDK use the same code; esbuild bundles it from source, so building the extension needs nothing outside `extension/`. The popup labels and the page-side `Observation` type stay here. After the switch the e2e still passes 24/24.

## Known gaps (next)

- `eth_subscribe` and other WebSocket methods that can't be substituted go out as-is and are reported "detected".
- `sendBeacon` with a Blob body can't be read synchronously → "not inspected".
- Page ↔ extension channel: the shim offers a `MessagePort` via `window.postMessage` at `document_start`, before page scripts run. Another extension's MAIN-world script could still race it. The page itself is not in the threat model.
- Registrable-domain check uses a short public-suffix list, not the full PSL.
- Service workers and WebRTC traffic from the page are not inspected.
- The ENS manifest is compared, not enforced: an undeclared recipient that doesn't carry your address isn't blocked.
- Only one verifier (`ens.verifier`, default `canary`) is read, and any verifier name is shown: the popup names who signed, it doesn't keep a list of trusted verifiers.
