// The pairs Canary Swap offers. Sepolia: our ETH/CNRY pool (scripts/sepolia-pool.mjs),
// quote and swap. Ethereum: Uniswap's ETH/USDC v4 pools, quote only, so the
// page can price the same trade app.uniswap.org quoted in test-artifacts/scans/quote/.

import { zeroAddress } from "viem";
import deployed from "../sepolia.json" with { type: "json" };
import { NATIVE, V4 } from "./v4.js";

const ETH = { symbol: "ETH", address: NATIVE, decimals: 18 };
const pool = (currency1, fee, tickSpacing) => ({ currency0: NATIVE, currency1, fee, tickSpacing, hooks: zeroAddress });

export const MARKETS = {
  11155111: {
    name: "Sepolia",
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
    swap: true,
    v4: V4[11155111],
    tokens: [ETH, { symbol: deployed.token.symbol, address: deployed.token.address, decimals: deployed.token.decimals, mintable: true }],
    pools: [deployed.pool.key],
  },
  1: {
    name: "Ethereum",
    rpc: "https://ethereum-rpc.publicnode.com",
    explorer: "https://etherscan.io",
    swap: false,
    v4: V4[1],
    tokens: [ETH, { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }],
    pools: [pool("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 500, 10), pool("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 3000, 60), pool("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 100, 1)],
  },
};
