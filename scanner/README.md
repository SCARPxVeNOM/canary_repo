# Canary scanner

Loads a dapp with a fake wallet holding a fresh, synthetic **canary address**, records every request the browser makes through **mitmproxy** (ground truth), and reports who received the address, in which encoding, and whether the dapp declared them. Run it with and without the Canary extension for a before/after table (docs/design-notes.md §3.2).

```sh
pip install mitmproxy          # provides mitmdump
npm install
npx playwright install chromium   # or point --chrome / CHROME_BIN at Chromium / Chrome for Testing

node scan.mjs https://some-dapp.xyz                                   # baseline
node scan.mjs https://some-dapp.xyz --canary ../extension/dist        # with Canary
node scan.mjs https://some-dapp.xyz --compare --canary ../extension/dist --manifest manifest.json --keep
node summary.mjs scans/ > scans/RESULTS.md                           # one table across every site compared
```

Output in `scans/`: `<host>.baseline.md/.json`, `<host>.canary.md/.json`, `<host>.compare.md`, and with `--keep` the raw captured requests (`.flows.jsonl`). The identity is synthetic, so the evidence is safe to publish.

| Option | Meaning |
|---|---|
| `--canary <dir>` | load the unpacked Canary extension |
| `--compare` | run baseline and with-Canary, write the before/after table |
| `--manifest <file>` | the dapp's privacy manifest (`{ recipients: [{ host, kind, purpose }] }`); third parties not in it that receive the address are **undeclared** |
| `--chain 0x1` | chain the fake wallet reports |
| `--rpc <url>` | scanner-side RPC for reads the dapp sends to the *wallet* (never goes through the proxy) |
| `--wait <ms>` | time after connecting before scrolling (default 8000) |
| `--amount <n>` | after connecting, type `n` into the page's amount field, so a swap form asks for a quote (`../test-artifacts/scans/quote/`) |
| `--keep` | save the raw captured requests |
| `--headful` | show the browser |

## What it does

1. Starts `mitmdump` with `addon.py` (records URL, kept headers, body, WebSocket frames from the client, and hashes of first-party HTML/JS for the build fingerprint).
2. Launches Chromium through it (`--proxy-bypass-list=<-loopback>` so localhost goes through the proxy too; QUIC off so nothing bypasses it), injects the fake wallet (`lib/wallet.js`: EIP-1193 + EIP-6963, approves connection, rejects every signature).
3. Flow: load → click "Connect" (and pick "Canary Scanner" in a wallet modal if one opens) → with `--amount`, type the amount → wait → scroll. Short on purpose.
4. Matches the canary address in every request (`lib/matcher.mjs`): hex (covers lowercase, checksummed, no-`0x`, ABI-padded, URL-encoded), base64/base64url of the raw bytes and of each text form, keccak256 and sha256 of each, and raw bytes in binary bodies.
5. Classifies each destination: first/third party, `rpc` (JSON-RPC body, or JSON-RPC methods in a custom envelope such as `{chainId, method, params}` to a dapp's own RPC proxy), `analytics` (known hosts and paths), `backend`. Traffic from the extension itself is listed separately.

**Coverage** = RPC calls Canary answered via anon-rpc ÷ (those + JSON-RPC calls the proxy saw leave the page directly).

Anything the proxy sees left the browser over HTTP. anon-rpc traffic (tor-js) leaves over WebRTC and is never seen, so it can't be miscounted as a leak. The passthrough test worker *does* show up (origin `null`) and is labelled.

## Not inspected

Service workers' own traffic, WebRTC, payloads encrypted or obfuscated beyond the encodings above, and anything behind flows the scanner doesn't run. "No leak observed" is not "no leak".
