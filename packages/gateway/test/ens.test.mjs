// Gateway + ENSv2: policy from the agent's name (live updates, fail closed while
// missing), signed report published by the report key over anon-rpc, revocation.
// Local chain: ganache + mock ENSv2 contracts (packages/ens/test).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createGateway, startChromiumBackend } from "../dist/index.js";
import { readAgentPrivacy, policyHashOf, setTextRecord, grantTextKey, revokeTextKey, TEXT_KEYS } from "@canary/ens";
import { startFixtures, mapTestHosts, CHROME_OPTS } from "./fixtures.mjs";
import { startChain, KEYS } from "../../ens/test/chain.mjs";

mapTestHosts();
const NAME = "trader-01.agents.canary.eth";
let fx, backend, ch, gw, resolver, owner, reporterAddr;

const until = async (pred, ms = 10000, what = "condition") => {
  const end = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const status = async () => (await fetch(gw.url + "/canary/status")).json();
const get = (url) => fetch(gw.url + "/canary/fetch", { headers: { "x-canary-url": url } });

before(async () => {
  fx = await startFixtures();
  ch = await startChain();
  resolver = await ch.nameWithResolver(NAME);
  owner = { wallet: ch.owner, client: ch.client };
  reporterAddr = ch.address(KEYS.reporter);
  backend = await startChromiumBackend({ network: fx.network, ...CHROME_OPTS, args: fx.chromiumArgs });
  await backend.ready;
  gw = await createGateway({
    backend,
    port: 0,
    proxyPort: false,
    timeoutMs: 10000,
    reportKey: KEYS.reporter,
    chains: { 11155111: { read: ch.url } },
    ens: { name: NAME, chainId: 11155111, universalResolverAddress: ch.universal, refreshMs: 300, publishEveryMs: 0, evidenceUri: "https://example.org/reports/" },
  });
});
after(async () => {
  await gw?.close();
  await backend?.close();
  await ch?.close();
  await fx?.close();
});

test("no manifest on the name yet: the gateway fails closed and says why", async () => {
  await until(async () => (await status()).ens.manifest.state === "error", 10000, "manifest error state");
  const s = await status();
  assert.match(s.ens.manifest.error, /no privacy\.manifest/);
  assert.equal((await get(fx.url("api.test", "/x"))).status, 403);
});

test("the policy is read from ENS over anon-rpc, and changes on chain apply live", async () => {
  const manifest = { v: 1, agent: NAME, hosts: { "api.test": "direct" }, undeclared: "block", rpc: { write: "anon" }, reporter: reporterAddr };
  await setTextRecord(owner, resolver, NAME, TEXT_KEYS.manifest, JSON.stringify(manifest));
  await until(async () => (await get(fx.url("api.test", "/x"))).status === 200, 10000, "api.test allowed");
  let s = await status();
  assert.equal(s.ens.manifest.state, "loaded");
  assert.equal(s.policyHash, policyHashOf(gw.manifest));
  assert.equal(s.ens.reporterDeclared, true);
  assert.ok(gw.ledger.counts.rpc.protected > 0, "ENS reads went through the anon path");
  assert.equal(gw.ledger.counts.rpc.direct, 0);

  // demo beat: remove the host on chain → the agent's call is blocked without a restart
  await setTextRecord(owner, resolver, NAME, TEXT_KEYS.manifest, JSON.stringify({ ...manifest, hosts: {} }));
  await until(async () => (await get(fx.url("api.test", "/x"))).status === 403, 10000, "api.test blocked");
  s = await status();
  assert.equal(s.policyHash, policyHashOf({ ...gw.manifest }));
});

test("publishing needs the one-key role; the report goes on chain signed and verifiable", async () => {
  let r = await fetch(gw.url + "/canary/publish", { method: "POST" });
  assert.equal(r.status, 409, "not granted yet");
  assert.equal((await r.json()).ens.reportRole, "not-granted");

  await grantTextKey(owner, resolver, NAME, TEXT_KEYS.report, reporterAddr);
  r = await fetch(gw.url + "/canary/publish", { method: "POST" });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.match(body.tx, /^0x[0-9a-f]{64}$/);
  assert.equal(gw.ledger.counts.rpc.direct, 0, "the publish transaction went out over anon-rpc too");

  const p = await readAgentPrivacy(ch.client, NAME, { universalResolverAddress: ch.universal, policyHashOf });
  assert.deepEqual(p.checks, { reportSigned: true, signerIsReporter: true, policyMatches: true, reporterCanWrite: true, reporterRevoked: false });
  assert.equal(p.report.evidenceUri, "https://example.org/reports/");
  assert.equal(p.report.agent, NAME);
  assert.ok(!("hosts" in p.report) && !("latencyMs" in p.report), "only the coarse form is public");
  assert.equal((await status()).ens.lastPublish.tx, body.tx);
});

test("revoking the role silences reporting, visibly", async () => {
  await revokeTextKey(owner, resolver, NAME, TEXT_KEYS.report, reporterAddr);
  const r = await fetch(gw.url + "/canary/publish", { method: "POST" });
  assert.equal(r.status, 409);
  const s = (await r.json()).ens;
  assert.equal(s.reportRole, "revoked");
  const p = await readAgentPrivacy(ch.client, NAME, { universalResolverAddress: ch.universal, policyHashOf });
  assert.equal(p.checks.reporterRevoked, true);
  assert.equal(p.checks.reporterCanWrite, false);
});

test("a local manifest wins over ENS, and ens.chainId must be a configured chain", async () => {
  const g2 = await createGateway({ backend, port: 0, proxyPort: false, chains: { 11155111: { read: ch.url } }, manifest: { v: 1, hosts: { "x.test": "direct" } }, ens: { name: NAME, chainId: 11155111, universalResolverAddress: ch.universal, publishEveryMs: 0 } });
  assert.equal((await (await fetch(g2.url + "/canary/status")).json()).ens.manifest.source, "local");
  assert.deepEqual(g2.manifest.hosts, { "x.test": "direct" });
  await g2.close();
  await assert.rejects(createGateway({ backend, port: 0, proxyPort: false, chains: { 1: { read: ch.url } }, ens: { name: NAME, chainId: 11155111 } }), /not in chains/);
});
