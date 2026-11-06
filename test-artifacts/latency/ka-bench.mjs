// tor-js with and without HTTP keep-alive, same gateways, interleaved rounds,
// fresh browser profile per session.
//   STOCK=<stock dist/anon-rpc-worker.js> KEEPALIVE=<patched dist/anon-rpc-worker.js> node ka-bench.mjs [rounds]
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os"; import { join } from "node:path";

const IMPL = process.env.ANON_RPC_IMPL ?? new URL("../../../anon-rpc/impl/", import.meta.url).pathname;
const require = createRequire(IMPL + "package.json");
const esbuild = require("esbuild");
const { chromium } = await import(IMPL + "node_modules/playwright/index.mjs");
const HERE = new URL(".", import.meta.url).pathname;
const ROUNDS = Number(process.argv[2] ?? 3);
const RPC = "https://ethereum-rpc.publicnode.com";
const GATEWAYS = JSON.parse(readFileSync(HERE + "../../extension/config/local-gateway.json", "utf8")).network.workerConfig.gateways;
const BUNDLES = { stock: process.env.STOCK, keepalive: process.env.KEEPALIVE };
const ADDRS = ["0x00000000219ab540356cBB839Cbe05303d7705Fa", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "0xdAC17F958D2ee523a2206206994597C13D831ec7", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0x6B175474E89094C44Da98b954EedeAC495271d0F", "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", "0xE592427A0AEce92De3Edee1F18E0157C05861564", "0x514910771AF9Ca656af840dff83E8264EcF986CA", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"];

await esbuild.build({ entryPoints: [HERE + "ka-page.ts"], bundle: true, format: "esm", outfile: HERE + "out/ka-page.js", nodePaths: [IMPL + "node_modules"], logLevel: "error", platform: "browser" });
const http = createServer((req, res) => {
  const name = req.url.slice(1).split("?")[0];
  if (name === "ka-page.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(HERE + "out/ka-page.js"));
  if (name.endsWith(".js") && BUNDLES[name.slice(0, -3)]) return res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" }).end(readFileSync(BUNDLES[name.slice(0, -3)]));
  res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><script type="module" src="/ka-page.js"></script>');
}).listen(0, "127.0.0.1");
await new Promise((r) => http.once("listening", r));
const base = `http://127.0.0.1:${http.address().port}/`;

const stat = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? { n: s.length, p50: s[Math.floor(s.length / 2)], p90: s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)], mean: Math.round(s.reduce((x, y) => x + y, 0) / s.length) } : { n: 0 }; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const all = { stock: { unkeyed: [], keyed: [], parallel: [], afterIdle: [], boot: [], fails: [] }, keepalive: { unkeyed: [], keyed: [], parallel: [], afterIdle: [], boot: [], fails: [] } };

async function session(variant) {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ka-")), { headless: true, executablePath: process.env.CHROME_BIN });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (process.env.VERBOSE) page.on("console", (m) => console.log(variant, m.text().slice(0, 240)));
  await page.goto(base); await page.waitForFunction(() => window.probe);
  const r = all[variant];
  const boot = await page.evaluate(([g, u]) => window.probe.boot({ gateways: g }, u), [GATEWAYS, `${base}${variant}.js`]);
  r.boot.push(boot.bootMs);
  const rec = (bucket, x) => (x.ok ? r[bucket].push(x.ms) : r.fails.push(`${bucket} ${x.ms}ms ${x.error ?? ""}`));
  for (let i = 0; i < 2; i++) await page.evaluate(([u, a]) => window.probe.read(u, a), [RPC, ADDRS[i]]); // warm up the circuit
  for (let i = 0; i < 25; i++) { rec("unkeyed", await page.evaluate(([u, a]) => window.probe.read(u, a), [RPC, ADDRS[i % 10]])); await pause(300); }
  await page.evaluate(([u, a]) => window.probe.read(u, a, "addr:bench"), [RPC, ADDRS[0]]);
  for (let i = 0; i < 15; i++) { rec("keyed", await page.evaluate(([u, a]) => window.probe.read(u, a, "addr:bench"), [RPC, ADDRS[i % 10]])); await pause(300); }
  for (let i = 0; i < 2; i++) { r.parallel.push((await page.evaluate(([u, a]) => window.probe.parallel(u, a), [RPC, [...ADDRS, ...ADDRS]])).totalMs); await pause(1000); }
  await pause(40000); // longer than the pool's idle limit: the next read must open a new connection
  rec("afterIdle", await page.evaluate(([u, a]) => window.probe.read(u, a), [RPC, ADDRS[3]]));
  console.log(variant, "boot", boot.bootMs, "hash", boot.hash?.slice(0, 12), "unkeyed", JSON.stringify(stat(r.unkeyed.slice(-25))));
  await ctx.close();
}

for (let i = 0; i < ROUNDS; i++) for (const v of i % 2 ? ["keepalive", "stock"] : ["stock", "keepalive"]) await session(v);
const summary = Object.fromEntries(Object.entries(all).map(([v, r]) => [v, { boot: stat(r.boot), unkeyed: stat(r.unkeyed), keyed: stat(r.keyed), parallel20: stat(r.parallel), afterIdle: stat(r.afterIdle), failed: r.fails.length, fails: r.fails.slice(0, 5) }]));
console.log(JSON.stringify(summary, null, 1));
writeFileSync(HERE + "res-keepalive.json", JSON.stringify({ summary, raw: all }, null, 1));
http.close(); process.exit(0);
