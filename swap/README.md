# Canary Swap

**A Uniswap v4 swap page whose quotes come from the chain: no quote API, and no address in the request.**

Live: **https://canary-swap.vercel.app** (Sepolia: quote and swap · Ethereum: quote only). ENSv2 name: `swap.canary.eth`.

Asking app.uniswap.org for a quote sends your address to Uniswap's server as `swapper`, together with the tokens and the exact amount, before you sign anything ([`test-artifacts/scans/quote/`](../test-artifacts/scans/quote/)). The quote doesn't need it. Here it is an `eth_call` to the v4 Quoter, which runs the swap against the pool and reverts with the result, so the request holds the pool key and the amount only. The page shows every request a quote made, decoded, and checks that your address is in none of them.

With the [Canary extension](../extension/), those reads, and the balance reads that do carry your address, go through anon-rpc, so the RPC provider doesn't see your IP either. The swap itself is one Universal Router transaction that your wallet signs. Your wallet broadcasts it through its own RPC, which Canary can't change. An agent can send it through anon-rpc: [`examples/viem-agent/swap.mjs`](../examples/viem-agent/swap.mjs) does the same swap through the Canary gateway.

## Uniswap contracts and the code that calls them

Every call is in [`src/v4.js`](src/v4.js), shared by the page, the agent and the pool script.

