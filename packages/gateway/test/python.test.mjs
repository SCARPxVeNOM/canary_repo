// examples/python-agent/agent.py against a gateway: zero code changes, only
// RPC_URL and the proxy variables. Skipped when python3 isn't installed.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createGateway, startChromiumBackend } from "../dist/index.js";
import { startFixtures, mapTestHosts, CHROME_OPTS, CHAIN_ID } from "./fixtures.mjs";

mapTestHosts();
const AGENT = resolve(import.meta.dirname, "../../../examples/python-agent/agent.py");
const PY = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
let hasPython = true;
try {
  execFileSync(PY, ["--version"]);
} catch {
  hasPython = false;
}

let fx, backend, gw;
before(async () => {
  if (!hasPython) return;
  fx = await startFixtures();
  backend = await startChromiumBackend({ network: fx.network, ...CHROME_OPTS, args: fx.chromiumArgs });
  await backend.ready;
  gw = await createGateway({
    backend,
    port: 0,
    proxyPort: 0,
    chains: { [CHAIN_ID]: { read: fx.url("read.test") } },
    manifest: { v: 1, hosts: { "anon-api.test": "anon" }, undeclared: "block" },
  });
});
after(async () => {
  await gw?.close();
  await backend?.close();
  await fx?.close();
});

const run = (env) =>
  new Promise((ok, fail) =>
    execFile(PY, [AGENT], { env: { PATH: process.env.PATH, ...env }, timeout: 60000 }, (err, stdout, stderr) => {
      const lines = stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      if (err && !lines.length) return fail(new Error(stderr || err.message));
      ok(lines);
    }),
  );

test("python agent: chain reads via anon-rpc, other HTTP by manifest rule", { skip: !hasPython && "python3 not installed" }, async () => {
  fx.reset();
  const proxy = gw.proxyUrl;
  const lines = await run({
    RPC_URL: gw.rpcUrl(CHAIN_ID),
    WALLET: "0x5ca1ab1e00000000000000000000000000c0ffee",
    PRICE_URL: fx.url("anon-api.test", "/price"),
    UNDECLARED_URL: fx.url("undeclared.test", "/x"),
    HTTP_PROXY: proxy, http_proxy: proxy, HTTPS_PROXY: proxy, https_proxy: proxy,
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  });
  const by = Object.fromEntries(lines.map((l) => [l.step, l]));
  assert.equal(by.chain.block, 0x222);
  assert.equal(by.chain.balance_wei, 2);
  assert.ok(fx.logs.read.length >= 2 && fx.logs.read.every((l) => l.origin === "null"), "reads left from the anon-rpc worker");
  assert.equal(by.price.status, 200);
  assert.equal(by.price.decision, "anon");
  assert.equal(fx.logs.api.find((l) => l.host === "anon-api.test").origin, "null");
  assert.equal(by.undeclared.status, 403);
  assert.equal(by.undeclared.decision, "blocked");
  assert.ok(!fx.logs.api.some((l) => l.host === "undeclared.test"));
});

test("python agent: anon path down means an RPC error, not a direct request", { skip: !hasPython && "python3 not installed" }, async () => {
  fx.reset();
  fx.state.readDown = true;
  try {
    const lines = await run({ RPC_URL: gw.rpcUrl(CHAIN_ID), NO_PROXY: "*", no_proxy: "*" });
    assert.equal(lines.at(-1).step, "error");
    assert.match(lines.at(-1).error, /eth_blockNumber/);
  } finally {
    fx.state.readDown = false;
  }
});
