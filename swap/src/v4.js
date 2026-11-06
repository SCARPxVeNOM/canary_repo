// Uniswap v4, the parts Canary Swap uses. No Uniswap API is in the path:
//
//   quote       V4Quoter.quoteExactInputSingle over eth_call: pool key and amount, no address
//   pool state  StateView.getSlot0 / getLiquidity
//   swap        UniversalRouter.execute(V4_SWAP: SWAP_EXACT_IN_SINGLE → SETTLE_ALL → TAKE_ALL)
//   allowance   ERC-20 approve to Permit2, Permit2.approve to the Universal Router (selling a token)
//   liquidity   PositionManager.modifyLiquidities(MINT_POSITION → SETTLE_PAIR → SWEEP) (scripts/sepolia-pool.mjs)
//
// Addresses: docs.uniswap.org/contracts/v4/deployments, each checked on chain
// (eth_getCode, and poolManager() of the periphery contracts). Encodings
// follow v4-periphery's Actions.sol and V4Router.sol and universal-router's
// Commands.sol.

import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, zeroAddress } from "viem";

export const NATIVE = zeroAddress; // currency0 of an ETH pool

export const V4 = {
  1: {
    poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
    universalRouter: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
    positionManager: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",
    stateView: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
    quoter: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
  11155111: {
    poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
    universalRouter: "0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b",
    positionManager: "0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4",
    stateView: "0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c",
    quoter: "0x61b3f2011a92d183c7dbadbda940a7555ccf9227",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
};

// universal-router Commands.sol
export const COMMANDS = { V4_SWAP: 0x10 };
// v4-periphery Actions.sol
export const ACTIONS = { MINT_POSITION: 0x02, SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, SETTLE_PAIR: 0x0d, TAKE_ALL: 0x0f, SWEEP: 0x14 };

const POOL_KEY = "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";

export const ABI = {
  quoter: parseAbi([
    "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
    "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
    "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
  ]),
  stateView: parseAbi([
    "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
    "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  ]),
  poolManager: parseAbi([
    "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
    "function initialize(PoolKey key, uint160 sqrtPriceX96) returns (int24 tick)",
  ]),
  router: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
  positionManager: parseAbi(["function modifyLiquidities(bytes unlockData, uint256 deadline) payable", "function nextTokenId() view returns (uint256)"]),
  permit2: parseAbi([
    "function approve(address token, address spender, uint160 amount, uint48 expiration)",
    "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  ]),
  erc20: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 value) returns (bool)",
    "function mint(address to, uint256 amount)",
  ]),
};

/** PoolId = keccak256(abi.encode(PoolKey)), as PoolIdLibrary computes it. */
export const poolId = (key) => keccak256(encodeAbiParameters(parseAbiParameters(POOL_KEY), [key]));

/** The pool's price and in-range liquidity. sqrtPriceX96 0 means the pool isn't initialized. */
export async function poolState(client, chainId, key) {
  const id = poolId(key);
  const [[sqrtPriceX96, tick, , lpFee], liquidity] = await Promise.all([
    client.readContract({ address: V4[chainId].stateView, abi: ABI.stateView, functionName: "getSlot0", args: [id] }),
    client.readContract({ address: V4[chainId].stateView, abi: ABI.stateView, functionName: "getLiquidity", args: [id] }),
  ]);
  return { id, sqrtPriceX96, tick, lpFee, liquidity };
}

/** What `amountIn` buys in one pool. The Quoter runs the swap and reverts with the result, so this is an eth_call: nothing is sent, and the request holds the pool key and the amount only. */
export async function quoteExactIn(client, chainId, key, zeroForOne, amountIn) {
  const { result } = await client.simulateContract({
    address: V4[chainId].quoter,
    abi: ABI.quoter,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
  });
  return { amountOut: result[0], gasEstimate: result[1] };
}

/** The best single-pool quote among `pools` (pools that revert, e.g. empty ones, are skipped). */
export async function bestQuote(client, chainId, pools, zeroForOne, amountIn) {
  const quotes = await Promise.all(pools.map((key) => quoteExactIn(client, chainId, key, zeroForOne, amountIn).then((q) => ({ key, ...q }), () => null)));
  return quotes.filter(Boolean).sort((a, b) => (a.amountOut > b.amountOut ? -1 : a.amountOut < b.amountOut ? 1 : 0))[0] ?? null;
}

const v4Input = (actions, params) => encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [`0x${actions.map((a) => a.toString(16).padStart(2, "0")).join("")}`, params]);

/** An exact-input swap in one pool through the Universal Router: the transaction to sign. Selling ETH sends it as value; selling a token needs the Permit2 allowance (`approvalCalls`). */
export function swapExactInSingle({ chainId, key, zeroForOne, amountIn, minAmountOut, deadline }) {
  const [tokenIn, tokenOut] = zeroForOne ? [key.currency0, key.currency1] : [key.currency1, key.currency0];
  const params = [
    encodeAbiParameters(parseAbiParameters(`(${POOL_KEY} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)`), [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minAmountOut, hookData: "0x" }]),
    encodeAbiParameters(parseAbiParameters("address, uint256"), [tokenIn, amountIn]),
    encodeAbiParameters(parseAbiParameters("address, uint256"), [tokenOut, minAmountOut]),
  ];
  const input = v4Input([ACTIONS.SWAP_EXACT_IN_SINGLE, ACTIONS.SETTLE_ALL, ACTIONS.TAKE_ALL], params);
  return {
    to: V4[chainId].universalRouter,
    data: encodeFunctionData({ abi: ABI.router, functionName: "execute", args: [`0x${COMMANDS.V4_SWAP.toString(16)}`, [input], deadline] }),
    value: tokenIn === NATIVE ? amountIn : 0n,
  };
}

const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

/** The transactions that let the Universal Router pull `amount` of `token` from `owner` through Permit2, if any are missing. */
export async function approvalCalls(client, chainId, token, owner, amount, spender = V4[chainId].universalRouter) {
  if (token === NATIVE) return [];
  const { permit2 } = V4[chainId];
  const calls = [];
  const toPermit2 = await client.readContract({ address: token, abi: ABI.erc20, functionName: "allowance", args: [owner, permit2] });
  if (toPermit2 < amount) calls.push({ to: token, data: encodeFunctionData({ abi: ABI.erc20, functionName: "approve", args: [permit2, (1n << 256n) - 1n] }), value: 0n, what: "approve Permit2" });
  const [allowed, expiration] = await client.readContract({ address: permit2, abi: ABI.permit2, functionName: "allowance", args: [owner, token, spender] });
  if (allowed < amount || BigInt(expiration) * 1000n < BigInt(Date.now()) + 3_600_000n)
    calls.push({ to: permit2, data: encodeFunctionData({ abi: ABI.permit2, functionName: "approve", args: [token, spender, MAX_UINT160, MAX_UINT48] }), value: 0n, what: "approve the Universal Router in Permit2" });
  return calls;
}

/** A full-range position through the PositionManager. `amount0Max` of ETH goes as value and the rest is swept back to `owner`. */
export function mintFullRange({ chainId, key, liquidity, amount0Max, amount1Max, owner, deadline }) {
  const tick = BigInt(Math.floor(887272 / key.tickSpacing) * key.tickSpacing);
  const params = [
    encodeAbiParameters(parseAbiParameters(`${POOL_KEY}, int24, int24, uint256, uint128, uint128, address, bytes`), [key, Number(-tick), Number(tick), liquidity, amount0Max, amount1Max, owner, "0x"]),
    encodeAbiParameters(parseAbiParameters("address, address"), [key.currency0, key.currency1]),
    encodeAbiParameters(parseAbiParameters("address, address"), [key.currency0, owner]),
  ];
  return {
    to: V4[chainId].positionManager,
    data: encodeFunctionData({ abi: ABI.positionManager, functionName: "modifyLiquidities", args: [v4Input([ACTIONS.MINT_POSITION, ACTIONS.SETTLE_PAIR, ACTIONS.SWEEP], params), deadline] }),
    value: key.currency0 === NATIVE ? amount0Max : 0n,
  };
}

/** floor(sqrt(price) · 2^96) for a price of token1 per token0 given as a fraction, both in raw units. */
export function sqrtPriceX96(num, den = 1n) {
  const x = (num << 192n) / den;
  let r = x, y = (x + 1n) / 2n;
  while (y < r) (r = y), (y = (x / y + y) / 2n);
  return r;
}

/** Amount out after `slippageBps`, rounded down. */
export const minOut = (amountOut, slippageBps) => (amountOut * (10_000n - BigInt(slippageBps))) / 10_000n;
