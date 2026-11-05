// Offline e2e for the Canary spike. Everything is local:
//   ORIGIN   127.0.0.1:A  stub chain (§4 specifier read) + passthrough bundle + the dapp page
//   PROVIDER 127.0.0.1:B  "the dapp's keyed RPC provider": logs every request + its Origin
//   READ     127.0.0.1:C  "Canary's read endpoint": logs every request + its Origin
// Run 1: no extension (baseline). Run 2: with Canary. Pass = with Canary the
// provider sees no read methods, and nothing it does see carries the page's Origin.

import { build } from "esbuild";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3";
import { buildCanary } from "../build.mjs";

const HERE = import.meta.dirname;
const CHROME = process.env.CHROME_BIN;
const SPECIFIER = "0x4fd77be300f31c5fe6ab266d35d27750a3478d27";
const bundle = await readFile(resolve(HERE, "../../passthrough-worker/dist/passthrough-worker.js"));
const workerHash = Buffer.from(keccak_256(bundle)).toString("hex");
const hex = (b) => Buffer.from(b).toString("hex");
const sel = (s) => "0x" + hex(keccak_256(Buffer.from(s))).slice(0, 8);
const word = (n) => n.toString(16).padStart(64, "0");
const strArr = (ss) => { let h = word(32) + word(ss.length), off = "", body = "", cur = ss.length * 32; for (const s of ss) { const b = Buffer.from(s); const p = Math.ceil(b.length / 32) * 32; off += word(cur); body += word(b.length) + hex(b).padEnd(p * 2, "0"); cur += 32 + p; } return "0x" + h + off + body; };

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, GET, OPTIONS" };
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b)); });

function rpcServer(name, answers, log) {
  return createServer(async (req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    const body = JSON.parse((await readBody(req)) || "{}");
    const one = (m) => { log.push({ method: m.method, origin: req.headers.origin ?? "(none)" }); const r = answers[m.method]; return r === undefined ? { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `${name}: no ${m.method}` } } : { jsonrpc: "2.0", id: m.id, result: r }; };
    res.writeHead(200, { ...CORS, "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
  });
}

const providerLog = [], readLog = [];
const PROVIDER = await listen(rpcServer("provider", { eth_chainId: "0xaa36a7", eth_blockNumber: "0x111", eth_getBalance: "0x1", alchemy_getTokenBalances: { from: "provider" } }, providerLog));
const READ = await listen(rpcServer("read", { eth_chainId: "0xaa36a7", eth_blockNumber: "0x222", eth_getBalance: "0x2" }, readLog));

const dappJs = (await build({ entryPoints: [resolve(HERE, "dapp.ts")], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022", define: { __PROVIDER__: JSON.stringify(PROVIDER) }, nodePaths: [resolve(HERE, "../node_modules")] })).outputFiles[0].text;

let ORIGIN;
const origin = createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  if (req.url === "/worker.js") { res.writeHead(200, { ...CORS, "content-type": "text/javascript" }); return res.end(bundle); }
  if (req.url === "/dapp.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<!doctype html><title>LeakyDash (offline)</title><script src="/dapp.js"></script>`); }
  if (req.url === "/dapp.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(dappJs); }
  const m = JSON.parse((await readBody(req)) || "{}");
  const send = (result) => { res.writeHead(200, { ...CORS, "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })); };
  if (m.method === "eth_chainId") return send("0x1");
  if (m.method === "eth_call" && m.params[0].data === sel("workerHash()")) return send("0x" + workerHash);
  if (m.method === "eth_call" && m.params[0].data === sel("workerResolvers()")) return send(strArr([`${ORIGIN}/worker.js`]));
  res.writeHead(404, CORS); res.end();
});
ORIGIN = await listen(origin);

async function run(withCanary) {
  providerLog.length = 0; readLog.length = 0;
  const profile = await mkdtemp(resolve(tmpdir(), "canary-prof-"));
  let ext;
  const args = ["--no-sandbox"];
  if (withCanary) {
    ext = await mkdtemp(resolve(tmpdir(), "canary-ext-"));
    await buildCanary({ specifier: SPECIFIER, bootstrapRpc: `${ORIGIN}/rpc`, readEndpoints: { "11155111": READ }, matches: ["http://127.0.0.1/*"], hostPermissions: ["http://127.0.0.1/*"] }, ext);
    args.push(`--disable-extensions-except=${ext}`, `--load-extension=${ext}`);
  }
  const ctx = await chromium.launchPersistentContext(profile, { headless: true, executablePath: CHROME, args });
  let sw;
  if (withCanary) {
    sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 30000 }));
  }
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && console.log("   [page error]", m.text()));
  await page.goto(`${ORIGIN}/dapp.html`);
  const result = await page.evaluate(() => window.runDapp());
  const stats = withCanary ? await sw.evaluate(() => new Promise((r) => chrome.storage.session.get("stats").then((x) => r(x.stats)))) : null;
  await ctx.close();
  await rm(profile, { recursive: true, force: true });
  if (ext) await rm(ext, { recursive: true, force: true });
  return { result, provider: [...providerLog], read: [...readLog], stats };
}

const summarize = (log) => log.map((l) => `${l.method}@${l.origin}`).join(", ") || "(nothing)";
const base = await run(false);
console.log("\n— Baseline (no extension) —");
console.log("  dapp saw:   ", JSON.stringify(base.result));
console.log("  provider got:", summarize(base.provider));
console.log("  read got:    ", summarize(base.read));

const can = await run(true);
console.log("\n— With Canary —");
console.log("  dapp saw:   ", JSON.stringify(can.result));
console.log("  provider got:", summarize(can.provider));
console.log("  read got:    ", summarize(can.read));
console.log("  stats:       ", JSON.stringify(can.stats));

const READS = new Set(["eth_blockNumber", "eth_getBalance"]);
const checks = [
  ["baseline: provider saw reads from the page origin", base.provider.some((l) => READS.has(l.method) && l.origin === ORIGIN)],
  ["canary: dapp still works (got values)", can.result.blockNumber !== undefined && can.result.balance !== undefined],
  ["canary: reads answered by READ endpoint (0x222 / 0x2)", can.result.blockNumber === String(0x222) && can.result.balance === "2" && can.result.batch[0] === String(0x222)],
  ["canary: provider saw NO read methods", !can.provider.some((l) => READS.has(l.method))],
  ["canary: nothing reached provider or read with the page's Origin", ![...can.provider, ...can.read].some((l) => l.origin === ORIGIN)],
  ["canary: every request left from the worker's null origin", [...can.provider, ...can.read].every((l) => l.origin === "null")],
  ["canary: non-substitutable method forwarded to provider (IP-only)", JSON.stringify(can.result.custom) === JSON.stringify({ from: "provider" }) && can.provider.some((l) => l.method === "alchemy_getTokenBalances")],
  ["canary: batch request substituted as a batch", can.read.filter((l) => READS.has(l.method)).length >= 4],
];
console.log("");
let failed = 0;
for (const [name, ok] of checks) { console.log(`  ${ok ? "✓" : "✗"} ${name}`); if (!ok) failed++; }
origin.close();
process.exit(failed ? 1 : 0);
