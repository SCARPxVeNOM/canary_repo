// @canary/agent against a real gateway + headless Chromium (passthrough worker).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, defineChain } from "viem";
import { createGateway, startChromiumBackend } from "@canary/gateway";
import { createCanary, UnknownAliasError } from "../dist/index.js";
import { startFixtures, mapTestHosts, CHROME_OPTS, CHAIN_ID } from "../../gateway/test/fixtures.mjs";

mapTestHosts();
const W1 = "0x5Ca1aB1E00000000000000000000000000C0ffeE";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const chain = defineChain({ id: CHAIN_ID, name: "sepolia (test)", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://unused.invalid"] } } });

let fx, backend, gw, canary;

before(async () => {
  fx = await startFixtures();
  backend = await startChromiumBackend({ network: fx.network, ...CHROME_OPTS, args: fx.chromiumArgs });
  await backend.ready;
  gw = await createGateway({
    backend,
    port: 0,
    proxyPort: false,
    timeoutMs: 5000,
    chains: { [CHAIN_ID]: { read: fx.url("read.test") } },
    manifest: { v: 1, agent: "trader-01.agents.canary.eth", hosts: { "llm.test": "direct", "anon-api.test": "anon" }, undeclared: "block", rpc: { write: "anon" }, llm: { allow: [USDC] } },
  });
  canary = await createCanary({ gateway: gw.url, wallets: [W1] });
});
after(async () => {
  await canary?.close();
  await gw?.close();
  await backend?.close();
  await fx?.close();
});

test("viem: one line, and reads go through anon-rpc to the read endpoint", async () => {
  fx.reset();
  const client = createPublicClient({ chain, transport: canary.viemTransport() });
  assert.equal(await client.getBalance({ address: W1 }), 2n);
  assert.equal(await client.getBlockNumber(), 0x222n);
  assert.equal(await client.getChainId(), CHAIN_ID);
  assert.ok(fx.logs.read.length >= 2);
  assert.ok(fx.logs.read.every((l) => l.origin === "null"));
});

test("canary.fetch: anon hosts via anon-rpc, undeclared hosts refused", async () => {
  fx.reset();
  const r = await canary.fetch(fx.url("anon-api.test", "/price?for=" + W1));
  assert.equal(r.status, 200);
  assert.equal(fx.logs.api.at(-1).origin, "null");
  const u = await canary.fetch(fx.url("undeclared.test", "/x"));
  assert.equal(u.status, 403);
  assert.equal(u.headers.get("x-canary-decision"), "blocked");
});

test("llmFetch: the provider sees aliases; the agent gets real addresses back", async () => {
  fx.reset();
  const prompt = `I am trader-01.agents.canary.eth with wallet ${W1}. Swap my USDC (${USDC}).`;
  const r = await canary.llmFetch(fx.url("llm.test", "/v1/chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: prompt }], reply: "Use WALLET_1 as AGENT_NAME." }),
  });
  const sent = fx.logs.llm.at(-1).body;
  assert.ok(!sent.toLowerCase().includes(W1.slice(2).toLowerCase()), "wallet never reached the provider");
  assert.ok(!sent.includes("trader-01"), "agent name never reached the provider");
  assert.ok(sent.includes("WALLET_1") && sent.includes("AGENT_NAME"));
  assert.ok(sent.includes(USDC), "allow-listed contract passes through");
  const j = await r.json();
  assert.equal(j.choices[0].message.content, `Use ${W1} as trader-01.agents.canary.eth.`);
  await new Promise((ok) => setTimeout(ok, 50));
  assert.ok(gw.ledger.counts.llm.addressesPseudonymized >= 2);
  assert.ok(gw.ledger.counts.llm.requests >= 1);
});

test("wrapLLM swaps an OpenAI/Anthropic-style client's fetch", () => {
  const client = { fetch: globalThis.fetch };
  canary.wrapLLM(client);
  assert.equal(client.fetch, canary.llmFetch);
  assert.throws(() => canary.wrapLLM({}), /no fetch/);
});

test("wrapTools: arguments restored before the tool runs; invented aliases fail the call", async () => {
  let got;
  const tools = canary.wrapTools({ transfer: { description: "send", execute: async (args) => ((got = args), "ok") } });
  assert.equal(await tools.transfer.execute({ to: "WALLET_1", amount: "1" }), "ok");
  assert.deepEqual(got, { to: W1, amount: "1" });
  assert.throws(() => tools.transfer.execute({ to: "WALLET_7" }), UnknownAliasError);
});

test("events and report", async () => {
  const seen = [];
  const stop = canary.on("egress", (e) => seen.push(e));
  await new Promise((ok) => setTimeout(ok, 100));
  await canary.fetch(fx.url("anon-api.test", "/again"));
  await new Promise((ok) => setTimeout(ok, 100));
  stop();
  assert.ok(seen.some((e) => e.host.startsWith("anon-api.test") && e.category === "protected"));
  const { signed, coarse } = await canary.report();
  assert.equal(signed.report.agent, "trader-01.agents.canary.eth");
  assert.ok(signed.report.llm.addressesPseudonymized >= 2);
  assert.equal(coarse.agent, "trader-01.agents.canary.eth");
});

test("embedded mode: the gateway runs inside the agent's process", async () => {
  const c2 = await createCanary({ wallets: [W1], embedded: { backend, port: 0, chains: { [CHAIN_ID]: { read: fx.url("read.test") } } } });
  const client = createPublicClient({ chain, transport: c2.viemTransport() });
  assert.equal(await client.getBalance({ address: W1 }), 2n);
  await c2.close();
});
