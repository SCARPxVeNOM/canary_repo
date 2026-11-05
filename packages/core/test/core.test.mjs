import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonRpc, isBatchBody, needlesFor, findAddress, findAddresses, isolationKeyFor,
  parseManifest, ruleFor, canonicalJson, knownChain, registrableDomain,
} from "../dist/index.js";

const A = "0x5Ca1aB1E00000000000000000000000000C0ffeE";
const B = "0xb0b0000000000000000000000000000000000b0b";

test("parseJsonRpc: single, batch, junk", () => {
  assert.equal(parseJsonRpc('{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}').length, 1);
  assert.equal(parseJsonRpc('[{"jsonrpc":"2.0","id":1,"method":"a"},{"jsonrpc":"2.0","id":2,"method":"b"}]').length, 2);
  assert.equal(parseJsonRpc("[]"), null);
  assert.equal(parseJsonRpc('{"hello":1}'), null);
  assert.equal(parseJsonRpc("not json"), null);
  assert.equal(isBatchBody(' [{"a":1}]'), true);
});

test("address matching: checksummed, padded, base64, several", () => {
  const n = [needlesFor(A), needlesFor(B)];
  assert.equal(findAddress(`to=${A}`, n).address, A.toLowerCase());
  assert.equal(findAddress("0x" + "0".repeat(24) + A.slice(2).toLowerCase(), n).encoding, "hex");
  const raw = Buffer.from(A.slice(2), "hex").toString("base64").replace(/=+$/, "");
  assert.equal(findAddress(`{"u":"${raw}"}`, n).encoding, "base64");
  assert.deepEqual(findAddresses(`${B} and ${A}`, n), [A.toLowerCase(), B]);
  assert.equal(findAddress("nothing here", n), null);
  assert.equal(isolationKeyFor(A), `addr:${A.toLowerCase()}`);
});

test("manifest: defaults, validation, host rules", () => {
  const m = parseManifest({ v: 1, hosts: { "api.openai.com": "direct", "*.coingecko.com": "anon", "*.api.coingecko.com": "block" } });
  assert.equal(m.undeclared, "block");
  assert.equal(m.rpc.write, "anon");
  assert.equal(ruleFor(m, "api.openai.com"), "direct");
  assert.equal(ruleFor(m, "API.OpenAI.com:443"), "direct");
  assert.equal(ruleFor(m, "pro.coingecko.com"), "anon");
  assert.equal(ruleFor(m, "x.api.coingecko.com"), "block", "longest suffix wins");
  assert.equal(ruleFor(m, "coingecko.com"), undefined, "*.x does not match the apex");
  assert.equal(ruleFor(m, "evil.com"), undefined);
  assert.throws(() => parseManifest({ v: 2, hosts: {} }), /manifest\.v/);
  assert.throws(() => parseManifest({ v: 1, hosts: { "a.com": "maybe" } }), /a\.com/);
  assert.throws(() => parseManifest({ v: 1, hosts: {}, llm: { allow: ["0x12"] } }), /llm\.allow/);
});

test("canonicalJson is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
});

test("domain helpers carried over from the extension", () => {
  assert.equal(knownChain("https://ethereum-sepolia-rpc.publicnode.com"), 11155111);
  assert.equal(registrableDomain("app.ens.domains"), "ens.domains");
});
