# Canary extension (enforcement)

Part 1 of Canary (docs/design-notes.md §3.1). An MV3 extension that:

1. **Answers a dapp's own RPC reads through anon-rpc.** Standard read methods are *substituted*: answered by Canary's read endpoint for the same chain, so the dapp's (often keyed) provider never sees them. Other methods are *forwarded* to the dapp's URL over the anon path (IP hidden, dapp still learned).
2. **Blocks third-party requests that carry your address**, through fetch, XHR, `sendBeacon`, WebSocket frames, and (via `declarativeNetRequest`) any URL: pixels, scripts, iframes.
3. **Measures coverage per page** using the categories in docs/design-notes.md §4, and shows it in the popup and the dashboard.
4. **Shows each site's privacy label** before you trust it with your address: the site's own ENS manifest, or, for a site that publishes none, Canary's signed label on ENS (`<host>.labels.canary.eth`). In the popup, and on the page the moment it gets your address.

The dapp itself can always see your address and IP. Canary is about third parties.

## Popup and dashboard

Both are React with [HeroUI](https://heroui.com) v3 components and Tailwind v4 (`src/ui/`), bundled by `build.mjs` into `popup.js`, `dashboard.js` and one `ui.css`. Text is set in Instrument Sans, code in JetBrains Mono; both are packaged in `fonts/`, nothing is fetched.

People get four outcomes instead of nine categories (`src/ui/model.ts`):

| Outcome | Categories | Means |
|---|---|---|
| Protected | `protected` | answered over anon-rpc by Canary's read endpoint; the dapp's provider never got it |
| Partial | `protectedIpOnly` | sent to the dapp's provider over anon-rpc: it saw the request, not your IP |
| Blocked | `blocked`, `failedClosed` | stopped in the browser, or held back while anon-rpc was down |
| Exposed | `detected`, `direct` | went out with your address in it, or from your IP |

`notInspected` is shown apart ("not assumed safe"), and `backend` / `localNode` as requests that carried none of your addresses.

- **Popup:** Overview (a one-line answer; four summary rows: reads via anon-rpc, third-party leaks blocked, what ENS says about the site, coverage; the site's privacy label; "N of M observed requests protected or blocked", the bar), Activity (every request, latest first, with filter chips; each expands to one plain sentence, a receipt and its technical evidence), Manifest (declared vs observed, the verifier's verdict, *Block undeclared recipients*).
- **Privacy label** (`src/privacy-label.ts`, the same words in the popup, the dashboard and the notice): who gets your address on this site, and from where Canary knows. Three sources, in order: the site's own manifest (`ok`, with the verifier's findings beyond it); Canary's label for a site that names no ENS name (below); or "No privacy label for this site yet". Before the page has your address the headline says *Before you connect*.
- **Connect notice** (`src/notice.ts`): the first time a page gets your address (connect, or `eth_accounts` on load), the top frame shows the label in a small notice (shadow DOM, text nodes only, top right, hides after 12 s, dismissible). Once per site per browser session, only with protection on, and it can be turned off in Settings. The page can see or remove it, like everything in its DOM.
- **Receipts** ("What each side saw", `receiptsOf` in `src/ui/model.ts`): each request's parties, and what each got without Canary and with it. A blocked tracker request shows the request around your address (`“…/xhr wallet=0x5ca1…”`), and that the tracker got nothing; a substituted read shows the call (`eth_getBalance("0x5ca1…","latest")`), that the dapp's provider got nothing, and that Canary's read endpoint (named) got it from a Tor exit with `Origin: null`; a forwarded call notes that the URL is unchanged, so an API key in it can still name the dapp.
- **Dashboard** (`dashboard.html`, from *Open dashboard*): Overview with what Canary did on the page, Activity with sessions, technical evidence by destination, a before/after worked out from the session, and JSON export; the ENS manifest page; Settings.
- **Block undeclared recipients** adds the hosts to the site's `blockHosts`: the shim refuses requests to them and a `declarativeNetRequest` rule catches the rest (pixels, scripts, frames), for that site only. Undone from the manifest page or Settings.
- **History:** a page's numbers and its latest 150 observations, with their receipts, are archived when the tab leaves the page or closes (`chrome.storage.local`, this device only, kept 1–90 days, default 30).

## Build and load

```sh
npm install
npm run build          # config/live.json → dist/
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`.

Default network is **tor-js** through our three public gateways (see *Gateway* below), so a build works on any machine. The first boot takes ~13 s; the worker is warmed when the extension starts and stays warm in the offscreen document. Use a separate Chrome profile for testing: the extension runs on every site.

## Test

```sh
CHROME_BIN=/path/to/chromium npm test
```

