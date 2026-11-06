// A verifier's signed verdict on a dapp's ENSv2 name (idea.md §3.3), against
// the mock ENSv2 contracts, for both delegation APIs.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  readText, canWriteText, setTextRecord, grantTextKey, revokeTextKey,
  verdictKey, verdictFromScan, signVerdict, verifyVerdictRecord, parseVerdictRecord,
} from "../dist/index.js";
import { startChain, KEYS } from "./chain.mjs";

let ch;
before(async () => (ch = await startChain()));
after(async () => ch?.close());

/** The shape scanner/scan.mjs writes for a baseline run. */
const scan = (o = {}) => ({
  url: "http://leakydash.localhost:3000/",
  scannedAt: "2026-11-05T17:34:46.891Z",
  scanner: { version: "0.1.0", hash: "296015c80bdd" },
  build: { fingerprint: "e36522b683b8", documents: 3 },
  withCanary: false,
  flows: ["load http://leakydash.localhost:3000/", "connect: clicked", "scroll"],
  recipients: [
    { host: "tracker.localhost", party: "third", carriedAddress: 3, declared: false },
    { host: "rpc.provider.localhost", party: "third", carriedAddress: 1, declared: true },
  ],
  undeclared: ["tracker.localhost"],
  notInspected: ["WebRTC"],
  ...o,
});
const opts = { name: "leakydash.eth", verifier: "verifier.canary.eth" };

test("verdictFromScan: result from the scan, baseline only", () => {
  const v = verdictFromScan(scan(), opts);
  assert.equal(v.origin, "http://leakydash.localhost:3000");
  assert.equal(v.result, "undeclared");
  assert.deepEqual(v.undeclaredHosts, ["tracker.localhost"]);
  assert.equal(v.issuedAt, Math.floor(Date.parse("2026-11-05T17:34:46.891Z") / 1000));
  assert.equal(v.expiresAt - v.issuedAt, 30 * 86400);
  assert.equal(verdictFromScan(scan({ undeclared: [], recipients: [] }), opts).result, "matches");
  const noManifest = scan({ undeclared: [], recipients: [{ host: "tracker.localhost", party: "third", carriedAddress: 3, declared: null }] });
  assert.equal(verdictFromScan(noManifest, opts).result, "incomplete");
  assert.throws(() => verdictFromScan(scan({ withCanary: true }), opts), /baseline/);
});

test("signed verdicts verify; any change breaks the signature", async () => {
  const r = await signVerdict(verdictFromScan(scan(), opts), KEYS.reporter);
  assert.equal((await verifyVerdictRecord(r)).toLowerCase(), ch.address(KEYS.reporter).toLowerCase());
  await assert.rejects(verifyVerdictRecord({ ...r, result: "matches" }), /signed by/);
  await assert.rejects(verifyVerdictRecord({ ...r, undeclaredHosts: [] }), /signed by/, "fields outside the typed struct are covered by verdictHash");
  assert.deepEqual(parseVerdictRecord(JSON.stringify(r)), r);
  assert.throws(() => parseVerdictRecord(JSON.stringify({ ...r, result: "fine" })), /result/);
});

for (const setterApi of [false, true]) {
  test(`the dapp delegates one key to its verifier, then silences it (${setterApi ? "grantSetterRoles" : "authorizeTextRoles"})`, async () => {
    const name = setterApi ? "leakydash-b.eth" : "leakydash.eth";
    const key = verdictKey("canary");
    const resolver = await ch.nameWithResolver(name, { setterApi });
    const o = { universalResolverAddress: ch.universal };
    const dapp = { wallet: ch.owner, client: ch.client };
    const verifierAddr = ch.address(KEYS.reporter);
    const verifier = { wallet: ch.wallet(KEYS.reporter), client: ch.client };

    await grantTextKey(dapp, resolver, name, key, verifierAddr);
    assert.equal((await canWriteText(ch.client, resolver, name, key, verifierAddr)).ok, true);
    assert.equal((await canWriteText(ch.client, resolver, name, "privacy.manifest", verifierAddr)).ok, false, "the verifier can't touch the manifest");

    // the verifier publishes bad news without the dapp's help
    const record = await signVerdict(verdictFromScan(scan(), { ...opts, name }), KEYS.reporter);
    await setTextRecord(verifier, resolver, name, key, JSON.stringify(record));
    const read = parseVerdictRecord(await readText(ch.client, name, key, o));
    assert.equal(read.result, "undeclared");
    assert.equal((await verifyVerdictRecord(read)).toLowerCase(), verifierAddr.toLowerCase());

    // the only way to silence it is to revoke the role, which readers can see
    await revokeTextKey(dapp, resolver, name, key, verifierAddr);
    assert.equal((await canWriteText(ch.client, resolver, name, key, verifierAddr)).ok, false);
    assert.ok(await readText(ch.client, name, key, o), "the old verdict is still there to read");
  });
}
