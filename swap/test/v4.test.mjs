// The Uniswap v4 encodings in src/v4.js, offline. Expected values are from
// the chain: the mainnet pool id is the one StateView answers for, and the
// Sepolia start price is what scripts/sepolia-pool.mjs initialized the pool with.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeAbiParameters, decodeFunctionData, parseAbiParameters, parseEther, size, toFunctionSelector, zeroAddress } from "viem";
import { ABI, ACTIONS, COMMANDS, NATIVE, V4, minOut, mintFullRange, poolId, sqrtPriceX96, swapExactInSingle } from "../src/v4.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const deployed = JSON.parse(readFileSync(new URL("../sepolia.json", import.meta.url), "utf8"));
const KEY = deployed.pool.key;
const POOL_KEY = "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";
const hexOf = (actions) => `0x${actions.map((a) => a.toString(16).padStart(2, "0")).join("")}`;

test("poolId is keccak256(abi.encode(PoolKey)): mainnet ETH/USDC 0.05 %", () => {
  assert.equal(poolId({ currency0: NATIVE, currency1: USDC, fee: 500, tickSpacing: 10, hooks: zeroAddress }), "0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27");
  assert.equal(poolId(KEY), deployed.pool.id);
});

test("sqrtPriceX96: 1 → 2^96; the Sepolia pool opened at 100,000 CNRY per ETH", () => {
  assert.equal(sqrtPriceX96(1n), 1n << 96n);
  assert.equal(sqrtPriceX96(4n), 2n << 96n);
  assert.equal(String(sqrtPriceX96(100_000n)), deployed.pool.sqrtPriceX96);
});

test("swapExactInSingle, ETH in: execute(V4_SWAP) with swap → settle → take, ETH as value", () => {
  const amountIn = parseEther("0.0001");
  const tx = swapExactInSingle({ chainId: 11155111, key: KEY, zeroForOne: true, amountIn, minAmountOut: 9n, deadline: 1234n });
  assert.equal(tx.to, V4[11155111].universalRouter);
  assert.equal(tx.value, amountIn);
  assert.equal(tx.data.slice(0, 10), toFunctionSelector("function execute(bytes,bytes[],uint256)"));
  const { args } = decodeFunctionData({ abi: ABI.router, data: tx.data });
  assert.equal(args[0], `0x${COMMANDS.V4_SWAP.toString(16)}`);
  assert.equal(args[2], 1234n);
  const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes, bytes[]"), args[1][0]);
  assert.equal(actions, hexOf([ACTIONS.SWAP_EXACT_IN_SINGLE, ACTIONS.SETTLE_ALL, ACTIONS.TAKE_ALL]));
  // V4Router reads ExactInputSingleParams through an offset and needs at least 0x160 bytes (empty hookData).
  assert.equal(size(params[0]), 0x160);
  const [p] = decodeAbiParameters(parseAbiParameters(`(${POOL_KEY} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)`), params[0]);
  assert.deepEqual({ ...p.poolKey, currency1: p.poolKey.currency1.toLowerCase() }, { ...KEY, currency1: KEY.currency1.toLowerCase() });
  assert.equal(p.zeroForOne, true);
  assert.equal(p.amountIn, amountIn);
  assert.equal(p.amountOutMinimum, 9n);
  assert.deepEqual(decodeAbiParameters(parseAbiParameters("address, uint256"), params[1]), [NATIVE, amountIn]);
  const [takeCurrency, takeMin] = decodeAbiParameters(parseAbiParameters("address, uint256"), params[2]);
  assert.equal(takeCurrency.toLowerCase(), KEY.currency1.toLowerCase());
  assert.equal(takeMin, 9n);
});

test("swapExactInSingle, token in: no value, settle the token, take ETH", () => {
  const tx = swapExactInSingle({ chainId: 11155111, key: KEY, zeroForOne: false, amountIn: 5n, minAmountOut: 1n, deadline: 1n });
  assert.equal(tx.value, 0n);
  const { args } = decodeFunctionData({ abi: ABI.router, data: tx.data });
  const [, params] = decodeAbiParameters(parseAbiParameters("bytes, bytes[]"), args[1][0]);
  assert.equal(decodeAbiParameters(parseAbiParameters("address, uint256"), params[1])[0].toLowerCase(), KEY.currency1.toLowerCase());
  assert.equal(decodeAbiParameters(parseAbiParameters("address, uint256"), params[2])[0], NATIVE);
});

test("mintFullRange: MINT_POSITION → SETTLE_PAIR → SWEEP, ticks at the spacing's full range", () => {
  const owner = "0x000000000000000000000000000000000000dEaD";
  const tx = mintFullRange({ chainId: 11155111, key: KEY, liquidity: 10n, amount0Max: 7n, amount1Max: 8n, owner, deadline: 9n });
  assert.equal(tx.to, V4[11155111].positionManager);
  assert.equal(tx.value, 7n);
  const { args } = decodeFunctionData({ abi: ABI.positionManager, data: tx.data });
  const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes, bytes[]"), args[0]);
  assert.equal(actions, hexOf([ACTIONS.MINT_POSITION, ACTIONS.SETTLE_PAIR, ACTIONS.SWEEP]));
  const [, lower, upper, liquidity, max0, max1, to] = decodeAbiParameters(parseAbiParameters(`${POOL_KEY}, int24, int24, uint256, uint128, uint128, address, bytes`), params[0]);
  assert.deepEqual([lower, upper, liquidity, max0, max1, to], [-887220, 887220, 10n, 7n, 8n, owner]);
});

test("minOut rounds down", () => {
  assert.equal(minOut(10_000n, 50), 9_950n);
  assert.equal(minOut(199n, 50), 198n);
});
