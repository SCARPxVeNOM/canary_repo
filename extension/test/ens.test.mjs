// Unit tests for src/ens.ts: calldata, decoding, and the site ↔ name binding.
//   node --test test/ens.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, namehash, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { packetToBytes } from "viem/ens";
import { build } from "esbuild";
import { sharedPackages } from "../build.mjs";

// ens.ts imports the core source with .js specifiers, so bundle it first.
const out = new URL("out/ens.test-bundle.mjs", import.meta.url).pathname;
await build({ entryPoints: [new URL("../src/ens.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning", plugins: [sharedPackages] });
const { checkName, decodeTextResult, dnsEncode, readDeclared, textCallData, UNIVERSAL_RESOLVER } = await import(out);
const { signVerdict } = await import("./shared-src.mjs");

const ok = (s) => encodeAbiParameters([{ type: "bytes" }, { type: "address" }], [encodeAbiParameters([{ type: "string" }], [s]), "0x" + "11".repeat(20)]);

test("names are DNS-encoded and hashed the way viem does", () => {
  assert.equal(dnsEncode("leakydash.eth"), toHex(packetToBytes("leakydash.eth")));
  const data = textCallData("leakydash.eth", "privacy.manifest");
  const inner = encodeFunctionData({ abi: [{ type: "function", name: "text", inputs: [{ type: "bytes32" }, { type: "string" }], outputs: [{ type: "string" }] }], functionName: "text", args: [namehash("leakydash.eth"), "privacy.manifest"] });
  assert.ok(data.startsWith("0x9061b923"), "resolve(bytes,bytes)");
  assert.ok(data.includes(inner.slice(2)));
});

test("records decode, empty ones read as null", () => {
  assert.equal(decodeTextResult(ok("https://leakydash.xyz")), "https://leakydash.xyz");
  assert.equal(decodeTextResult(ok("")), null);
});

test("only plain lowercase ASCII names are accepted", () => {
  assert.equal(checkName("leakydash.eth"), "leakydash.eth");
  for (const bad of ["LeakyDash.eth", "eth", "lеakydash.eth", "a..eth", 42]) assert.throws(() => checkName(bad));
});

/** A site serving /.well-known/canary.json, and an eth_call answering text records from `records`. */
async function site(wellKnown, records) {
  const srv = createServer((q, s) => (wellKnown === undefined ? s.writeHead(404).end() : s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(wellKnown))));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const call = async (to, data) => {
    assert.equal(to, UNIVERSAL_RESOLVER);
    for (const [k, v] of Object.entries(records(origin))) if (data === textCallData("leakydash.eth", k)) return { result: ok(v) };
    return { error: { message: "execution reverted" } };
  };
  return { origin, call, close: () => srv.close() };
}
const ENS = { chainId: 11155111, universalResolver: UNIVERSAL_RESOLVER };
const MANIFEST = JSON.stringify({ name: "leakydash.eth", recipients: [{ host: "rpc.provider.test", kind: "rpc", purpose: "reads" }] });

test("a bound manifest is read", async () => {
  const s = await site({ ens: "leakydash.eth" }, (o) => ({ url: o, "privacy.manifest": MANIFEST }));
  const d = await readDeclared(s.origin, s.call, ENS);
  s.close();
  assert.equal(d.state, "ok");
  assert.deepEqual(d.manifest.recipients, [{ host: "rpc.provider.test", kind: "rpc", purpose: "reads" }]);
});

test("a name that doesn't point back at the site is not used", async () => {
  const s = await site({ ens: "leakydash.eth" }, () => ({ url: "https://elsewhere.example", "privacy.manifest": MANIFEST }));
  const d = await readDeclared(s.origin, s.call, ENS);
  s.close();
  assert.equal(d.state, "unbound");
});

test("no well-known file, no record, a bad manifest", async () => {
  let s = await site(undefined, () => ({}));
  assert.equal((await readDeclared(s.origin, s.call, ENS)).state, "none");
  s.close();
  s = await site({ ens: "leakydash.eth" }, (o) => ({ url: o }));
  assert.equal((await readDeclared(s.origin, s.call, ENS)).state, "notFound");
  s.close();
  s = await site({ ens: "leakydash.eth" }, (o) => ({ url: o, "privacy.manifest": '{"recipients":"all"}' }));
  assert.equal((await readDeclared(s.origin, s.call, ENS)).state, "invalid");
  s.close();
});

/* --- verdicts ------------------------------------------------------------ */

const VERIFIER_KEY = "0x6cbed15c793ce57650b9877cf6fa156fbef513c4e6134f022a85b1ffdd59b2a1";
const VERIFIER = privateKeyToAccount(VERIFIER_KEY).address;
const RESOLVER = "0x" + "22".repeat(20);
const abi = [
  { type: "function", name: "resolve", inputs: [{ type: "bytes" }, { type: "bytes" }], outputs: [{ type: "bytes" }, { type: "address" }] },
  { type: "function", name: "findResolver", inputs: [{ type: "bytes" }], outputs: [{ type: "address" }, { type: "bytes32" }, { type: "uint256" }] },
  { type: "function", name: "text", inputs: [{ type: "bytes32" }, { type: "string" }], outputs: [{ type: "string" }] },
  { type: "function", name: "addr", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "setText", inputs: [{ type: "bytes" }, { type: "string" }, { type: "string" }], outputs: [] },
  { type: "function", name: "roles", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
];
const REVERT = { error: { message: "execution reverted" } };

/**
 * A fake chain: the Universal Resolver answers text/addr records from `records`
 * (per name), findResolver points at RESOLVER, which has EAC (unless `v1`) and
 * lets `writers` write privacy.verdict.canary.
 */
function chainCall({ records, writers = [VERIFIER], v1 = false }) {
  return async (to, data, from) => {
    const d = decodeFunctionData({ abi, data });
    if (to === UNIVERSAL_RESOLVER && d.functionName === "findResolver") return { result: encodeAbiParameters([{ type: "address" }, { type: "bytes32" }, { type: "uint256" }], [RESOLVER, "0x" + "00".repeat(32), 0n]) };
    if (to === UNIVERSAL_RESOLVER && d.functionName === "resolve") {
      const inner = decodeFunctionData({ abi, data: d.args[1] });
      const name = Object.keys(records).find((n) => namehash(n) === inner.args[0]);
      const v = name && records[name][inner.functionName === "addr" ? "addr" : inner.args[1]];
      if (!v) return REVERT;
      const enc = inner.functionName === "addr" ? encodeAbiParameters([{ type: "address" }], [v]) : encodeAbiParameters([{ type: "string" }], [v]);
      return { result: encodeAbiParameters([{ type: "bytes" }, { type: "address" }], [enc, RESOLVER]) };
    }
    if (to === RESOLVER && d.functionName === "roles") return v1 ? REVERT : { result: encodeAbiParameters([{ type: "uint256" }], [0n]) };
    if (to === RESOLVER && d.functionName === "setText") return d.args[1] === "privacy.verdict.canary" && writers.some((w) => w.toLowerCase() === from?.toLowerCase()) ? { result: "0x" } : REVERT;
    throw new Error(`unexpected call ${d.functionName} to ${to}`);
  };
}

async function verdictSite(verdictFor, chainOpts = {}) {
  const srv = createServer((q, s) => s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ens: "leakydash.eth" })));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const record = await verdictFor(origin);
  const records = {
    "leakydash.eth": { url: origin, "privacy.manifest": MANIFEST, ...(record ? { "privacy.verdict.canary": JSON.stringify(record) } : {}) },
    "verifier.canary.eth": { addr: VERIFIER },
  };
  const d = await readDeclared(origin, chainCall({ records, ...chainOpts }), ENS, Date.UTC(2026, 10, 6) );
  srv.close();
  return d.verdict;
}
const verdict = (origin, o = {}) => ({
  name: "leakydash.eth", origin, verifier: "verifier.canary.eth", buildHash: "e36522b683b8", scannerHash: "296015c80bdd",
  flows: ["load", "connect", "scroll"], result: "undeclared", undeclaredHosts: ["tracker.test"], notInspected: ["WebRTC"],
  issuedAt: Date.UTC(2026, 10, 5) / 1000, expiresAt: Date.UTC(2026, 11, 5) / 1000, ...o,
});
const sign = (o) => (origin) => signVerdict(verdict(origin, o), VERIFIER_KEY);

