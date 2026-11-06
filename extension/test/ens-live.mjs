// The extension's ENS reader (src/ens.ts) against live ENSv2 on Sepolia: the
// site ↔ name binding, the manifest, and the verifier's signed verdict.
// Needs LeakyDash running with LEAKYDASH_ENS=leakydash.eth (leakydash/README.md).
//   node test/ens-live.mjs [origin] [rpc]
import { build } from "esbuild";
import { sharedPackages } from "../build.mjs";

const [origin = "http://leakydash.localhost:3000", rpc = "https://ethereum-sepolia-rpc.publicnode.com"] = process.argv.slice(2);
const out = new URL("out/ens-live-bundle.mjs", import.meta.url).pathname;
await build({ entryPoints: [new URL("../src/ens.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning", plugins: [sharedPackages] });
const { readDeclared, UNIVERSAL_RESOLVER } = await import(out);

let id = 0;
const call = async (to, data, from) => {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "eth_call", params: [{ to, data, ...(from ? { from } : {}) }, "latest"] }) });
  return r.json();
};
const d = await readDeclared(origin, call, { chainId: 11155111, universalResolver: UNIVERSAL_RESOLVER, verifier: "canary" });
console.log(JSON.stringify(d, null, 2));
const v = d.verdict;
const pass = d.state === "ok" && v?.state === "read" && v.signed && v.signerIsVerifier && v.delegated === true && v.matchesSite && !v.expired;
console.log(pass ? "live check: ok" : "live check: FAILED");
process.exit(pass ? 0 : 1);
