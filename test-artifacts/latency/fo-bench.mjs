// Gateway failover, stock tor-js vs patched (keep-alive + gateway liveness
// check): reads every 500 ms through 3 own gateways; the busiest is killed
// twice. Same harness as ka-bench.mjs (ka-page.ts).
//   STOCK=… PATCHED=… CHROME_BIN=… node fo-bench.mjs
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os"; import { join } from "node:path";

const IMPL = process.env.ANON_RPC_IMPL ?? new URL("../../../anon-rpc/impl/", import.meta.url).pathname;
const require = createRequire(IMPL + "package.json");
const esbuild = require("esbuild");
const { chromium } = await import(IMPL + "node_modules/playwright/index.mjs");
const HERE = new URL(".", import.meta.url).pathname;
const DOCKER = process.env.DOCKER ?? "docker";
const RPC = "https://ethereum-rpc.publicnode.com";
const GATEWAYS = JSON.parse(readFileSync(HERE + "../../extension/config/local-gateway.json", "utf8")).network.workerConfig.gateways;
const CONTAINERS = ["canary-gateway", "canary-gateway-12299", "canary-gateway-12300"];
const BUNDLES = { stock: process.env.STOCK, patched: process.env.PATCHED };

await esbuild.build({ entryPoints: [HERE + "ka-page.ts"], bundle: true, format: "esm", outfile: HERE + "out/ka-page.js", nodePaths: [IMPL + "node_modules"], logLevel: "error", platform: "browser" });
const http = createServer((req, res) => {
  const name = req.url.slice(1).split("?")[0];
  if (name === "ka-page.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(HERE + "out/ka-page.js"));
  if (name.endsWith(".js") && BUNDLES[name.slice(0, -3)]) return res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" }).end(readFileSync(BUNDLES[name.slice(0, -3)]));
  res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><script type="module" src="/ka-page.js"></script>');
}).listen(0, "127.0.0.1");
await new Promise((r) => http.once("listening", r));
const base = `http://127.0.0.1:${http.address().port}/`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const rx = () => Object.fromEntries(execSync(`${DOCKER} stats --no-stream --format '{{.Name}} {{.NetIO}}' ${CONTAINERS.join(" ")}`).toString().trim().split("\n").map((l) => {
  const [n, v] = l.split(" "); return [n, parseFloat(v) * ({ kB: 1e3, MB: 1e6, GB: 1e9, B: 1 }[v.replace(/[\d.]/g, "")] ?? 1)];
}));
const out = {};

for (const variant of ["stock", "patched"]) {
  execSync(`${DOCKER} start ${CONTAINERS.join(" ")}`); await pause(15000);
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "fo-")), { headless: true, executablePath: process.env.CHROME_BIN });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(base); await page.waitForFunction(() => window.probe);
  await page.evaluate(([g, u]) => window.probe.boot({ gateways: g }, u), [GATEWAYS, `${base}${variant}.js`]);
  const log = []; const t0 = Date.now(); let stop = false;
  const loop = (async () => { while (!stop) { const at = Date.now() - t0; const r = await page.evaluate((u) => window.probe.read(u, "0x00000000219ab540356cBB839Cbe05303d7705Fa"), RPC); log.push({ at, ...r }); await pause(500); } })();
  await pause(8000);
  const rounds = []; const killed = [];
  for (let round = 0; round < 2; round++) {
    const a = rx(); await pause(6000); const b = rx();
    const victim = CONTAINERS.filter((c) => !killed.includes(c)).sort((x, y) => (b[y] - a[y]) - (b[x] - a[x]))[0];
    const at = Date.now() - t0; execSync(`${DOCKER} kill ${victim}`); killed.push(victim);
    await pause(40000);
    const after = log.filter((l) => l.at >= at - 500);
    const lastOkBefore = log.filter((l) => l.ok && l.at + l.ms < at).slice(-1)[0];
    // recovered = first of 3 consecutive OK reads under 2 s after the kill
    const idx = after.findIndex((l, i) => after.slice(i, i + 3).length === 3 && after.slice(i, i + 3).every((x) => x.ok && x.ms < 2000));
    const rec = idx >= 0 ? after[idx] : null;
    rounds.push({ victim, failed: after.filter((l) => !l.ok).length, slowOver2s: after.filter((l) => l.ok && l.ms >= 2000).length, recoveredAfterMs: rec ? rec.at + rec.ms - at : null, gapMs: rec && lastOkBefore ? rec.at + rec.ms - (lastOkBefore.at + lastOkBefore.ms) : null, reads: after.slice(0, 14).map((l) => (l.ok ? l.ms : "✗" + l.ms)).join(" ") });
    console.log(variant, JSON.stringify(rounds.at(-1)));
  }
  stop = true; await loop; await ctx.close();
  out[variant] = rounds;
}
execSync(`${DOCKER} start ${CONTAINERS.join(" ")}`);
writeFileSync(HERE + "res-failover-patched.json", JSON.stringify(out, null, 1));
http.close(); process.exit(0);
