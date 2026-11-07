# LeakyDash

A deliberately leaky Sepolia token dashboard for demoing Canary (docs/design-notes.md §3.4). Everything runs locally from one process; each party is its own site under `*.localhost`, which every modern browser resolves to this machine.

```sh
npm install
npm start          # PORT=3000, UPSTREAM_RPC=https://ethereum-sepolia-rpc.publicnode.com
```

| URL | Party |
|---|---|
| http://leakydash.localhost:3000/ | the dapp, plus its first-party backend (`/api/points`) |
| http://leakydash.localhost:3000/logs | **log viewer**: what the provider, tracker and backend received, live, with your address highlighted |
| http://rpc.provider.localhost:3000/ | "the dapp's RPC provider": logs every call, then forwards to `UPSTREAM_RPC` |
| http://tracker.localhost:3000/ | "analytics": logs whatever it is sent |

## What it leaks (leaky mode, the default)

- **Reads** (`getBlockNumber`, `getGasPrice`, and a Multicall3 `eth_call` batching your ETH and token balances) go straight from your browser to the provider. Your address is ABI-encoded inside the calldata; the log viewer finds it.
- **Connecting** sends your address to the tracker three ways: a `sendBeacon` event, a tracking pixel with it in the URL, and a base64-encoded "uid".
- **First party:** `/api/points?address=…`. Canary labels this "detected, unprotected" and lets it through: the dapp can always see your address.

## Native mode

"Switch to native anon-rpc mode" makes LeakyDash itself route **every** read through anon-rpc (tor-js via `@anon-rpc/browser-harness`, inside a null-origin sandbox) to a public Sepolia endpoint, and drops the trackers. No extension needed: this is the "your app routes its RPC reads through anon-rpc by default" path. First boot takes ~13 s.

## Privacy manifest

`privacy.manifest.json` declares the RPC provider and **not** the tracker, so the scanner reports the tracker as undeclared. `/.well-known/canary.json` binds the origin to an ENS name (set `LEAKYDASH_ENS`), for the ENSv2 part.

Locally, logs show `127.0.0.1` as the source IP. Deployed behind a real hostname, the provider pane shows your public IP, and a read endpoint you run shows only Tor exits.

## Deployed: https://canary-leakydash.vercel.app

| URL | Party |
|---|---|
| https://canary-leakydash.vercel.app/ | the dapp, its backend and `/logs` |
| https://canary-leakydash-rpc.vercel.app/ | its RPC provider (forwards to Sepolia publicnode) |
| https://canary-leakydash-tracker.vercel.app/ | the tracker |

One Vercel project and deployment, three hostnames: `vercel.json` sends every path to `api/index.mjs`, which is `server.mjs`'s handler, and the handler picks the party by `Host`, as it does locally. `vercel.app` is a public suffix, so browsers, the scanner and Canary treat the three as different sites. `build.mjs` bundles the dapp at deploy time, and the provider and tracker URLs are added when `app.js` is served.

```sh
vercel link --project canary-leakydash
vercel env add LEAKYDASH_DAPP_HOST production        # canary-leakydash.vercel.app
vercel env add LEAKYDASH_PROVIDER_HOST production    # canary-leakydash-rpc.vercel.app
vercel env add LEAKYDASH_TRACKER_HOST production     # canary-leakydash-tracker.vercel.app
vercel deploy --prod
vercel domains add canary-leakydash-rpc.vercel.app canary-leakydash
vercel domains add canary-leakydash-tracker.vercel.app canary-leakydash
```

- The logs show real source IPs, so deployed, `/logs` shows each visitor only their own entries. The dapp sends a random per-browser id (`localStorage` `leakydash.sid`) with its own requests: in the provider URL, the way RPC URLs carry a project key; as an analytics id to the tracker; and to the backend. The viewer asks for that id's entries. Not by IP: some networks send each destination out through a different public address.
- Logs live in the function's memory, so they're gone when the instance is recycled, and two instances under load would each see part. That's fine for a live demo.
- `privacy.manifest.vercel.json` is the manifest for these hostnames, published on `leakydash.eth` (`canary-ens set-dapp`).
