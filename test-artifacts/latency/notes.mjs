import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const { chromium } = await import(new URL("../../extension/node_modules/playwright/index.mjs", import.meta.url).href);
const CHROME = process.env.CHROME_BIN;
const dir = process.argv[2];
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "n-")), { headless: true, executablePath: CHROME, args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`] });
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
for (let i = 0; i < 120; i++) { const w = (await sw.evaluate(() => chrome.storage.session.get("worker"))).worker; if (w?.state === "ready") break; await new Promise(r => setTimeout(r, 500)); }
for (const url of process.argv.slice(3)) {
  const p = await ctx.newPage(); await p.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {}); await p.waitForTimeout(25000);
  console.log(url, "final:", p.url());
  const all = await sw.evaluate(() => chrome.storage.session.get(null));
  for (const [k, v] of Object.entries(all)) if (k.startsWith("tab:")) console.log(" ", v.origin, JSON.stringify(v.counts), JSON.stringify(v.notes).slice(0, 600), Object.keys(v.recipients).join(","));
  await p.close();
}
await ctx.close(); process.exit(0);
