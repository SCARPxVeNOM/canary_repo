// Real extension, real dapps, own gateway: old code vs new code.
//   node live-compare.mjs <label> <unpacked dir> [rounds]
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(new URL("../../extension/node_modules/playwright/index.mjs", import.meta.url).href);
const CHROME = process.env.CHROME_BIN;
const [label, dir, roundsArg] = process.argv.slice(2);
const SITES = ["https://app.ens.domains/vitalik.eth", "https://app.uniswap.org/explore/tokens", "https://curve.fi/dex/ethereum/pools/"];
const ROUNDS = Number(roundsArg ?? 1);

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "live-")), {
  headless: true, executablePath: CHROME,
  args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, "--no-first-run"],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 30000 }));
const t0 = Date.now();
let worker;
for (;;) {
  worker = (await sw.evaluate(() => chrome.storage.session.get("worker"))).worker;
  if (worker?.state === "ready" || worker?.state === "failed" || Date.now() - t0 > 180000) break;
  await new Promise((r) => setTimeout(r, 250));
}
const out = { label, boot: { ...worker, observedMs: Date.now() - t0 }, sites: [] };
console.log(label, "worker", JSON.stringify(out.boot));
await new Promise((r) => setTimeout(r, 3000)); // let the pre-warm finish, as it would in real use

const tabState = () => sw.evaluate(async () => {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith("tab:")).map(([, v]) => v);
});
for (let round = 0; round < ROUNDS; round++) for (const url of SITES) {
  const page = await ctx.newPage();
  const start = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  // settled = the page's RPC count and outcomes stop changing for 6 s
  let last = "", lastChange = Date.now(), s;
  while (Date.now() - lastChange < 6000 && Date.now() - start < 90000) {
    await new Promise((r) => setTimeout(r, 250));
    s = (await tabState()).find((t) => t.origin === new URL(url).origin);
    const sig = JSON.stringify(s?.counts) + s?.rpcCalls;
    if (sig !== last) { last = sig; lastChange = Date.now(); }
  }
  const settleMs = lastChange - start;
  const lat = [...(s?.latencies ?? [])].sort((a, b) => a - b);
  const r = { url, round, settleMs, rpcCalls: s?.rpcCalls, protected: s?.counts?.protected, ipOnly: s?.counts?.protectedIpOnly, failedClosed: s?.counts?.failedClosed, noRequest: s?.noRequest, latP50: lat[Math.floor(lat.length / 2)], latMax: lat[lat.length - 1] };
  out.sites.push(r);
  console.log(label, JSON.stringify(r));
  await page.close();
}
const st = await sw.evaluate(async () => { try { return await new Promise((res) => chrome.runtime.sendMessage({ type: "state", tabId: -1 }, res)); } catch { return null; } }).catch(() => null);
out.pipeline = st?.pipeline;
console.log(label, "pipeline", JSON.stringify(out.pipeline));
writeFileSync(new URL(`res-live-${label}.json`, import.meta.url), JSON.stringify(out, null, 2));
await ctx.close();
process.exit(0);
