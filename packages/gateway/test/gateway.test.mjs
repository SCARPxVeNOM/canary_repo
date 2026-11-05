// Gateway: JSON-RPC endpoint, HTTP(S) proxy, /canary/fetch, reports.
// One headless Chromium (passthrough worker) shared by every gateway here.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createGateway, startChromiumBackend, verifyReport } from "../dist/index.js";
import { startFixtures, mapTestHosts, CHROME_OPTS, CHAIN_ID } from "./fixtures.mjs";

mapTestHosts();
const A = "0x5ca1ab1e00000000000000000000000000c0ffee";
const B = "0xb0b0000000000000000000000000000000000b0b";
const REPORT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const REPORT_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const pad = (a) => "0".repeat(24) + a.slice(2);

let fx, backend, gw;
const rpc = async (body, chain = CHAIN_ID) => {
  const r = await fetch(gw.rpcUrl(chain), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
};
const call = (id, method, params = []) => ({ jsonrpc: "2.0", id, method, params });

before(async () => {
  fx = await startFixtures();
  backend = await startChromiumBackend({ network: fx.network, ...CHROME_OPTS, args: fx.chromiumArgs });
  await backend.ready;
  gw = await createGateway({
    backend,
    port: 0,
    proxyPort: 0,
    timeoutMs: 5000,
    reportKey: REPORT_KEY,
    wallets: [A, B],
    chains: { [CHAIN_ID]: { read: fx.url("read.test"), upstream: fx.url("upstream.test") } },
    manifest: {
      v: 1,
      agent: "trader-01.agents.canary.eth",
      hosts: { "api.test": "direct", "anon-api.test": "anon", "blocked.test": "block" },
      undeclared: "block",
      rpc: { write: "anon" },
    },
  });
});
after(async () => {
  await gw?.close();
  await backend?.close();
  await fx?.close();
});

test("standard reads are substituted: read endpoint over anon-rpc, upstream sees nothing", async () => {
  fx.reset();
  const r = await rpc(call(1, "eth_getBalance", [A, "latest"]));
  assert.equal(r.result, "0x2");
  assert.equal(fx.logs.read.length, 1);
  assert.equal(fx.logs.read[0].origin, "null", "left from the worker's null origin");
  assert.equal(fx.logs.upstream.length, 0);
});

test("eth_chainId and net_version are answered locally", async () => {
  fx.reset();
  assert.equal((await rpc(call(1, "eth_chainId"))).result, "0xaa36a7");
  assert.equal((await rpc(call(2, "net_version"))).result, "11155111");
  assert.equal(fx.logs.read.length + fx.logs.upstream.length, 0);
});

test("non-standard methods are forwarded to the upstream over anon-rpc (IP only)", async () => {
  fx.reset();
  const r = await rpc(call(1, "alchemy_getTokenBalances", [A]));
  assert.deepEqual(r.result, { from: "upstream" });
  assert.equal(fx.logs.upstream[0].origin, "null");
});

test("a batch is split per wallet; answers come back in order with the agent's ids", async () => {
  fx.reset();
  const r = await rpc([call("a", "eth_getBalance", [A, "latest"]), call("b", "eth_getBalance", [B, "latest"]), call(7, "eth_blockNumber"), call("c", "eth_chainId")]);
  assert.deepEqual(r.map((x) => x.id), ["a", "b", 7, "c"]);
  assert.deepEqual(r.map((x) => x.result), ["0x2", "0x2", "0x222", "0xaa36a7"]);
  const raws = new Set(fx.logs.read.map((l) => l.raw));
  assert.equal(raws.size, 3, "three separate requests: wallet A, wallet B, no wallet");
  for (const raw of raws) assert.ok(!(raw.toLowerCase().includes(A.slice(2)) && raw.toLowerCase().includes(B.slice(2))), "no request carries both wallets");
});

test("a single call carrying two agent addresses is counted as linking wallets", async () => {
  const before = gw.ledger.counts.rpc.linked;
  await rpc(call(1, "eth_call", [{ to: "0x" + "11".repeat(20), data: "0x12345678" + pad(A) + pad(B) }, "latest"]));
  assert.equal(gw.ledger.counts.rpc.linked, before + 1);
});

test("eth_getCode is cached", async () => {
  fx.reset();
  const c = call(1, "eth_getCode", ["0x" + "22".repeat(20), "latest"]);
  assert.equal((await rpc(c)).result, "0x6001");
  assert.equal((await rpc(c)).result, "0x6001");
  assert.equal(fx.logs.read.length, 1);
});

test("node-side signing is refused; raw transactions go out over anon-rpc", async () => {
  fx.reset();
  const s = await rpc(call(1, "eth_sendTransaction", [{ from: A }]));
  assert.match(s.error.message, /never signs/);
  const t = await rpc(call(2, "eth_sendRawTransaction", ["0x02f8"]));
  assert.equal(t.result, "0x" + "ab".repeat(32));
  assert.equal(fx.logs.read.at(-1).method, "eth_sendRawTransaction");
  assert.equal(fx.logs.read.at(-1).origin, "null");
});

test("read endpoint down: fail closed with a JSON-RPC error, no direct retry", async () => {
  fx.reset();
  fx.state.readDown = true;
  const before = gw.ledger.counts.rpc.failedClosed;
  const r = await rpc(call(1, "eth_blockNumber"));
  fx.state.readDown = false;
  assert.ok(r.error, "an error, not a result");
  assert.equal(gw.ledger.counts.rpc.failedClosed, before + 1);
  assert.equal(fx.logs.upstream.length, 0);
});

test("anon backend down: every call fails closed", async () => {
  const dead = { name: "dead", ready: Promise.resolve(), status: () => ({ backend: "dead", network: "x", state: "failed", restarts: 0 }), fetch: () => Promise.reject(new Error("worker gone")), close: async () => {} };
  const g2 = await createGateway({ backend: dead, port: 0, proxyPort: false, chains: { 1: { read: fx.url("read.test") } } });
  fx.reset();
  const r = await (await fetch(g2.rpcUrl(1), { method: "POST", body: JSON.stringify([call(1, "eth_blockNumber"), call(2, "eth_chainId")]) })).json();
  assert.match(r[0].error.message, /anon path failed: worker gone/);
  assert.equal(r[1].result, "0x1", "local answers still work");
  assert.equal(fx.logs.read.length, 0);
  await g2.close();
});

test("unknown chain and non-JSON-RPC bodies", async () => {
  assert.match((await rpc(call(1, "eth_blockNumber"), 999)).error.message, /not configured/);
  const r = await fetch(gw.rpcUrl(CHAIN_ID), { method: "POST", body: "hello" });
  assert.equal(r.status, 400);
});

test("the control API refuses non-loopback Host headers and browser origins", async () => {
  const get = (headers) => new Promise((ok) => http.get(gw.url + "/canary/status", { headers }, (r) => (r.resume(), ok(r.statusCode))));
  assert.equal(await get({}), 200);
  assert.equal(await get({ host: "evil.example:18545" }), 403);
  assert.equal(await get({ origin: "https://evil.example" }), 403);
});

/* --- HTTP(S) proxy ------------------------------------------------------ */

const viaProxy = (url, { method = "GET", body } = {}) =>
  new Promise((ok, fail) => {
    const p = new URL(gw.proxyUrl);
    const req = http.request({ host: p.hostname, port: p.port, method, path: url, headers: { host: new URL(url).host } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on("error", fail);
    req.end(body);
  });

const connectVia = (target) =>
  new Promise((ok, fail) => {
    const p = new URL(gw.proxyUrl);
    const req = http.request({ host: p.hostname, port: p.port, method: "CONNECT", path: target });
    req.on("connect", (res, socket) => ok({ status: res.statusCode, headers: res.headers, socket }));
    req.on("error", fail);
    req.end();
  });

test("proxy, plain HTTP: anon host goes through anon-rpc, direct host directly, undeclared blocked", async () => {
  fx.reset();
  const a = await viaProxy(fx.url("anon-api.test", "/price"));
  assert.equal(a.status, 200);
  assert.equal(a.headers["x-canary-decision"], "anon");
  assert.equal(fx.logs.api.at(-1).origin, "null");
  const d = await viaProxy(fx.url("api.test", "/x"));
  assert.equal(d.headers["x-canary-decision"], "direct");
  assert.equal(fx.logs.api.at(-1).origin, "(none)");
  const u = await viaProxy(fx.url("undeclared.test", "/x"));
  assert.equal(u.status, 403);
  assert.equal(fx.logs.api.filter((l) => l.host === "undeclared.test").length, 0);
  assert.equal((await viaProxy(fx.url("blocked.test", "/x"))).status, 403);
});

test("proxy, CONNECT: anon needs the MITM CA (refused), direct is tunnelled, undeclared refused", async () => {
  const a = await connectVia(`anon-api.test:${fx.port}`);
  assert.equal(a.status, 403);
  assert.match(a.headers["x-canary-reason"], /MITM CA/);
  a.socket.destroy();
  const u = await connectVia(`undeclared.test:${fx.port}`);
  assert.equal(u.status, 403);
  u.socket.destroy();
  const d = await connectVia(`api.test:${fx.port}`);
  assert.equal(d.status, 200);
  const reply = await new Promise((ok) => {
    let s = "";
    d.socket.on("data", (c) => (s += c));
    d.socket.on("end", () => ok(s));
    d.socket.write(`GET /tunnel HTTP/1.1\r\nHost: api.test\r\nConnection: close\r\n\r\n`);
  });
  assert.match(reply, /"ok":true/);
  assert.ok(gw.ledger.counts.http.notInspected >= 1, "tunnelled HTTPS is counted as not inspected");
});

test("undeclared report mode: sent directly and counted, unless it carries an agent address", async () => {
  const g2 = await createGateway({ backend, port: 0, proxyPort: false, wallets: [A], chains: { 1: { read: fx.url("read.test") } }, manifest: { v: 1, hosts: {}, undeclared: "report" } });
  const f = (url, body) => fetch(g2.url + "/canary/fetch", { method: "POST", headers: { "x-canary-url": url, "content-type": "application/json" }, body });
  fx.reset();
  const ok = await f(fx.url("undeclared.test", "/a"), "{}");
  assert.equal(ok.headers.get("x-canary-decision"), "undeclared");
  assert.equal(g2.ledger.counts.http.undeclared, 1);
  const bad = await f(fx.url("undeclared.test", "/b"), JSON.stringify({ wallet: A }));
  assert.equal(bad.status, 403);
  assert.equal(fx.logs.api.length, 1);
  await g2.close();
});

test("/canary/fetch: in-process requests get the full policy, with bodies visible", async () => {
  fx.reset();
  const r = await fetch(gw.url + "/canary/fetch", { method: "POST", headers: { "x-canary-url": fx.url("anon-api.test", "/q"), "content-type": "application/json" }, body: JSON.stringify({ owner: A }) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-canary-decision"), "anon");
  assert.equal(fx.logs.api.at(-1).origin, "null");
  assert.ok(fx.logs.api.at(-1).body.includes(A), "body delivered intact");
  assert.ok(!JSON.stringify(fx.logs.api.at(-1)).includes("x-canary"), "control headers stripped");
});

test("report: EIP-712 signed by the report key, coarse form for ENS, rotate", async () => {
  const { signed, coarse } = await gw.report();
  assert.equal(signed.report.agent, "trader-01.agents.canary.eth");
  assert.equal(signed.signer, REPORT_ADDR);
  assert.equal(await verifyReport(signed), REPORT_ADDR);
  assert.ok(signed.report.rpc.total > 0);
  assert.equal(coarse.days[0] % 86400, 0, "whole-day window");
  assert.match(coarse.rpcVolume, /^(0|1-99|100-999|1k-10k|10k\+)$/);
  assert.ok(!("hosts" in coarse) && !("latencyMs" in coarse), "no per-host detail or timing on chain");
  await assert.rejects(verifyReport({ ...signed, report: { ...signed.report, agent: "other" } }), /does not match/);
  await gw.report({ rotate: true });
  assert.equal(gw.ledger.counts.rpc.total, 0);
});
