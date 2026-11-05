// How much of a real dapp's RPC traffic could be cached or deduped locally?
// Loads public pages with no wallet and records JSON-RPC POST bodies, read-only.
import { createRequire } from "node:module";
const IMPL = process.env.ANON_RPC_IMPL ?? "../../../anon-rpc/impl/";
const { chromium } = await import(IMPL + "node_modules/playwright/index.mjs");

const SITES = process.argv.slice(2);
const STATIC = new Set(["eth_chainId", "net_version", "eth_getCode", "web3_clientVersion"]);
const browser = await chromium.launch({ headless: true });
for (const url of SITES) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const reqs = [];
  page.on("request", (r) => {
    if (r.method() !== "POST") return;
    const b = r.postData();
    if (!b || !b.includes("jsonrpc")) return;
    try { const v = JSON.parse(b); reqs.push({ t: Date.now(), host: new URL(r.url()).hostname, calls: Array.isArray(v) ? v : [v] }); } catch {}
  });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => console.log("nav:", e.message.slice(0, 80)));
  await page.waitForTimeout(25000);
  const calls = reqs.flatMap((r) => r.calls.map((c) => ({ ...c, host: r.host, t: r.t - t0 })));
  const key = (c) => c.method + JSON.stringify(c.params ?? []);
  const seen = new Set(); let dup = 0, stat = 0;
  const methods = {};
  for (const c of calls) { methods[c.method] = (methods[c.method] ?? 0) + 1; if (STATIC.has(c.method)) stat++; if (seen.has(key(c))) dup++; seen.add(key(c)); }
  // sends that a 100 ms coalescing window would have merged into one HTTP request
  const ts = reqs.map((r) => r.t).sort((a, b) => a - b); let bursts = 0, last = -1e9;
  for (const t of ts) { if (t - last > 100) bursts++; last = t; }
  const multicalls = calls.filter((c) => c.method === "eth_call" && JSON.stringify(c.params).toLowerCase().includes("ca11bde05977b3631167028862be2a173976ca11")).length;
  console.log(JSON.stringify({ url, httpRequests: reqs.length, rpcCalls: calls.length, hosts: [...new Set(reqs.map((r) => r.host))], methods, staticCalls: stat, exactDuplicates: dup, afterCoalesce100ms: bursts, multicall3Calls: multicalls }));
  await ctx.close();
}
await browser.close();
