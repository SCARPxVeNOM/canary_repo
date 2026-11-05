// The real extension (dist-local, 3 own gateways): startup, Uniswap, latency, failover.
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os"; import { join } from "node:path";
const { chromium } = await import(new URL("../../extension/node_modules/playwright/index.mjs", import.meta.url).href);
const CHROME = process.env.CHROME_BIN;
const DIR = new URL("../../extension/dist-local", import.meta.url).pathname;
const DOCKER = "/Applications/Docker.app/Contents/Resources/bin/docker";
const GWS = ["canary-gateway", "canary-gateway-12299", "canary-gateway-12300"];
const out = {};
const say = (k, v) => { out[k] = v; console.log(k, JSON.stringify(v)); };

// A page that reads like a dapp: fetch() to a public RPC, which Canary intercepts.
const PAGE = `<!doctype html><script>
const RPC = "https://eth.drpc.org";
window.read = async (method = "eth_getBalance", params = ["0x00000000219ab540356cBB839Cbe05303d7705Fa", "latest"]) => {
  const t0 = performance.now();
  try { const j = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json());
    return { ms: Math.round(performance.now() - t0), ok: j.result !== undefined && j.result !== null, err: j.error?.message };
  } catch (e) { return { ms: Math.round(performance.now() - t0), ok: false, err: String(e) }; }
};</script>`;
const http = createServer((q, s) => s.writeHead(200, { "content-type": "text/html" }).end(PAGE)).listen(0, "127.0.0.1");
await new Promise((r) => http.once("listening", r));
const PAGE_URL = `http://127.0.0.1:${http.address().port}/`;
const stat = (a) => { const s = [...a].sort((x, y) => x - y); return { n: s.length, p50: s[Math.floor(s.length / 2)], p90: s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)], mean: Math.round(s.reduce((x, y) => x + y, 0) / s.length) }; };

// 1. Startup: browser launch → Tor ready, with no page open.
const t0 = Date.now();
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "final-")), { headless: true, executablePath: CHROME, args: [`--disable-extensions-except=${DIR}`, `--load-extension=${DIR}`] });
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
let w;
for (;;) { w = (await sw.evaluate(() => chrome.storage.session.get("worker"))).worker; if (w?.state === "ready" || w?.state === "failed" || Date.now() - t0 > 120000) break; await new Promise((r) => setTimeout(r, 100)); }
say("startup: browser launch → Tor ready (no tab opened)", { ms: Date.now() - t0, worker: w });
await new Promise((r) => setTimeout(r, 2000));

// 2. Average latency through the extension.
const page = await ctx.newPage(); await page.goto(PAGE_URL);
const first = await page.evaluate(() => window.read());
say("first dapp read after startup", first);
const singles = [];
for (let i = 0; i < 30; i++) { const r = await page.evaluate(() => window.read()); if (r.ok) singles.push(r.ms); await new Promise((r) => setTimeout(r, 300)); }
say("single read, warm (30 samples)", stat(singles));
const cached = [];
for (let i = 0; i < 10; i++) cached.push((await page.evaluate(() => window.read("eth_chainId", []))).ms);
say("eth_chainId (answered by Canary)", stat(cached));
const dash = [];
for (let i = 0; i < 5; i++) {
  dash.push(await page.evaluate(async () => { const t = performance.now(); const rs = await Promise.all(Array.from({ length: 20 }, (_, k) => window.read("eth_getBalance", ["0x" + String(k % 10).repeat(40), "latest"]))); return { ms: Math.round(performance.now() - t), ok: rs.filter((r) => r.ok).length }; }));
  await new Promise((r) => setTimeout(r, 1500));
}
say("20 parallel reads (5 runs)", { ...stat(dash.map((d) => d.ms)), ok: dash.map((d) => d.ok) });

// 3. Uniswap with the chain-from-URL fix.
{
  const p = await ctx.newPage(); await p.goto("https://app.uniswap.org/explore/tokens", { waitUntil: "domcontentloaded" }).catch(() => {}); await p.waitForTimeout(25000);
  const all = await sw.evaluate(() => chrome.storage.session.get(null));
  const t = Object.entries(all).find(([k, v]) => k.startsWith("tab:") && v.origin.includes("uniswap"))?.[1];
  say("app.uniswap.org", { counts: t?.counts, notes: t?.notes, rpcCalls: t?.rpcCalls });
  await p.close();
}

// 4. Failover through the extension: steady reads, kill the busiest gateway twice.
const netBytes = () => Object.fromEntries(execSync(`${DOCKER} stats --no-stream --format '{{.Name}} {{.NetIO}}' ${GWS.join(" ")}`).toString().trim().split("\n").map((l) => {
  const [n, rx] = l.split(" "); return [n, parseFloat(rx) * ({ kB: 1e3, MB: 1e6, GB: 1e9, B: 1 }[rx.replace(/[\d.]/g, "")] ?? 1)];
}));
const log = []; const tl = Date.now(); let stop = false;
const loop = (async () => { while (!stop) { const at = Date.now() - tl; const r = await page.evaluate(() => window.read()); log.push({ at, ...r }); await new Promise((r) => setTimeout(r, 500)); } })();
const killed = [];
for (const round of [0, 1]) {
  const a = netBytes(); await new Promise((r) => setTimeout(r, 8000)); const b = netBytes();
  const busiest = GWS.filter((g) => !killed.includes(g)).sort((x, y) => (b[y] - a[y]) - (b[x] - a[x]))[0];
  const at = Date.now() - tl; execSync(`${DOCKER} kill ${busiest}`); killed.push(busiest);
  await new Promise((r) => setTimeout(r, 40000));
  const after = log.filter((l) => l.at >= at - 1000);
  const before = log.filter((l) => l.ok && l.at < at).slice(-1)[0];
  const lastFail = [...after].reverse().find((l) => !l.ok);
  const rec = lastFail ? after.find((l) => l.ok && l.at > lastFail.at) : after.find((l) => l.ok);
  say(`failover round ${round} (killed ${busiest})`, { failedReads: after.filter((l) => !l.ok).length, gapMs: rec && before ? rec.at + rec.ms - (before.at + before.ms) : null, readsAfter: after.slice(0, 12).map((l) => (l.ok ? l.ms : "✗" + l.ms)).join(" "), errors: [...new Set(after.filter((l) => !l.ok).map((l) => l.err))].slice(0, 2) });
}
stop = true; await loop;
for (const k of killed) execSync(`${DOCKER} start ${k}`);
writeFileSync(new URL("res-ext-final.json", import.meta.url), JSON.stringify({ out, log }, null, 1));
await ctx.close(); http.close(); process.exit(0);
