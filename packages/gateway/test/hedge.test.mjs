// Hedged reads: a stalled anon read is re-sent on a fresh circuit (new
// isolation key) and the first answer wins; a broadcast is never sent twice.
// Uses a fake backend, so it needs no Chrome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../dist/index.js";

const ADDR = "0x5Ca1ab1e00000000000000000000000000C0FfEe";

/** A backend whose circuit for the agent's own key never answers; any other key answers at once. */
function stallingBackend() {
  const calls = [];
  return {
    calls,
    name: "fake",
    ready: Promise.resolve(),
    status: () => ({ backend: "fake", network: "fake", state: "ready", restarts: 0 }),
    async fetch(url, init) {
      const key = init?.anonOptions?.isolationKey ?? "shared";
      const body = JSON.parse(init.body);
      calls.push({ key, method: (Array.isArray(body) ? body[0] : body).method });
      if (!key.includes("#hedge")) {
        // the stuck circuit: hangs until aborted
        await new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
      }
      const one = (c) => ({ jsonrpc: "2.0", id: c.id, result: c.method === "eth_sendRawTransaction" ? "0x" + "ab".repeat(32) : "0x2a" });
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { headers: { "content-type": "application/json" } });
    },
    close: async () => {},
  };
}

const rpc = async (url, method, params = []) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }) })).json();

test("a stalled read is answered through a fresh circuit, and that circuit is kept", async () => {
  const backend = stallingBackend();
  const g = await createGateway({ backend, port: 0, proxyPort: false, hedgeMs: 200, timeoutMs: 5000, wallets: [ADDR], chains: { 1: { read: "https://read.example/" } } });
  try {
    const t0 = Date.now();
    const r = await rpc(g.rpcUrl(1), "eth_getBalance", [ADDR, "latest"]);
    const ms = Date.now() - t0;
    assert.equal(r.result, "0x2a");
    assert.equal(r.id, 7);
    assert.ok(ms < 2000, `answered by the hedge, not the timeout (${ms} ms)`);
    const keys = backend.calls.map((c) => c.key);
    assert.ok(keys[0].startsWith("addr:"), "first try under the wallet's key");
    assert.ok(keys[1].startsWith(keys[0] + "#hedge"), "hedge key derived from the wallet's key");

    // The next read about the same wallet goes straight to the circuit that worked.
    backend.calls.length = 0;
    const t1 = Date.now();
    assert.equal((await rpc(g.rpcUrl(1), "eth_getBalance", [ADDR, "latest"])).result, "0x2a");
    assert.ok(Date.now() - t1 < 150, "no hedge delay once the working circuit is known");
    assert.equal(backend.calls.length, 1);
    assert.ok(backend.calls[0].key.includes("#hedge"));
    const counts = (await g.report()).signed.report.rpc;
    assert.equal(counts.protected, 2);
    assert.equal(counts.failedClosed, 0);
  } finally {
    await g.close();
  }
});

test("a broadcast is never hedged (sent once, fails closed if the circuit is stuck)", async () => {
  const backend = stallingBackend();
  const g = await createGateway({ backend, port: 0, proxyPort: false, hedgeMs: 100, timeoutMs: 800, wallets: [ADDR], chains: { 1: { read: "https://read.example/" } }, manifest: { v: 1, hosts: {}, undeclared: "block", rpc: { write: "anon" } } });
  try {
    const r = await rpc(g.rpcUrl(1), "eth_sendRawTransaction", ["0x02f8"]);
    assert.ok(r.error, "fails closed instead of a second send");
    assert.equal(backend.calls.filter((c) => c.method === "eth_sendRawTransaction").length, 1);
  } finally {
    await g.close();
  }
});
