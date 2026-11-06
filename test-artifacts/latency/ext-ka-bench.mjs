// The whole extension, on-chain tor-js (dist-local) vs patched tor-js
// (dist-patched, config/local-patched.json), same 3 own gateways, interleaved
// rounds, fresh profile each. A dapp-style page reads a public RPC; Canary
// intercepts and answers each read over anon-rpc.
//   CHROME_BIN=… node ext-ka-bench.mjs [rounds]
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
const { chromium } = await import(new URL("../../extension/node_modules/playwright/index.mjs", import.meta.url).href);
const EXT = new URL("../../extension/", import.meta.url).pathname;
const BUILDS = { stock: EXT + "dist-local", patched: EXT + "dist-patched" };
const ROUNDS = Number(process.argv[2] ?? 3);

// The patched build's resolver URL (config/local-patched.json).
const worker = readFileSync(new URL("../../tor-js-patches/dist/anon-rpc-worker.js", import.meta.url));
createServer((q, s) => s.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" }).end(worker)).listen(8547, "127.0.0.1");

const PAGE = `<!doctype html><script>
window.read = async (method = "eth_getBalance", params = ["0x00000000219ab540356cBB839Cbe05303d7705Fa", "latest"]) => {
  const t0 = performance.now();
  try { const j = await fetch("https://eth.drpc.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
    return { ms: Math.round(performance.now() - t0), ok: j.result !== undefined && j.result !== null, err: j.error?.message };
  } catch (e) { return { ms: Math.round(performance.now() - t0), ok: false, err: String(e) }; }
};</script>`;
const http = createServer((q, s) => s.writeHead(200, { "content-type": "text/html" }).end(PAGE)).listen(0, "127.0.0.1");
await new Promise((r) => http.once("listening", r));
const PAGE_URL = `http://127.0.0.1:${http.address().port}/`;

const stat = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? { n: s.length, p50: s[Math.floor(s.length / 2)], p90: s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)], mean: Math.round(s.reduce((x, y) => x + y, 0) / s.length) } : { n: 0 }; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const all = Object.fromEntries(Object.keys(BUILDS).map((k) => [k, { ready: [], first: [], warm: [], parallel20: [], afterIdle: [], fails: [], network: undefined }]));

async function session(name) {
  const r = all[name]; const t0 = Date.now();
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "extka-")), { headless: true, executablePath: process.env.CHROME_BIN, args: [`--disable-extensions-except=${BUILDS[name]}`, `--load-extension=${BUILDS[name]}`] });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  let w;
  for (;;) { w = (await sw.evaluate(() => chrome.storage.session.get("worker"))).worker; if (w?.state === "ready" || w?.state === "failed" || Date.now() - t0 > 120000) break; await pause(100); }
  if (w?.state !== "ready") { r.fails.push("boot " + JSON.stringify(w)); await ctx.close(); return; }
  r.ready.push(Date.now() - t0); r.network = w.network;
  await pause(2000);
  const page = await ctx.newPage(); await page.goto(PAGE_URL);
  const rec = (bucket, x) => (x.ok ? r[bucket].push(x.ms) : r.fails.push(`${bucket} ${x.ms}ms ${x.err}`));
  rec("first", await page.evaluate(() => window.read()));
  for (let i = 0; i < 30; i++) { rec("warm", await page.evaluate(() => window.read())); await pause(300); }
  for (let i = 0; i < 4; i++) {
    const d = await page.evaluate(async () => { const t = performance.now(); const rs = await Promise.all(Array.from({ length: 20 }, (_, k) => window.read("eth_getBalance", ["0x" + String(k % 10).repeat(40), "latest"]))); return { ms: Math.round(performance.now() - t), ok: rs.filter((x) => x.ok).length }; });
    d.ok === 20 ? r.parallel20.push(d.ms) : r.fails.push(`parallel20 ${d.ok}/20`);
    await pause(1500);
  }
  await pause(40000);
  rec("afterIdle", await page.evaluate(() => window.read()));
  console.log(name, "ready", r.ready.at(-1), "warm", JSON.stringify(stat(r.warm.slice(-30))));
  await ctx.close();
}

for (let i = 0; i < ROUNDS; i++) for (const n of i % 2 ? ["patched", "stock"] : ["stock", "patched"]) await session(n);
const summary = Object.fromEntries(Object.entries(all).map(([k, r]) => [k, { network: r.network, browserToReady: stat(r.ready), firstRead: stat(r.first), warmRead: stat(r.warm), parallel20: stat(r.parallel20), afterIdle: stat(r.afterIdle), failed: r.fails.length, fails: r.fails.slice(0, 5) }]));
console.log(JSON.stringify(summary, null, 1));
writeFileSync(new URL("res-ext-keepalive.json", import.meta.url), JSON.stringify({ summary, raw: all }, null, 1));
process.exit(0);
