import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDappManifest, compareDeclared, sameOrigin } from "../dist/index.js";

const M = parseDappManifest({
  name: "leakydash.eth",
  recipients: [
    { host: "rpc.provider.test", kind: "rpc", purpose: "reads balances" },
    { host: "*.cdn.test", kind: "backend" },
    { host: "never.test", kind: "analytics" },
  ],
});

test("parseDappManifest validates hosts and kinds", () => {
  assert.equal(M.recipients[1].host, "*.cdn.test");
  assert.throws(() => parseDappManifest({}), /recipients/);
  assert.throws(() => parseDappManifest({ recipients: [{ host: "a b" }] }), /host/);
  assert.throws(() => parseDappManifest({ recipients: [{ host: "a.test", kind: "spy" }] }), /kind/);
});

test("compareDeclared: declared, undeclared, not seen; first party and silent hosts ignored", () => {
  const { rows, undeclared } = compareDeclared(M, [
    { host: "rpc.provider.test", firstParty: false, carriedAddress: false, methods: ["eth_call"] },
    { host: "img.cdn.test", firstParty: false, carriedAddress: true },
    { host: "tracker.test", firstParty: false, carriedAddress: true },
    { host: "leakydash.test", firstParty: true, carriedAddress: true },
    { host: "fonts.test", firstParty: false, carriedAddress: false, methods: [] },
  ]);
  assert.equal(undeclared, 1);
  assert.deepEqual(rows.map((r) => [r.host, r.status]), [
    ["tracker.test", "undeclared"],
    ["img.cdn.test", "declared"],
    ["rpc.provider.test", "declared"],
    ["never.test", "notSeen"],
  ]);
});

test("sameOrigin", () => {
  assert.ok(sameOrigin("https://leakydash.xyz/", "https://leakydash.xyz"));
  assert.ok(!sameOrigin("https://leakydash.xyz", "http://leakydash.xyz"));
  assert.ok(!sameOrigin("not a url", "https://x.test"));
});
