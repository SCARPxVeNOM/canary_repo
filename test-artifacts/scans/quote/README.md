# What a Uniswap quote sends

A scan of app.uniswap.org asking for a quote, as a user does before deciding to swap.

```sh
node scan.mjs "https://app.uniswap.org/swap?chain=mainnet&inputCurrency=ETH&outputCurrency=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" --amount 1 --keep
```

Flows: load → the fake wallet is already connected → type `1` (ETH → USDC) → scroll. Scanned 2026-11-06 10:23 UTC, build `cac3dc07a9ea`, canary address `0xA683…d4b8` (synthetic, made for this scan).

Before anything is signed, Uniswap's backend, `entry-gateway.backend-prod.api.uniswap.org`, receives the wallet address together with the trade:

| Request | What it carries |
|---|---|
| `POST /check_approval` | `walletAddress`, `token` (ETH), `amount` 1e18, `chainId` 1 |
| `POST /quote` ×2 | `swapper` (the address), `tokenIn` ETH, `tokenOut` USDC, `amount` 1e18, `type` EXACT_INPUT; the second also lists the wallet's accounts |
| `POST /swap` ×3 | the quote back, with `swapper` and `output.recipient` set to the address, output 2236.46 USDC, minimum 2225.28, slippage 0.5 % |

The bodies are in [`app.uniswap.org.quote-requests.json`](app.uniswap.org.quote-requests.json); [`app.uniswap.org.baseline.md`](app.uniswap.org.baseline.md) is the full report (31 of 124 requests to the entry gateway carried the address). Nothing went to a third party with the address, so this isn't a leak in Canary's sense: it is Uniswap's own server, and the label for `app.uniswap.org` says "no third parties". Canary allows first-party requests and reports them as "detected, unprotected", so this is what the extension can't fix from the outside: the price of asking for a quote is telling the server who is about to trade what, and how much.

A quote doesn't need the address. The v4 Quoter answers `quoteExactInputSingle` over `eth_call` from pool state alone, and with Canary those reads go through anon-rpc. [`swap/`](../../../swap) is that page.
