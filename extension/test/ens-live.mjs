// The extension's ENS reader (src/ens.ts) against live ENSv2 on Sepolia: the
// site ↔ name binding, the manifest, and the verifier's signed verdict; or,
// for a site with no name of its own, Canary's label for it.
// Default: the deployed LeakyDash (leakydash.eth's url record points at it).
//   node test/ens-live.mjs [origin] [rpc]
import { build } from "esbuild";
import { sharedPackages } from "../build.mjs";

const [origin = "https://canary-leakydash.vercel.app", rpc = "https://ethereum-sepolia-rpc.publicnode.com"] = process.argv.slice(2);
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
// A site with its own name (LeakyDash), or one with Canary's label (e.g. https://app.uniswap.org)
const v = d.state === "ok" ? d.verdict : d.label?.verdict;
const pass = (d.state === "ok" || d.label) && v?.state === "read" && v.signed && v.signerIsVerifier && v.delegated === true && v.matchesSite && !v.expired;
console.log(pass ? "live check: ok" : "live check: FAILED");
process.exit(pass ? 0 : 1);
