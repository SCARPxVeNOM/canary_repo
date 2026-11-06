#!/usr/bin/env node
/* Canary Swap's pool on Uniswap v4, Sepolia. Safe to rerun: each step checks
   the chain first and skips what is already done.

     1. CNRY (contracts/CanaryTestToken.sol), a test token anyone can mint
     2. the ETH/CNRY pool on the v4 PoolManager: 0.3 %, tick spacing 60, no
        hooks, opened at 1 ETH = 100,000 CNRY
     3. a full-range position through the PositionManager (Permit2 approvals
        first), --eth of ETH and the CNRY that matches it
     4. a check: StateView's slot0 and liquidity, and a Quoter quote

   usage: node scripts/sepolia-pool.mjs --owner-key-file <file> [--eth 0.02] [--rpc <url>] [--out sepolia.json]

   A key file holds a hex key, alone or as `name=key` (first line used). The
   key is never printed. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, encodeFunctionData, formatEther, formatUnits, http, parseEther, parseUnits, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { ABI, NATIVE, V4, mintFullRange, poolState, quoteExactIn, sqrtPriceX96 } from "../src/v4.js";

const { values: opt } = parseArgs({
  options: {
    "owner-key-file": { type: "string" },
    eth: { type: "string", default: "0.02" },
    rpc: { type: "string", default: "https://ethereum-sepolia-rpc.publicnode.com" },
    out: { type: "string", default: new URL("../sepolia.json", import.meta.url).pathname },
  },
});
const readKey = (file) => {
  if (!file) throw new Error("--owner-key-file is required");
  const line = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const hex = line.slice(line.lastIndexOf("=") + 1).trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${file}: no private key found`);
  return hex.startsWith("0x") ? hex : `0x${hex}`;
};

const PRICE = 100_000n; // CNRY per ETH
const SUPPLY = parseUnits("1000000", 18); // to the owner, for the position
const owner = privateKeyToAccount(readKey(opt["owner-key-file"]));
const transport = http(opt.rpc);
const client = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ chain: sepolia, transport, account: owner });
const C = V4[sepolia.id];

const out = existsSync(opt.out) ? JSON.parse(readFileSync(opt.out, "utf8")) : {};
Object.assign(out, { chainId: sepolia.id, v4: C, owner: owner.address, txs: out.txs ?? {} });
const save = () => writeFileSync(opt.out, JSON.stringify(out, null, 2) + "\n");

/** Simulate, send, wait; record the tx under `label`. */
async function send(label, tx) {
  await client.call({ account: owner, ...tx });
  const hash = await wallet.sendTransaction(tx);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label}: reverted in ${hash}`);
  out.txs[label] = hash;
  save();
  console.log(`  ${label}: ${hash}`);
  return r;
}
const call = (to, abi, functionName, args) => ({ to, data: encodeFunctionData({ abi, functionName, args }) });
/** The pool's state once `ok` holds: publicnode's "latest" can lag a receipt by a few blocks. */
async function stateWhen(ok) {
  for (let i = 0; ; i++) {
    const s = await poolState(client, sepolia.id, key);
    if (ok(s) || i === 20) return s;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

console.log(`owner ${owner.address} · ${formatEther(await client.getBalance({ address: owner.address }))} ETH`);

// 1. the token
if (!(out.token && (await client.getCode({ address: out.token.address }))?.length > 2)) {
  const solc = createRequire(import.meta.url)("solc");
  const source = readFileSync(new URL("../contracts/CanaryTestToken.sol", import.meta.url), "utf8");
  const built = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "CanaryTestToken.sol": { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  })));
  const errors = (built.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const { abi, evm } = built.contracts["CanaryTestToken.sol"].CanaryTestToken;
  const hash = await wallet.deployContract({ abi, bytecode: `0x${evm.bytecode.object}`, args: [owner.address, SUPPLY] });
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy CNRY: failed in ${hash}`);
  out.token = { symbol: "CNRY", name: "Canary Test Token", decimals: 18, address: r.contractAddress, compiler: solc.version() };
  out.txs["deploy CNRY"] = hash;
  save();
  console.log(`  deploy CNRY: ${hash} → ${r.contractAddress}`);
}
const token = out.token.address;

// 2. the pool (ETH is currency0: address 0 sorts first)
const key = { currency0: NATIVE, currency1: token, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
const startPrice = sqrtPriceX96(PRICE);
let state = await poolState(client, sepolia.id, key);
if (state.sqrtPriceX96 === 0n) {
  await send("initialize ETH/CNRY", call(C.poolManager, ABI.poolManager, "initialize", [key, startPrice]));
  state = await stateWhen((s) => s.sqrtPriceX96 > 0n);
}
out.pool = { key, id: state.id, price: `1 ETH = ${PRICE} CNRY at open`, sqrtPriceX96: String(startPrice) };
save();

// 3. liquidity, full range. With sqrtPa → 0 and sqrtPb → ∞ the position needs a little less than
// L/√P of ETH and L·√P of CNRY, so L from --eth and those bounds as the maxima are enough; the
// spare ETH is swept back.
if (state.liquidity === 0n) {
  if (state.sqrtPriceX96 === 0n) throw new Error("the pool doesn't read as initialized yet; rerun in a minute");
  const Q96 = 1n << 96n;
  const eth = parseEther(opt.eth);
  const liquidity = (eth * state.sqrtPriceX96) / Q96;
  const cnry = (liquidity * state.sqrtPriceX96) / Q96 + 1n;
  const amount0Max = eth + eth / 1000n;
  const amount1Max = cnry + cnry / 1000n;
  if ((await client.readContract({ address: token, abi: ABI.erc20, functionName: "allowance", args: [owner.address, C.permit2] })) < amount1Max)
    await send("approve CNRY to Permit2", call(token, ABI.erc20, "approve", [C.permit2, (1n << 256n) - 1n]));
  const [allowed] = await client.readContract({ address: C.permit2, abi: ABI.permit2, functionName: "allowance", args: [owner.address, token, C.positionManager] });
  if (allowed < amount1Max)
    await send("Permit2: approve PositionManager", call(C.permit2, ABI.permit2, "approve", [token, C.positionManager, (1n << 160n) - 1n, (1n << 48n) - 1n]));
  const tokenId = await client.readContract({ address: C.positionManager, abi: ABI.positionManager, functionName: "nextTokenId" });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  await send("mint full-range position", mintFullRange({ chainId: sepolia.id, key, liquidity, amount0Max, amount1Max, owner: owner.address, deadline }));
  out.position = { tokenId: String(tokenId), liquidity: String(liquidity), eth: opt.eth, maxCnry: formatUnits(amount1Max, 18) };
  state = await stateWhen((s) => s.liquidity > 0n);
}

// 4. check
const q = await quoteExactIn(client, sepolia.id, key, true, parseEther("0.0001"));
out.pool.liquidity = String(state.liquidity);
out.check = { at: new Date().toISOString(), tick: state.tick, lpFee: state.lpFee, quote: `0.0001 ETH → ${formatUnits(q.amountOut, 18)} CNRY (gas ${q.gasEstimate})` };
save();
console.log(`pool ${state.id} · tick ${state.tick} · liquidity ${state.liquidity}`);
console.log(`quote: ${out.check.quote}`);
