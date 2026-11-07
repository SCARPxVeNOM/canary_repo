// @ayush_saklani/canary-ens against mock ENSv2 contracts on a local chain, for both
// delegation APIs the ENS docs describe.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  loadManifest, readAgentPrivacy, canWriteText, setTextRecord, grantTextKey, revokeTextKey, roleHistory,
  signCoarseReport, verifyReportRecord, policyHashOf, ManifestNotFound, TEXT_KEYS,
} from "../dist/index.js";
import { startChain, KEYS } from "./chain.mjs";

let ch;
before(async () => (ch = await startChain()));
after(async () => ch?.close());

const manifestFor = (name, reporter) => ({ v: 1, agent: name, hosts: { "api.openai.com": "direct" }, undeclared: "block", rpc: { write: "anon" }, reporter });
const coarse = (name, manifest) => ({
  agent: name, policyHash: policyHashOf(manifest), reportHash: "0x" + "11".repeat(32), days: [1793836800, 1793923200],
  rpcViaAnonPct: 95, rpcVolume: "1k-10k", failedClosed: "0", blocked: "1-99", undeclared: "0", notInspected: "0", llmAddressesPseudonymized: "100-999",
});

for (const setterApi of [false, true]) {
  const api = setterApi ? "grantSetterRoles" : "authorizeTextRoles";
  test(`one-key delegation end to end (${api} resolver)`, async () => {
    const name = `trader-${setterApi ? "b" : "a"}.agents.canary.eth`;
    const resolver = await ch.nameWithResolver(name, { setterApi });
    const o = { universalResolverAddress: ch.universal };
    const owner = { wallet: ch.owner, client: ch.client };
    const reporterAddr = ch.address(KEYS.reporter);
    const reporter = { wallet: ch.wallet(KEYS.reporter), client: ch.client };

    await assert.rejects(loadManifest(ch.client, name, o), ManifestNotFound);

    // operator publishes the manifest
    const manifest = manifestFor(name, reporterAddr);
    await setTextRecord(owner, resolver, name, TEXT_KEYS.manifest, JSON.stringify(manifest));
    const loaded = await loadManifest(ch.client, name, o);
    assert.deepEqual(loaded.manifest.hosts, manifest.hosts);
    assert.equal(loaded.manifest.reporter, reporterAddr);

    // reporter can't write before the grant
    assert.equal((await canWriteText(ch.client, resolver, name, TEXT_KEYS.report, reporterAddr)).ok, false);

    // grant exactly one key
    const g = await grantTextKey(owner, resolver, name, TEXT_KEYS.report, reporterAddr);
    assert.equal(g.api, api, "detected the resolver's delegation API");
    assert.equal((await canWriteText(ch.client, resolver, name, TEXT_KEYS.report, reporterAddr)).ok, true);
    assert.equal((await canWriteText(ch.client, resolver, name, TEXT_KEYS.manifest, reporterAddr)).ok, false, "reporter can't touch the manifest");
    assert.equal((await canWriteText(ch.client, resolver, name, "url", reporterAddr)).ok, false, "...or any other key");

    // reporter publishes a signed coarse report
    const record = await signCoarseReport(coarse(name, manifest), KEYS.reporter);
    await setTextRecord(reporter, resolver, name, TEXT_KEYS.report, JSON.stringify(record));
    let p = await readAgentPrivacy(ch.client, name, { ...o, policyHashOf });
    assert.equal(p.resolver.toLowerCase(), resolver.toLowerCase());
    assert.deepEqual(p.checks, { reportSigned: true, signerIsReporter: true, policyMatches: true, reporterCanWrite: true, reporterRevoked: false });

    // operator silences the reporter: visible on chain
    const r = await revokeTextKey(owner, resolver, name, TEXT_KEYS.report, reporterAddr);
    assert.equal(r.api, api);
    p = await readAgentPrivacy(ch.client, name, { ...o, policyHashOf });
    assert.equal(p.checks.reporterCanWrite, false);
    assert.equal(p.checks.reporterRevoked, true);
    const hist = await roleHistory(ch.client, resolver, reporterAddr);
    assert.deepEqual(hist.map((h) => h.textRole), ["granted", "revoked"]);

    // the old report is still readable and still verifies; readers see it's no longer maintained
    assert.equal(p.checks.reportSigned, true);
  });
}

test("a stranger can't grant roles or write records", async () => {
  const name = "victim.agents.canary.eth";
  const resolver = await ch.nameWithResolver(name);
  const stranger = { wallet: ch.wallet(KEYS.stranger), client: ch.client };
  await assert.rejects(grantTextKey(stranger, resolver, name, TEXT_KEYS.report, ch.address(KEYS.stranger)), /could not delegate/);
  await assert.rejects(setTextRecord(stranger, resolver, name, TEXT_KEYS.manifest, "{}"));
});

test("tampered or mismatched records fail the checks", async () => {
  const name = "tamper.agents.canary.eth";
  const resolver = await ch.nameWithResolver(name);
  const owner = { wallet: ch.owner, client: ch.client };
  const reporterAddr = ch.address(KEYS.reporter);
  const manifest = manifestFor(name, reporterAddr);
  await setTextRecord(owner, resolver, name, TEXT_KEYS.manifest, JSON.stringify(manifest));

  const record = await signCoarseReport(coarse(name, manifest), KEYS.reporter);
  await assert.rejects(verifyReportRecord({ ...record, blocked: "0" }), /signed by/);

  // the owner writes a report signed by some other key: signature is valid, but not the declared reporter
  const forged = await signCoarseReport(coarse(name, manifest), KEYS.stranger);
  await setTextRecord(owner, resolver, name, TEXT_KEYS.report, JSON.stringify(forged));
  let p = await readAgentPrivacy(ch.client, name, { universalResolverAddress: ch.universal, policyHashOf });
  assert.equal(p.checks.reportSigned, true);
  assert.equal(p.checks.signerIsReporter, false);

  // policy changed after the report: policyMatches turns false
  await setTextRecord(owner, resolver, name, TEXT_KEYS.manifest, JSON.stringify({ ...manifest, undeclared: "report" }));
  p = await readAgentPrivacy(ch.client, name, { universalResolverAddress: ch.universal, policyHashOf });
  assert.equal(p.checks.policyMatches, false);

  // a manifest published on the wrong name is refused
  await setTextRecord(owner, resolver, name, TEXT_KEYS.manifest, JSON.stringify(manifestFor("other.eth", reporterAddr)));
  await assert.rejects(loadManifest(ch.client, name, { universalResolverAddress: ch.universal }), /published on/);
});
