// The agent's swap on Uniswap v4 (Sepolia), the way Canary Swap's page does
// it (swap/src/v4.js), with every request through the Canary gateway: the
// quote is an eth_call to the v4 Quoter (pool key and amount, no address), the
// key signs locally, and the raw transaction goes out over anon-rpc
// (manifest.json: rpc.write = "anon"), so the RPC sees neither this machine's
// IP nor a link between the quote and the wallet.
//
//   npm run gateway:local                                   # terminal 1
//   AGENT_KEY_FILE=../../agent.key npm run swap             # terminal 2: 0.0001 ETH → CNRY
//   AGENT_KEY_FILE=../../agent.key AMOUNT=0.0005 npm run swap
//
// The key file holds a Sepolia test key (`name=key` or the hex alone); it is
// never printed. It needs a little Sepolia ETH.

import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, formatUnits, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createCanary } from "@canary/agent";
import { MARKETS } from "../../swap/src/markets.js";
import { ABI, bestQuote, minOut, swapExactInSingle } from "../../swap/src/v4.js";

const file = process.env.AGENT_KEY_FILE;
if (!file) throw new Error("set AGENT_KEY_FILE to a file holding the agent's Sepolia test key");
const line = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
const hex = line.slice(line.lastIndexOf("=") + 1).trim();
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${file}: no private key found`);
const account = privateKeyToAccount(hex.startsWith("0x") ? hex : `0x${hex}`);

const market = MARKETS[sepolia.id];
const [ETH, CNRY] = market.tokens;
const amountIn = parseEther(process.env.AMOUNT ?? "0.0001");

const canary = await createCanary({ gateway: process.env.CANARY_GATEWAY ?? "http://127.0.0.1:18545", wallets: [account.address] });
const stop = canary.on("egress", (e) => console.log(`  [canary] ${e.category.padEnd(16)} ${e.channel.padEnd(4)} ${e.host}${e.methods ? " " + e.methods.join(",") : ""}${e.ms ? ` ${e.ms} ms` : ""}${e.note ? ` (${e.note})` : ""}`));
const transport = canary.viemTransport();
const client = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ chain: sepolia, transport, account });

const balances = async () => {
  const [eth, cnry] = await Promise.all([
    client.getBalance({ address: account.address }),
    client.readContract({ address: CNRY.address, abi: ABI.erc20, functionName: "balanceOf", args: [account.address] }),
  ]);
  return `${formatEther(eth)} ETH, ${formatUnits(cnry, CNRY.decimals)} ${CNRY.symbol}`;
};

console.log(`agent wallet ${account.address}: ${await balances()}`);
console.log(`\nquote ${formatEther(amountIn)} ${ETH.symbol} → ${CNRY.symbol} (v4 Quoter, eth_call via the gateway)…`);
const q = await bestQuote(client, sepolia.id, market.pools, true, amountIn);
if (!q) throw new Error("no pool can fill this amount");
const min = minOut(q.amountOut, 50);
console.log(`  ${formatUnits(q.amountOut, CNRY.decimals)} ${CNRY.symbol}, at least ${formatUnits(min, CNRY.decimals)} after 0.5 % slippage`);

console.log("\nswap: Universal Router execute(V4_SWAP), signed here, sent as eth_sendRawTransaction via the gateway…");
const tx = swapExactInSingle({ chainId: sepolia.id, key: q.key, zeroForOne: true, amountIn, minAmountOut: min, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
// viem signs with the local key in this process; the only write the gateway sees is eth_sendRawTransaction.
const hash = await wallet.sendTransaction(tx);
console.log(`  sent ${hash}`);
const r = await client.waitForTransactionReceipt({ hash });
console.log(`  ${r.status} in block ${r.blockNumber} · ${market.explorer}/tx/${hash}`);
console.log(`\nagent wallet after: ${await balances()}`);

await new Promise((ok) => setTimeout(ok, 200));
stop();
const { signed } = await canary.report();
console.log("\ncoverage:", JSON.stringify(signed.report.rpc));
process.exit(r.status === "success" ? 0 : 1);
