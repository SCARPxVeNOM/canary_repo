// Unit tests for src/rpc-pipeline.ts: batching, caching, dedupe, fallbacks.
//   node --test test/pipeline.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcPipeline } from "../src/rpc-pipeline.ts";

const A = "https://read.example/";
const B = "https://other.example/";

/** A fake anon path: records each request and answers like a node would. */
function fakeSend({ batch = true, status = 200, drop = [], maxBatch = Infinity } = {}) {
  const sent = [];
  let block = 100;
  const answer = (m) => {
    if (m.method === "eth_blockNumber") return { jsonrpc: "2.0", id: m.id, result: "0x" + (block++).toString(16) };
    if (m.method === "eth_getCode") return { jsonrpc: "2.0", id: m.id, result: m.params[0] === "0xempty" ? "0x" : "0x6080" };
    if (m.method === "fail") return { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "nope" } };
    return { jsonrpc: "2.0", id: m.id, result: `${m.method}:${JSON.stringify(m.params)}` };
  };
  const send = async (target, body, key) => {
    const v = JSON.parse(body);
    sent.push({ target, key, size: Array.isArray(v) ? v.length : 1, methods: (Array.isArray(v) ? v : [v]).map((m) => m.method) });
    await new Promise((r) => setTimeout(r, 5));
    if (status !== 200) return { status, text: "{}" };
    if (Array.isArray(v) && v.length > maxBatch) return { status: 400, text: JSON.stringify(v.map((m) => ({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: `Batch of more than ${maxBatch} requests are not allowed` } }))) };
    if (Array.isArray(v) && !batch) return { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch not supported" } }) };
    if (Array.isArray(v)) return { status: 200, text: JSON.stringify(v.filter((m) => !drop.includes(m.method)).map(answer).reverse()) };
    return { status: 200, text: JSON.stringify(answer(v)) };
  };
  return { send, sent };
}
const bal = (addr) => ({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [addr, "latest"] });

test("calls within the window leave as one batch, answers mapped back in order", async () => {
  const f = fakeSend();
  const p = new RpcPipeline(f.send);
  const addrs = Array.from({ length: 5 }, (_, i) => "0x" + String(i).repeat(40));
  const outs = await Promise.all(addrs.map((a) => p.call(A, bal(a))));
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].size, 5);
  outs.forEach((o, i) => assert.equal(o.answer.result, `eth_getBalance:${JSON.stringify([addrs[i], "latest"])}`));
  assert.deepEqual({ requests: p.stats.requests, batchedCalls: p.stats.batchedCalls }, { requests: 1, batchedCalls: 5 });
});

test("never batches across isolation keys or endpoints", async () => {
  const f = fakeSend();
  const p = new RpcPipeline(f.send);
  await Promise.all([p.call(A, bal("0x1"), "addr:1"), p.call(A, bal("0x2"), "addr:2"), p.call(A, bal("0x3")), p.call(B, bal("0x4"), "addr:1")]);
  assert.equal(f.sent.length, 4);
  assert.deepEqual(f.sent.map((s) => s.key).sort(), [undefined, "addr:1", "addr:1", "addr:2"].sort());
});

test("maxBatch splits a burst", async () => {
  const f = fakeSend();
  const p = new RpcPipeline(f.send, { maxBatch: 20 });
  await Promise.all(Array.from({ length: 45 }, (_, i) => p.call(A, bal("0x" + i))));
  assert.deepEqual(f.sent.map((s) => s.size), [20, 20, 5]);
});

test("identical calls in flight share one request", async () => {
  const f = fakeSend();
  const p = new RpcPipeline(f.send);
  const [a, b] = await Promise.all([p.call(A, bal("0xaa")), p.call(A, bal("0xaa"))]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].size, 1);
  assert.equal(a.answer.result, b.answer.result);
  assert.deepEqual([a.source, b.source].sort(), ["network", "shared"]);
});

test("eth_chainId and net_version are cached for good; seeded values need no request", async () => {
  const f = fakeSend();
  const p = new RpcPipeline(f.send);
  await p.call(B, { method: "eth_chainId", params: [] });
  const again = await p.call(B, { method: "eth_chainId", params: [] });
  assert.equal(again.source, "cache");
  p.seed(A, "eth_chainId", [], "0xaa36a7");
  const seeded = await p.call(A, { method: "eth_chainId", params: [] });
  assert.deepEqual(seeded, { answer: { result: "0xaa36a7" }, source: "cache" });
  assert.equal(f.sent.length, 1);
});

