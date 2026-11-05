import { test } from "node:test";
import assert from "node:assert/strict";
import { Pseudonymizer, UnknownAliasError } from "../dist/index.js";

const W1 = "0x5Ca1aB1E00000000000000000000000000C0ffeE";
const W2 = "0xb0b0000000000000000000000000000000000b0b";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const OTHER = "0x1111111111111111111111111111111111111111";
const TX = "0x" + "ab".repeat(32);

const mk = () => new Pseudonymizer({ wallets: [W1, W2], agentNames: ["trader-01.agents.canary.eth"], allow: [USDC] });

test("wallets, other addresses, hashes and the agent's name are replaced; allow-listed contracts pass", () => {
  const p = mk();
  const { text, count } = p.redact(`I am trader-01.agents.canary.eth. Wallet ${W1} (also ${W1.toLowerCase()}) and ${W2} hold USDC ${USDC}. Pay ${OTHER}. Last tx ${TX}.`);
  assert.equal(text, `I am AGENT_NAME. Wallet WALLET_1 (also WALLET_1) and WALLET_2 hold USDC ${USDC}. Pay ADDR_1. Last tx HASH_1.`);
  assert.equal(count, 6, "USDC is allow-listed, not counted");
});

test("bare 40-hex is replaced only for the agent's own wallets; hex blobs are left alone", () => {
  const p = mk();
  const calldata = "0xa9059cbb" + "0".repeat(24) + W1.slice(2).toLowerCase() + "0".repeat(64);
  const { text } = p.redact(`raw ${W1.slice(2)} other ${OTHER.slice(2)} data ${calldata}`);
  assert.ok(text.startsWith("raw WALLET_1 other " + OTHER.slice(2)));
  assert.ok(text.endsWith(calldata), "an address inside calldata is not touched (declared gap)");
});

test("aliases are stable across requests and restore to the original casing", () => {
  const p = mk();
  p.redact(`a ${OTHER}`);
  assert.equal(p.redact(`again ${OTHER}`).text, "again ADDR_1");
  assert.equal(p.restore("send to WALLET_1 and ADDR_1, see HASH_9").text, `send to ${W1} and ${OTHER}, see HASH_9`);
  assert.deepEqual(p.restore("HASH_9").unknown, ["HASH_9"]);
});

test("restoreDeep: tool-call arguments; strict mode refuses invented aliases", () => {
  const p = mk();
  p.redact(OTHER);
  assert.deepEqual(p.restoreDeep({ to: "ADDR_1", from: ["WALLET_2"], amount: 5n }), { to: OTHER, from: [W2], amount: 5n });
  assert.throws(() => p.restoreDeep({ to: "WALLET_9" }, { strict: true }), UnknownAliasError);
});

test("restoreTextStream: an alias split across chunks is restored whole", async () => {
  const p = mk();
  const chunks = ["Sending from WAL", "LET_", "1 to AD", "DR", "ESS book; ", "WALLET_2"];
  const out = [];
  await new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } })
    .pipeThrough(p.restoreTextStream())
    .pipeTo(new WritableStream({ write: (x) => out.push(x) }));
  assert.equal(out.join(""), `Sending from ${W1} to ADDRESS book; ${W2}`);
});
