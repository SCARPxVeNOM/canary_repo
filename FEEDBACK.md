# Uniswap developer feedback

From building [Canary Swap](swap/) (https://canary-swap.vercel.app) and the agent swap in [`examples/viem-agent/swap.mjs`](examples/viem-agent/swap.mjs), ETHGlobal Mumbai 2026.

We used the V4 Quoter, StateView, the Universal Router (`V4_SWAP`), Permit2, `PoolManager.initialize` and `PositionManager.modifyLiquidities`, on Sepolia (quote and swap, our own ETH/CNRY pool) and on Ethereum (quotes from the ETH/USDC pools). All calls are in [`swap/src/v4.js`](swap/src/v4.js), encoded with viem and no Uniswap SDK.

## What worked well

- **A quote needs no account.** The Quoter and StateView make an API-free quote a handful of `eth_call`s: pool key and amount in, amount out and a gas estimate back. That is what made the project possible: the same trade app.uniswap.org quotes through its API, priced from the chain without telling anyone who is asking. On Ethereum the best of three ETH/USDC pools gave 2,236.31 USDC for 1 ETH; the API's routed quote in our scan, about 20 minutes earlier, was 2,236.46.
- **Deterministic pool ids and StateView** make reading any pool trivial once you have the key. No subgraph, no indexer.
- **One encoding for every client.** The `V4_SWAP` input is the same bytes whether a browser wallet or an agent signs it, so the page and the agent share one module.
- **Permit2's allowance and expiry** are easy to check before a sale, so the page can skip approvals it already has.

## What was hard, and suggestions

1. **Asking for a quote tells the server who is about to trade.** A scan of app.uniswap.org asking for a 1 ETH → USDC quote ([evidence](test-artifacts/scans/quote/)) shows `POST /quote` with `swapper` set to the wallet address, `POST /check_approval` with `walletAddress` and the amount, and `POST /swap` with the quote and `recipient`, all before anything is signed. The interface's chain reads go through the same entry gateway (`/rpc/1`), so one server sees the reads, the quote and the address together, and the wallet's own RPC setting doesn't apply. Suggestions: make `swapper` optional for an indicative quote and add it only when the user commits (`/swap`); let the interface quote from the Quoter through the user's RPC; and say in the docs what the Trading API keeps from these requests and for how long.
2. **Action parameter layouts aren't written down.** Encoding v4 actions without the SDK means reading `CalldataDecoder.sol`. For example, `SWAP_EXACT_IN_SINGLE` takes `abi.encode(ExactInputSingleParams)`, a dynamic struct read through an offset (at least 0x160 bytes), while `MINT_POSITION` takes its fields encoded inline. A table of action → byte → ABI type string in the docs would save every non-SDK integrator the same afternoon ([`swap/src/v4.js`](swap/src/v4.js) has the ones we used).
3. **Two Quoters on Sepolia.** `0x61b3…9227` (on the deployments page) and `0x68aF…8244` both answer for the Sepolia PoolManager and returned identical quotes. Which is canonical? Version labels on the deployments page would help.
4. **The Quoter isn't `view`.** It quotes by reverting, so typed clients refuse it as a read (viem's `readContract`). `simulateContract` or a raw `eth_call` works. A line in the Quoter docs would help.
5. **No ready test pool on Sepolia.** To try a v4 swap end to end on a testnet, we deployed a token, initialized a pool and added liquidity first. A canonical Sepolia pool with a faucet token would let builders test swaps in minutes.
6. **Native ETH positions need a `SWEEP`.** With `SETTLE_PAIR` on an ETH pool you send `amount0Max` as value, and the excess stays in the PositionManager unless the actions end with `SWEEP`. The two approvals before the first mint (ERC-20 → Permit2, then Permit2 → PositionManager) also trip people up. A quickstart that shows both would help.
7. **Uninitialized pools read as zero.** StateView returns `sqrtPriceX96 = 0` for a pool that doesn't exist rather than reverting. That's fine, but worth documenting as the way to tell.