test("eth_blockNumber is cached for blockTtlMs only", async () => {
  let now = 0;
  const f = fakeSend();
  const p = new RpcPipeline(f.send, { now: () => now, blockTtlMs: 2000 });
  const a = await p.call(A, { method: "eth_blockNumber", params: [] });
  now = 1500;
  const b = await p.call(A, { method: "eth_blockNumber", params: [] });
  now = 2500;
  const c = await p.call(A, { method: "eth_blockNumber", params: [] });
  assert.equal(a.answer.result, b.answer.result);
  assert.equal(b.source, "cache");
  assert.notEqual(c.answer.result, a.answer.result);
  assert.equal(f.sent.length, 2);
});

test("eth_getCode: deployed code is cached, empty code is not, historical blocks keyed separately", async () => {
  const f = fakeSend();
  const p = new RpcPipeline(f.send);
  const code = (addr, tag = "latest") => ({ method: "eth_getCode", params: [addr, tag] });
  await p.call(A, code("0xC0DE"));
  assert.equal((await p.call(A, code("0xc0de", "pending"))).source, "cache"); // latest ≈ pending, address case-insensitive
  assert.equal((await p.call(A, code("0xc0de", "0x10"))).source, "network");
  await p.call(A, code("0xempty"));
  assert.equal((await p.call(A, code("0xempty"))).source, "network");
});

test("JSON-RPC errors are passed through and never cached", async () => {
  const f = fakeSend();
  const p = new RpcPipeline(f.send);
  const o = await p.call(A, { method: "fail", params: [] });
  assert.deepEqual(o.answer.error, { code: -32000, message: "nope" });
});

test("an endpoint that rejects batches gets the calls one by one", async () => {
  const f = fakeSend({ batch: false });
  const p = new RpcPipeline(f.send);
  const outs = await Promise.all([p.call(A, bal("0x1")), p.call(A, bal("0x2")), p.call(A, bal("0x3"))]);
  assert.deepEqual(f.sent.map((s) => s.size), [3, 1, 1, 1]);
  assert.ok(outs.every((o) => o.answer.result?.startsWith("eth_getBalance")));
});

test("an endpoint that refuses a large batch (HTTP 400) gets halves, and later bursts that size", async () => {
  const f = fakeSend({ maxBatch: 3 });
  const p = new RpcPipeline(f.send);
  const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => p.call(A, bal("0x" + i))));
  assert.ok(outs.every((o) => o.answer.result?.startsWith("eth_getBalance")));
  assert.deepEqual(f.sent.map((s) => s.size), [10, 5, 5, 3, 2, 3, 2]);
  f.sent.length = 0;
  await Promise.all(Array.from({ length: 7 }, (_, i) => p.call(A, bal("0x1" + i))));
  assert.deepEqual(f.sent.map((s) => s.size), [3, 3, 1]);
  // another endpoint keeps its own size
  f.sent.length = 0;
  await Promise.all([p.call(B, bal("0x1")), p.call(B, bal("0x2"))]);
  assert.deepEqual(f.sent.map((s) => s.size), [2]);
});

test("a call missing from a batch answer is retried alone", async () => {
  const f = fakeSend({ drop: ["eth_getStorageAt"] });
  let first = true;
  const send = (t, b, k) => {
    if (!first) return fakeSend().send(t, b, k).then((r) => (f.sent.push({ size: 1 }), r));
    first = false;
    return f.send(t, b, k);
  };
  const p = new RpcPipeline(send);
  const outs = await Promise.all([p.call(A, bal("0x1")), p.call(A, { method: "eth_getStorageAt", params: ["0x1", "0x0", "latest"] })]);
  assert.ok(outs[1].answer.result.startsWith("eth_getStorageAt"));
  assert.deepEqual(f.sent.map((s) => s.size), [2, 1]);
});

test("transport failure rejects every call in the batch (Canary fails closed above this)", async () => {
  const f = fakeSend({ status: 503 });
  const p = new RpcPipeline(f.send);
  const rs = await Promise.allSettled([p.call(A, bal("0x1")), p.call(A, bal("0x2"))]);
  assert.ok(rs.every((r) => r.status === "rejected" && /HTTP 503/.test(r.reason.message)));
  assert.equal(f.sent.length, 1);
});

test("an EIP-7702 delegation (0xef0100…) is never cached: the account can re-delegate", async () => {
  let n = 0;
  const p = new RpcPipeline(async (t, body) => ({ status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: "0xef0100" + String(++n).repeat(40) }) }));
  const a = await p.call(A, { method: "eth_getCode", params: ["0xeoa", "latest"] });
  const b = await p.call(A, { method: "eth_getCode", params: ["0xeoa", "latest"] });
  assert.equal(b.source, "network");
  assert.notEqual(a.answer.result, b.answer.result);
});
