// Minimal agent loop on Sepolia: read state → ask an LLM → (decide).
// Every chain read goes through the Canary gateway (anon-rpc); the LLM
// provider only ever sees WALLET_1 / AGENT_NAME.
//
//   npm run gateway                                  # terminal 1 (waits ~13 s for tor-js)
//   WALLET=0x… OPENAI_API_KEY=sk-… npm run agent      # terminal 2 (no key: prints the redacted prompt)

import { createPublicClient, erc20Abi, formatEther, formatUnits } from "viem";
import { sepolia } from "viem/chains";
import { createCanary } from "@canary/agent";

const WALLET = process.env.WALLET;
if (!WALLET) throw new Error("set WALLET=0x… (an address to watch; Canary never needs a key)");
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

const canary = await createCanary({ gateway: process.env.CANARY_GATEWAY ?? "http://127.0.0.1:18545", wallets: [WALLET] });
const stop = canary.on("egress", (e) => console.log(`  [canary] ${e.category.padEnd(16)} ${e.channel.padEnd(4)} ${e.host}${e.methods ? " " + e.methods.join(",") : ""}${e.ms ? ` ${e.ms} ms` : ""}`));

const client = createPublicClient({ chain: sepolia, transport: canary.viemTransport() });

console.log("reading state (via anon-rpc)…");
const [eth, usdc, block] = await Promise.all([
  client.getBalance({ address: WALLET }),
  client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [WALLET] }),
  client.getBlockNumber(),
]);

const prompt = `You manage wallet ${WALLET} (agent trader-01.agents.canary.eth). At block ${block} it holds ${formatEther(eth)} ETH and ${formatUnits(usdc, 6)} USDC (${USDC}). Answer in one sentence: should it swap anything? Name the wallet in your answer.`;

if (process.env.OPENAI_API_KEY) {
  const r = await canary.llmFetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: process.env.MODEL ?? "gpt-4o-mini", messages: [{ role: "user", content: prompt }] }),
  });
  const j = await r.json();
  console.log("\nLLM (aliases restored):", j.choices?.[0]?.message?.content ?? j);
} else {
  console.log("\nno OPENAI_API_KEY: this is what the provider would receive:\n ", canary.pseudonymizer.redact(prompt).text);
}

await new Promise((ok) => setTimeout(ok, 200));
stop();
const { signed, coarse } = await canary.report();
console.log("\ncoverage:", JSON.stringify(signed.report.rpc), JSON.stringify(signed.report.llm));
console.log("on-chain form:", JSON.stringify(coarse));
