// Boot an extension build and print the anon-rpc worker's warnings with timestamps.
//   EXT_DIR=<build> CHROME_BIN=… node boot-log.mjs [seconds]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
const { chromium } = await import(new URL("../../extension/node_modules/playwright/index.mjs", import.meta.url).href);
const DIR = process.env.EXT_DIR, LIMIT = Number(process.argv[2] ?? 150) * 1000;
const t0 = Date.now();
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "bootlog-")), { headless: true, executablePath: process.env.CHROME_BIN, args: [`--disable-extensions-except=${DIR}`, `--load-extension=${DIR}`] });
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s";
sw.on("console", (m) => console.log(at(), m.type(), m.text().slice(0, 300)));
let last;
for (;;) {
  const w = (await sw.evaluate(() => chrome.storage.session.get("worker"))).worker;
  if (w?.state !== last) console.log(at(), "state", JSON.stringify(w)), (last = w?.state);
  if (w?.state === "ready" || w?.state === "failed" || Date.now() - t0 > LIMIT) break;
  await new Promise((r) => setTimeout(r, 200));
}
await ctx.close(); process.exit(0);