`test/e2e.mjs` loads the extension into Chromium against a deliberately leaky fixture dapp on nine fake domains (`*.test`, mapped to 127.0.0.1). The worker is EF's passthrough reference bundle, hash-verified exactly as on chain. Seven runs: baseline, with Canary, anon path down (fail closed), "allow direct" on, protection off, undeclared recipient blocked, and a site with no manifest that has Canary's label. 53 checks, including two RPC endpoints that refuse Tor (the dapp's own, whose chain the page asks; a third party's, held back), LeakyDash's ENS manifest and verdict and the label, answered by a fake Universal Resolver on the read endpoint; the connect notice (shown once per site); receipts; and the popup's and dashboard's Overview, Activity and Manifest views. Latest output is in `test/e2e.log` and screenshots in `test/out/`.

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
- **Which chain an RPC URL is on**, in order: a table of well-known providers whose URLs name the chain (Alchemy, Infura, dRPC, publicnode, …); one `eth_chainId` probe over the anon path, cached (a failed one isn't retried for 10 min); for the dapp's own endpoint (same site as the page), the same `eth_chainId` sent by the page itself with its request's headers and cookies: it carries no address, and goes only to a server that already has your IP (1inch's RPC proxy answers 403 over Tor); then a chain the URL names (`/rpc/8453`, `/web3/1`, `?chainId=10`, or a network's name as the last path segment, `/ethereum-mainnet`), only if Canary has a read endpoint for it. Never the wallet's chain: dapps read chains the wallet isn't on (1inch reads 14 with the wallet on one, app.ens.domains reads mainnet whatever the wallet is on), and an answer from the wrong chain is worse than none. Still unknown: reads go to the dapp's endpoint as written, over anon-rpc, and are held back if it refuses them. Dapp proxies that refuse probes over Tor can also be listed by host (`PROXY_CHAIN` in `src/shared.ts`; Uniswap's answers 401 without its Cloudflare cookies, so before this all its reads failed closed; now all 13 on /explore/tokens are protected).
- **`eth_accounts` to a remote endpoint** is answered `[]` without a request: a remote node holds no keys, so that's always its answer (1inch polls its own proxy with batches of them). A local node can hold accounts, so its calls pass through.
- **Per-address isolation:** a request containing one of your addresses is sent with `anonOptions.isolationKey = "addr:<address>"`. tor-js (0.4.4+) puts each key on its own circuit and TLS session cache, so the exit can't link two of your addresses. Verified live: different keys left through different exits, a repeated key through the same one.
- **Fewer Tor round trips** (`src/rpc-pipeline.ts`). Each request over tor-js costs ~1 s whatever its size (a new stream, TCP and TLS through three relays), so Canary sends fewer of them:
  - *batch*: calls for the same endpoint and the same isolation key that arrive within 15 ms leave as one JSON-RPC batch (max 20). Never across keys. If an endpoint rejects batches, or drops a call from one, those calls are retried singly; if it refuses a batch for its size (HTTP 400/413, as dRPC's free plan does past 3 calls), the batch goes again in halves, and that endpoint gets batches no larger from then on.
  - *cache*: `eth_chainId`/`net_version` for good (seeded from the chain Canary already resolved, so they never go out), deployed `eth_getCode` for good, `eth_blockNumber` for 2 s.
  - *dedupe*: an identical call already in flight shares its answer.
  - *pre-warm*: when the wallet reveals an address, Canary sends one `eth_blockNumber` under that address's key, so its circuit is built before the dapp's first read (first read on a new key: ~2.0 s cold vs ~1.15 s warm). Redone after ~9 min, when arti stops reusing a circuit.
  - *hedge*: if a read fails, or hasn't answered within 3 s, it goes out again on a fresh circuit (a new isolation key derived from the original, so still one address per circuit) and the first answer wins. Without it a dead gateway stalls reads until the 15 s timeout.
  - *starts at load*: the worker boots, and pre-warms, when the browser or extension starts, not on the first dapp request.
  - Writes (`eth_sendRawTransaction`, signing, anything not in `SUBSTITUTABLE`) skip all of this: the original body is forwarded byte for byte, once.
  - The popup shows "N calls sent as M anon-rpc requests".
- **Packaged Tor directory snapshot** (`"torBootstrap": true`): `build.mjs` fetches tor-js's fast-bootstrap snapshot (~1.5 MB) from a gateway and ships it in the extension, refreshed when over 3 h old. A first boot then skips downloading it (11–13 s on EF's demo gateway). It's ignored once the worker's storage holds a consensus, and not used if older than 72 h. Fetch it on its own with `npm run snapshot`.
- **Gateway:** `network.workerConfig.gateways`. EF's demo gateway is shared and unreliable (on 6 Nov it stopped completing boots); run your own from [`../gateway/`](../gateway/). The default `config/live.json` lists our three, reachable from anywhere through a Playit UDP tunnel, then EF's demo gateway as a fallback. Ours run on one team machine, so they're up only while it is. EF's still wasn't completing boots on 7 Nov (not ready after 200 s alone; with ours in the list, ready in 6.8 s), so while ours are down reads fail closed (never sent directly unless you allow it for the site) until EF's works again. Point it (and the agent configs) at yours with `npm run gateways -- <address> …` at the repo root, then `npm run build`.
- **Declared vs observed** (`src/ens.ts`, `compareDeclared` in `@canary/core`). On each page load Canary looks for `/.well-known/canary.json` (`{"ens": "leakydash.eth"}`) on the site, then reads that name's `url` and `privacy.manifest` text records through the Universal Resolver (`resolve(name, text(node, key))`, which follows ENSv2 names to their resolver). The reads are `eth_call`s over the anon path on their own circuit (`canary:ens`), so no RPC provider learns which dapp you're on. The manifest counts only if the binding holds both ways: the site names the ENS name, and the name's `url` record (and the manifest's `origin`, if set) is the site. The popup then lists every third party the page sent your address or JSON-RPC calls to as *declared* or *not declared*, plus declared recipients not seen on the page. It also reads `privacy.verdict.canary`, an independent verifier's signed verdict (format and CLI: `packages/ens/README.md`), and shows it only if the EIP-712 signature recovers to the `addr` of the verifier name the verdict names, and the verdict is about this name and site. It then checks whether the verifier still holds its one-key role: `findResolver` gives the name's resolver, and if that has Enhanced Access Control, Canary simulates the verifier's `setText` of that key. If the simulation reverts, the popup says *independent verification revoked*. If the resolver has no EAC (an ENSv1 name behind the v1 adapter), it says the role can't be checked, never "revoked". Expired verdicts are labelled. The verdict's build hash isn't compared with the page (the scanner's fingerprint needs the raw first-party HTML/JS). Read once per origin every 10 min. Limits: lowercase ASCII names only (no ENSIP-15 normalization), and names that need an offchain (CCIP-read) lookup read as having no records. Checked against live Sepolia ENSv2 (`npm run test:ens-live`, against the deployed LeakyDash at https://canary-leakydash.vercel.app): the reader finds the manifest, the signed verdict from `verifier.canary.eth`, and the verifier's role through `leakydash.eth`'s own Permissioned Resolver, and shows the role revoked after `canary-ens revoke-verifier` (names and transactions: `packages/ens/README.md`, *Live on Sepolia*). The manifest format is LeakyDash's (`{name, origin, recipients: [{host, kind, purpose}], rpc}`).
- **Canary's labels** (`readLabel` in `src/ens.ts`, naming in `packages/ens/src/label.ts`). A site with no `/.well-known/canary.json` (or one that errors) is looked up at `<host, dots as hyphens>.labels.canary.eth`: `app.aave.com` → `app-aave-com.labels.canary.eth`. The label counts only if its `url` record is this site (two hosts can share a label name: `a-b.com`, `a.b-com`), and its `privacy.verdict.canary` record is checked exactly like a dapp's verdict: signature, signer = `verifier.canary.eth`'s `addr`, the verifier still holds the key on the labels resolver, about this site, not expired. A label lists the third parties a baseline scan saw receive your address (`addressRecipients`, with their kind). A site's own name always wins. Live: labels for app.uniswap.org, app.aave.com, app.ens.domains, revoke.cash and snapshot.box (`packages/ens/README.md`), checked with `node test/ens-live.mjs https://app.aave.com`, and shown by the extension over our tor-js gateways on app.aave.com, app.uniswap.org and app.ens.domains (docs/test-log.md §20).
- **Fail closed:** if the anon path fails, the dapp gets a JSON-RPC error. "If the anon path is down, send directly from my IP" is a per-site opt-in, and those calls are counted as *Direct*.

## Config (`config/live.json`)

| Key | Meaning |
|---|---|
| `network` | anon-rpc worker: `specifier` (on-chain), `bootstrapRpc` (to read it), `workerConfig` (network-defined, e.g. tor-js gateways) |
| `readEndpoints` | chainId → the RPC Canary answers substituted reads from. Must accept Tor traffic (Tenderly doesn't; see docs/test-log.md §5). The shipped configs list 71 chains (mainnets, L2s, testnets), each checked over Tor with `eth_chainId` and a balance read: publicnode first, then drpc or the chain's own RPC. Many official RPCs refuse Tor exits with HTTP 403 (OP's, Gnosis's, zkSync's, Taiko's, …), so another endpoint is used for those chains. Kaia and Blast have none that works over Tor, so their reads are forwarded instead |
| `ens` | where dapps' ENS names live: `chainId` (default 11155111, needs a `readEndpoints` entry), `universalResolver` (default `0xeeeeeeee14d718c2b47d9923deab1335e144eeee`), `verifier` (the verdict record read, `privacy.verdict.<verifier>`, default `canary`) and `labels` (where Canary's labels are, default `labels.canary.eth`) |
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
- A label is as current as its scan: it says what one baseline scan saw (load → connect → scroll), signed with a 30-day expiry. Only five sites have one so far.
