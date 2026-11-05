import { createServer } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
const IMPL = process.env.ANON_RPC_IMPL ?? "../../../anon-rpc/impl/";
const { chromium } = await import(IMPL + "node_modules/playwright/index.mjs");
const HERE = new URL(".", import.meta.url).pathname;
const GW = "152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ";
const http = createServer((req, res) => {
  if (req.url === "/page.js") { res.setHeader("content-type", "text/javascript"); return res.end(readFileSync(HERE + "out/page.js")); }
  if (req.url === "/snap") return res.end(readFileSync(HERE + "out/bootstrap.zip.zst"));
  res.setHeader("content-type", "text/html"); res.end(`<!doctype html><script type="module" src="/page.js"></script>`);
}).listen(0);
const base = `http://127.0.0.1:${http.address().port}/`;
const prof = mkdtempSync(join(tmpdir(), "lat-"));
for (const [label, snap] of [["host-snapshot fresh", true], ["same profile again", false]]) {
  const ctx = await chromium.launchPersistentContext(prof, { headless: true });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(base); await page.waitForFunction(() => window.probe);
  const ms = await page.evaluate(async ([gw, snap]) => {
    const config = { gateways: [gw], logLevel: "info" };
    if (snap) config.bootstrap = new Uint8Array(await (await fetch("/snap")).arrayBuffer());
    return window.probe.boot(config);
  }, [GW, snap]);
  const logs = await page.evaluate(() => window.probe.logs());
  console.log(`\n== ${label}: boot ${ms} ms`);
  for (const l of logs) console.log(String(l[0]).padStart(6), l[1].padEnd(5), l[2].slice(0, 130));
  await ctx.close();
}
http.close(); process.exit(0);
