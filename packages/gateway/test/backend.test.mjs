// Spike (agent-sdk.md §6, hour 0–3): headless Chromium boots
// @anon-rpc/browser-harness, and the gateway's Node process reaches
// worker.fetch over the loopback WebSocket bridge, with streamed bodies.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startChromiumBackend } from "../dist/index.js";
import { startFixtures, mapTestHosts, CHROME_OPTS } from "./fixtures.mjs";

mapTestHosts();
let fx, backend;

before(async () => {
  fx = await startFixtures();
  backend = await startChromiumBackend({ network: fx.network, ...CHROME_OPTS, args: fx.chromiumArgs });
  await backend.ready;
});
after(async () => {
  await backend?.close();
  await fx?.close();
});

test("worker boots from the specifier, hash-verified, and reports ready", () => {
  const s = backend.status();
  assert.equal(s.state, "ready");
  assert.equal(typeof s.bootMs, "number");
  assert.ok(fx.logs.chain.some((r) => r.includes("eth_call")), "specifier was read via the bootstrap RPC");
});

test("eth_blockNumber through worker.fetch", async () => {
  const r = await backend.fetch(fx.url("read.test"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "eth_blockNumber", params: [] }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { jsonrpc: "2.0", id: 7, result: "0x222" });
  assert.equal(fx.logs.read.at(-1).origin, "null", "request left from the worker's null origin");
});

test("isolationKey reaches the worker without being sent to the destination", async () => {
  fx.reset();
  const r = await backend.fetch(fx.url("read.test"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }),
    anonOptions: { isolationKey: "addr:0xabc" },
  });
  assert.equal(r.status, 200);
  assert.ok(!fx.logs.read.at(-1).raw.includes("addr:0xabc"));
});

test("a large body streams across the bridge intact (16 MB)", async () => {
  const t0 = Date.now();
  const r = await backend.fetch(fx.url("big.test", "/?mb=16"));
  let n = 0, chunks = 0, bad = false;
  for await (const c of r.body) {
    n += c.byteLength;
    chunks++;
    if (c[0] !== 0x61 || c[c.byteLength - 1] !== 0x61) bad = true;
  }
  assert.equal(n, 16 * 1024 * 1024);
  assert.equal(bad, false);
  assert.ok(chunks > 1, `arrived in ${chunks} chunks`);
  console.log(`  16 MB in ${chunks} chunks, ${Date.now() - t0} ms`);
});

test("concurrent calls each get their own response", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => i + 100);
  const rs = await Promise.all(
    ids.map((id) =>
      backend.fetch(fx.url("read.test"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "eth_getBalance", params: [] }) }).then((r) => r.json()),
    ),
  );
  assert.deepEqual(rs.map((r) => r.id), ids);
});

test("abort rejects, and the bridge keeps working afterwards", async () => {
  fx.state.readDelayMs = 2000;
  const ac = new AbortController();
  const p = backend.fetch(fx.url("read.test"), { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" }), signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(p);
  fx.state.readDelayMs = 0;
  const r = await backend.fetch(fx.url("read.test"), { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_blockNumber" }) });
  assert.equal((await r.json()).id, 2);
});

test("a destination that is down is an error response or a rejection, never a direct retry", async () => {
  fx.state.readDown = true;
  fx.reset();
  const r = await backend.fetch(fx.url("read.test"), { method: "POST", body: "{}" });
  assert.equal(r.status, 503);
  fx.state.readDown = false;
  await assert.rejects(backend.fetch("http://nowhere.invalid/", { method: "POST", body: "{}" }));
});

test("a worker that fails to boot fails closed, then recovers on its own", async () => {
  fx.state.chainDown = true;
  const b2 = await startChromiumBackend({ network: fx.network, ...CHROME_OPTS, args: fx.chromiumArgs });
  try {
    const until = async (pred, ms) => {
      const end = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > end) throw new Error(`timed out; status ${JSON.stringify(b2.status())}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await until(() => b2.status().state === "failed", 15000);
    await assert.rejects(b2.fetch(fx.url("read.test"), { method: "POST", body: "{}" }), /anon path down/);
    fx.state.chainDown = false;
    await until(() => b2.status().state === "ready", 15000);
    assert.ok(b2.status().restarts >= 1);
    const r = await b2.fetch(fx.url("read.test"), { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "eth_blockNumber" }) });
    assert.equal((await r.json()).result, "0x222");
  } finally {
    fx.state.chainDown = false;
    await b2.close();
  }
});

test("Chromium dies mid-request: the call fails closed and the backend relaunches", async () => {
  const b3 = await startChromiumBackend({ network: fx.network, ...CHROME_OPTS, args: fx.chromiumArgs });
  try {
    await b3.ready;
    fx.state.readDelayMs = 3000;
    const p = b3.fetch(fx.url("read.test"), { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" }) });
    const failed = assert.rejects(p, /anon path down/);
    await new Promise((r) => setTimeout(r, 200));
    await b3["browser"].close();
    await failed;
    fx.state.readDelayMs = 0;
    const end = Date.now() + 15000;
    while (b3.status().state !== "ready" && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.equal(b3.status().state, "ready");
    assert.equal(b3.status().restarts, 1, "exactly one relaunch");
    const r = await b3.fetch(fx.url("read.test"), { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "eth_blockNumber" }) });
    assert.equal((await r.json()).id, 4);
  } finally {
    fx.state.readDelayMs = 0;
    await b3.close();
  }
});
