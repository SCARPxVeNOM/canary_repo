// Interleaved A/B of two unpacked builds on (a) a dashboard-style page making
// 20 parallel reads to a public RPC, (b) app.ens.domains. Same gateway, same hour.
//   node ab.mjs <rounds>
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(new URL("../../extension/node_modules/playwright/index.mjs", import.meta.url).href);
const CHROME = process.env.CHROME_BIN;
const BUILDS = { new: new URL("../../extension/dist-local", import.meta.url).pathname, old: process.env.OLD_BUILD };
const ROUNDS = Number(process.argv[2] ?? 3);
const ADDRS = ["0x00000000219ab540356cBB839Cbe05303d7705Fa","0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2","0xdAC17F958D2ee523a2206206994597C13D831ec7","0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","0x6B175474E89094C44Da98b954EedeAC495271d0F","0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984","0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D","0xE592427A0AEce92De3Edee1F18E0157C05861564","0x514910771AF9Ca656af840dff83E8264EcF986CA","0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"];

// dashboard: chainId x3, blockNumber x3, 10 balances, 4 duplicates of those — like a real wagmi page
const DASH = `<!doctype html><script>
const RPC = "https://eth.drpc.org";
const call = (method, params) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Math.random(), method, params }) }).then(r => r.json()).catch(e => ({ err: String(e) }));
window.run = async () => {
  const t0 = performance.now();
  const addrs = ${JSON.stringify(ADDRS)};
  const jobs = [call("eth_chainId", []), call("eth_chainId", []), call("eth_chainId", []), call("eth_blockNumber", []), call("eth_blockNumber", []), call("eth_blockNumber", []),
    ...addrs.map(a => call("eth_getBalance", [a, "latest"])), ...addrs.slice(0, 4).map(a => call("eth_getBalance", [a, "latest"]))];
  const rs = await Promise.all(jobs);
  return { ms: Math.round(performance.now() - t0), ok: rs.filter(r => r && r.result !== undefined && r.result !== null).length, n: rs.length };
};</script>`;
const server = createServer((q, s) => s.writeHead(200, { "content-type": "text/html" }).end(DASH)).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const DASH_URL = `http://127.0.0.1:${server.address().port}/dash`;

async function session(dir) {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ab-")), { headless: true, executablePath: CHROME, args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`] });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const t0 = Date.now();
  for (;;) { const w = (await sw.evaluate(() => chrome.storage.session.get("worker"))).worker; if (w?.state === "ready" || Date.now() - t0 > 120000) break; await new Promise((r) => setTimeout(r, 250)); }
  await new Promise((r) => setTimeout(r, 3000));
  return { ctx, sw, bootMs: Date.now() - t0 };
}
async function ens(ctx, sw) {
  const page = await ctx.newPage(); const start = Date.now();
  await page.goto("https://app.ens.domains/vitalik.eth", { waitUntil: "domcontentloaded" }).catch(() => {});
  let last = "", lastChange = Date.now(), s;
  while (Date.now() - lastChange < 6000 && Date.now() - start < 90000) {
    await new Promise((r) => setTimeout(r, 200));
    s = Object.entries(await sw.evaluate(() => chrome.storage.session.get(null))).find(([k, v]) => k.startsWith("tab:") && v.origin.includes("ens.domains"))?.[1];
    const sig = JSON.stringify(s?.counts);
    if (sig !== last) { last = sig; lastChange = Date.now(); }
  }
  await page.close();
  return { settleMs: lastChange - start, calls: s?.rpcCalls, protected: s?.counts?.protected, failed: s?.counts?.failedClosed };
}
const res = { new: { dash: [], ens: [], boot: [] }, old: { dash: [], ens: [], boot: [] } };
for (let r = 0; r < ROUNDS; r++) for (const name of r % 2 ? ["old", "new"] : ["new", "old"]) {
  const { ctx, sw, bootMs } = await session(BUILDS[name]);
  res[name].boot.push(bootMs);
  const p = await ctx.newPage(); await p.goto(DASH_URL);
  const d = await p.evaluate(() => window.run());
  const d2 = await p.evaluate(() => window.run()); // second load of the same view, a few seconds later
  res[name].dash.push(d.ms); res[name].dash2 = [...(res[name].dash2 ?? []), d2.ms];
  const e = await ens(ctx, sw);
  res[name].ens.push(e.settleMs);
  console.log(name, "round", r, JSON.stringify({ bootMs, dash: d, dashAgain: d2, ens: e }));
  await ctx.close();
}
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
for (const n of ["new", "old"]) console.log(n, "MEDIAN", JSON.stringify({ boot: med(res[n].boot), dash: med(res[n].dash), dashAgain: med(res[n].dash2), ensSettle: med(res[n].ens) }));
writeFileSync(new URL("res-ab.json", import.meta.url), JSON.stringify(res, null, 2));
server.close(); process.exit(0);