test("a verdict signed by the verifier's addr, still delegated, about this site", async () => {
  const v = await verdictSite(sign());
  assert.equal(v.state, "read");
  assert.deepEqual({ signed: v.signed, signerIsVerifier: v.signerIsVerifier, delegated: v.delegated, matchesSite: v.matchesSite, expired: v.expired },
    { signed: true, signerIsVerifier: true, delegated: true, matchesSite: true, expired: false });
  assert.equal(v.verdict.result, "undeclared");
  assert.equal(v.verdict.signature, undefined, "the popup doesn't need the signature");
});

test("a revoked verifier, an ENSv1 name, a forged or stale verdict", async () => {
  assert.equal((await verdictSite(sign(), { writers: [] })).delegated, false, "role revoked");
  assert.equal((await verdictSite(sign(), { v1: true })).delegated, null, "no EAC: can't tell, never 'revoked'");
  const tampered = await verdictSite(async (o) => ({ ...(await sign()(o)), result: "matches" }));
  assert.equal(tampered.signed, false);
  const otherKey = await verdictSite((o) => signVerdict(verdict(o), "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d"));
  assert.deepEqual([otherKey.signed, otherKey.signerIsVerifier], [true, false], "valid signature, but not the verifier's addr");
  assert.equal((await verdictSite(sign({ expiresAt: Date.UTC(2026, 10, 6) / 1000 - 1 }))).expired, true);
  assert.equal((await verdictSite(sign({ origin: "https://elsewhere.example" }))).matchesSite, false);
  assert.equal((await verdictSite(async () => ({ hello: 1 }))).state, "invalid");
  assert.equal(await verdictSite(async () => null), undefined, "no verdict record");
});