| Contract | Sepolia | Ethereum | Called in |
|---|---|---|---|
| V4 Quoter | [`0x61b3…9227`](https://sepolia.etherscan.io/address/0x61b3f2011a92d183c7dbadbda940a7555ccf9227) | [`0x52f0…1203`](https://etherscan.io/address/0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203) | `quoteExactInputSingle`, [`v4.js#L86`](src/v4.js#L86) (`quoteExactIn`), best of several pools at [`#L97`](src/v4.js#L97) |
| StateView | [`0xe1dd…7e4c`](https://sepolia.etherscan.io/address/0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c) | [`0x7ffe…7227`](https://etherscan.io/address/0x7ffe42c4a5deea5b0fec41c94c136cf115597227) | `getSlot0`, `getLiquidity`, [`v4.js#L76`](src/v4.js#L76) (`poolState`), for the price impact |
| Universal Router | [`0x3A9D…F98b`](https://sepolia.etherscan.io/address/0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b) | quote only | `execute(V4_SWAP)` with `SWAP_EXACT_IN_SINGLE → SETTLE_ALL → TAKE_ALL`, [`v4.js#L105`](src/v4.js#L105) (`swapExactInSingle`) |
| Permit2 | [`0x0000…8BA3`](https://sepolia.etherscan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) | | `approve` and `allowance` before selling a token, [`v4.js#L124`](src/v4.js#L124) (`approvalCalls`) |
| PoolManager | [`0xE03A…3543`](https://sepolia.etherscan.io/address/0xE03A1074c86CFeDd5C142C4F04F1a1536e203543) | | `initialize`, [`scripts/sepolia-pool.mjs#L103`](scripts/sepolia-pool.mjs#L103) |
| PositionManager | [`0x429b…09b4`](https://sepolia.etherscan.io/address/0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4) | | `modifyLiquidities(MINT_POSITION → SETTLE_PAIR → SWEEP)`, [`v4.js#L137`](src/v4.js#L137) (`mintFullRange`), sent at [`sepolia-pool.mjs#L127`](scripts/sepolia-pool.mjs#L127) |

Where the page uses them: the quote at [`src/app.ts#L145`](src/app.ts#L145), the price impact at [`#L148`](src/app.ts#L148), approvals and the swap at [`#L259`–`L264`](src/app.ts#L259-L264), and the capture of every request body for "What this quote sent" at [`#L43`](src/app.ts#L43). The agent quotes at [`swap.mjs#L49`](../examples/viem-agent/swap.mjs#L49) and signs and broadcasts at [`#L62`–`L63`](../examples/viem-agent/swap.mjs#L62-L63).

Addresses are from Uniswap's v4 deployments page, each checked on chain: code at the address, and the periphery contracts' `poolManager()` is the PoolManager. The encodings follow v4-periphery's `Actions.sol` and `V4Router.sol` and universal-router's `Commands.sol`; [`test/v4.test.mjs`](test/v4.test.mjs) decodes them back, and the live runs below executed them.

## The Sepolia pool

[`scripts/sepolia-pool.mjs`](scripts/sepolia-pool.mjs) deploys CNRY ([`contracts/CanaryTestToken.sol`](contracts/CanaryTestToken.sol), anyone can mint 1,000 at a time), opens an ETH/CNRY v4 pool (0.3 %, tick spacing 60, no hooks) at 1 ETH = 100,000 CNRY, and adds a full-range position of 0.02 ETH through the PositionManager. It is safe to rerun. Addresses and transactions are in [`sepolia.json`](sepolia.json).

| | |
|---|---|
| CNRY | [`0x77a487307169cffc9dbdd6588d2d85ebf7288584`](https://sepolia.etherscan.io/address/0x77a487307169cffc9dbdd6588d2d85ebf7288584) |
| Pool id | `0xff4f7d40d418c774dae403fe0bab371baf531ec849e86fa5f5cd0e9f298c1531` |
| `initialize` | [`0x6bff…0a73`](https://sepolia.etherscan.io/tx/0x6bffa2dbdf9994ace869645452a8e7f75b798b016c6e8bed1acf468b8cbf0a73) |
| full-range position | [`0x70ca…1748`](https://sepolia.etherscan.io/tx/0x70caf38efccba36e358a8e67e52d3a1a512137463025f79aaaf6db4a21eb1748) |

## Its ENSv2 name

`swap.canary.eth` has its own Permissioned Resolver, so a verifier's grant covers this dapp only. Its `url` is the deployed site, and its `privacy.manifest` ([`privacy.manifest.json`](privacy.manifest.json)) declares one recipient per chain: the public RPC. `verifier.canary.eth` signed a verdict from a baseline scan of the deployed site ([`canary-swap.vercel.app.baseline.md`](../test-artifacts/scans/canary-swap.vercel.app.baseline.md)): only the declared RPC received the address (the wallet's balance reads), so the result is `matches`. The site serves `/.well-known/canary.json` → `{"ens": "swap.canary.eth"}`, and the popup reads "Matches manifest". Transactions: [`packages/ens/sepolia.json`](../packages/ens/sepolia.json), under `records`.

## Tested live

| Run | Result |
|---|---|
| The deployed page with Canary ([`live-canary.json`](../test-artifacts/swap/live-canary.json), [popup](../test-artifacts/swap/popup-canary.png), [page](../test-artifacts/swap/swap-canary.png)) | Quote, connect, swap 0.0001 ETH → CNRY, mint, swap 5 CNRY → ETH: 3 transactions mined. Canary answered every read the page made through anon-rpc (50 by the end of the run, 53 when the popup opened); nothing was blocked or left exposed. Popup: "Matches manifest", coverage 100 %. |
| The local page without Canary ([`live-local.json`](../test-artifacts/swap/live-local.json)) | The same flow from a fresh wallet: 5 transactions, including the two Permit2 approvals the first CNRY sale needs. |
| The agent through the Canary gateway ([`agent-swap.log`](../test-artifacts/swap/agent-swap.log)) | Quote and swap, the raw transaction sent over anon-rpc: 18 of 19 calls protected, the broadcast IP-only, none direct or failed. |
| A quote on Ethereum | 1 ETH → 2,236.31 USDC from the best of three v4 ETH/USDC pools, in five `eth_call`s with no address. app.uniswap.org's API, which routes across pools, quoted 2,236.46 for the same trade in the scan about 20 minutes earlier. |

In every run, the page found the connected address in none of the quote requests.

## Run it

```sh
npm install
npm test                 # the encodings, offline
npm run build && npm start   # http://localhost:3300
```

The live end-to-end run drives a real Chromium with a test wallet that signs in Node (a stand-in for MetaMask), with or without the extension:

```sh
node test/live.mjs --key-file ../swap-test.key [--canary ../extension/dist-local] [--url https://canary-swap.vercel.app/] --out <dir>
```

The key file holds a Sepolia test key with a little Sepolia ETH. It is never printed, and `*.key` is gitignored. Deploying: `vercel deploy --prod` from this directory (`.vercelignore` keeps keys, tests and scripts out of the upload).