/* --- Canary's labels: a verdict for a site that names no ENS name ------------ */

const LABEL = "app-dapp-example.labels.canary.eth";
/** readDeclared for https://app.dapp.example, whose well-known file answers `status`. */
async function labelled(status, labelRecords, chainOpts = {}) {
  const origin = "https://app.dapp.example";
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status });
  try {
    const records = { "verifier.canary.eth": { addr: VERIFIER }, ...(labelRecords ? { [LABEL]: await labelRecords(origin) } : {}) };
    return await readDeclared(origin, chainCall({ records, ...chainOpts }), ENS, Date.UTC(2026, 10, 6));
  } finally {
    globalThis.fetch = real;
  }
}
const labelVerdict = (o = {}) => async (origin) => ({
  url: origin,
  "privacy.verdict.canary": JSON.stringify(await signVerdict(verdict(origin, { name: LABEL, result: "incomplete", undeclaredHosts: [], addressRecipients: [{ host: "tracker.test", kind: "analytics" }], ...o }), VERIFIER_KEY)),
});

test("no well-known file: Canary's label for the site, checked like any verdict", async () => {
  const d = await labelled(404, labelVerdict());
  assert.equal(d.state, "none");
  assert.equal(d.label.ens, LABEL);
  const v = d.label.verdict;
  assert.deepEqual([v.signed, v.signerIsVerifier, v.delegated, v.matchesSite, v.expired], [true, true, true, true, false]);
  assert.deepEqual(v.verdict.addressRecipients, [{ host: "tracker.test", kind: "analytics" }]);
  assert.equal((await labelled(503, labelVerdict())).label?.ens, LABEL, "a well-known file that errors still gets the label");
});

test("a label is used only when it points back at the site", async () => {
  assert.equal((await labelled(404, undefined)).label, undefined, "no label");
  assert.equal((await labelled(404, async (o) => ({ ...(await labelVerdict()(o)), url: "https://app.dapp-example.org" }))).label, undefined, "a label whose url names another site (a-b.com and a.b-com share one)");
  assert.equal((await labelled(404, async (o) => ({ url: o }))).label, undefined, "a label with no verdict yet");
  assert.equal((await labelled(404, labelVerdict({ origin: "https://elsewhere.example" }))).label.verdict.matchesSite, false, "a verdict about another site");
  assert.equal((await labelled(404, labelVerdict(), { writers: [] })).label.verdict.delegated, false, "the verifier's role revoked");
});

test("the transaction that wrote the verdict: found by its exact value, never a guess", async () => {
  const { recordTx, TEXT_CHANGED } = await import(out);
  const key = "privacy.verdict.canary";
  const log = (value, tx, k = key) => ({ data: encodeAbiParameters([{ type: "string" }, { type: "string" }], [k, value]), transactionHash: tx, topics: [TEXT_CHANGED] });
  const now = Date.UTC(2026, 10, 7);
  const asked = [];
  const rpc = (logs) => async (method, params) => {
    asked.push([method, params]);
    if (method === "eth_blockNumber") return { result: toHex(12_081_000) };
    return logs instanceof Error ? { error: { message: logs.message } } : { result: logs };
  };
  // a shared resolver: another name's verdict, an older one of ours, then ours
  const tx = await recordTx(rpc([log("ours, older", "0xa1"), log("theirs", "0xb2"), log("ours", "0xc3"), log("ours", "0xd4", "url")]), "0x1b46EB3b4Cf84F3f57EF21293eA46496f9593443", key, "ours", now / 1000 - 86_400, now);
  assert.equal(tx, "0xc3");
  const q = asked.find(([m]) => m === "eth_getLogs")[1][0];
  assert.equal(q.topics[0], TEXT_CHANGED);
  assert.equal(q.topics[1], null, "any name on the resolver; the value decides");
  assert.ok(parseInt(q.toBlock) - parseInt(q.fromBlock) < 10_000, "within public endpoints' 10,000-block limit");
  assert.ok(parseInt(q.fromBlock) <= 12_081_000 - 7_200, "starts before the record was signed (a day ago, ~7,200 blocks)");
  assert.equal(await recordTx(rpc([log("theirs", "0xb2")]), "0x1b46EB3b4Cf84F3f57EF21293eA46496f9593443", key, "ours", now / 1000, now), undefined, "no log with this value");
  assert.equal(await recordTx(rpc(new Error("pruned history unavailable")), "0x1b46EB3b4Cf84F3f57EF21293eA46496f9593443", key, "ours", now / 1000, now), undefined, "endpoint can't say");
});
