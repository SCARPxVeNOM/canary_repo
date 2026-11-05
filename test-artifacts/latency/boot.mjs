// Cold-boot comparison on fresh profiles: gateway snapshot vs host-supplied
// config.bootstrap vs reused storage. Downloads the public snapshot over KPS first.
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMPL = process.env.ANON_RPC_IMPL ?? "../../../anon-rpc/impl/";
const require = createRequire(IMPL + "package.json");
const esbuild = require("esbuild");
const { chromium } = await import(IMPL + "node_modules/playwright/index.mjs");
const HERE = new URL(".", import.meta.url).pathname;
const GW = "152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ";
const RPC = "https://ethereum-rpc.publicnode.com";
const SNAP = HERE + "out/bootstrap.zip.zst";
const TRIALS = Number(process.argv[2] ?? 3);

writeFileSync(HERE + "out/dl.ts", `
import { dial } from "@kpstreams/webrtc-client";
(window as any).dl = async (addr: string) => {
  const t0 = performance.now();
  const c = await dial(addr); const dialMs = performance.now() - t0;
  const s = await c.openStream();
  const w = s.writable.getWriter();
  await w.write(new TextEncoder().encode("GET /bootstrap.zip.zst HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n")); await w.close();
  const r = s.readable.getReader(); const parts: Uint8Array[] = []; let n = 0;
  for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value); n += value.length; }
  const all = new Uint8Array(n); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  let i = 0; while (!(all[i]===13&&all[i+1]===10&&all[i+2]===13&&all[i+3]===10)) i++;
  const head = new TextDecoder().decode(all.slice(0, i));
  const body = all.slice(i + 4);
  let bin = ""; for (let k = 0; k < body.length; k += 0x8000) bin += String.fromCharCode(...body.subarray(k, k + 0x8000));
  return { dialMs: Math.round(dialMs), totalMs: Math.round(performance.now() - t0), head, b64: btoa(bin) };
};`);
for (const [src, out] of [[HERE + "page.ts", "page.js"], [HERE + "out/dl.ts", "dl.js"]])
  await esbuild.build({ entryPoints: [src], bundle: true, format: "esm", outfile: HERE + "out/" + out, nodePaths: [IMPL + "node_modules", IMPL + "browser-harness/node_modules"], logLevel: "error", platform: "browser" });

const http = createServer((req, res) => {
  if (req.url === "/page.js" || req.url === "/dl.js") { res.setHeader("content-type", "text/javascript"); return res.end(readFileSync(HERE + "out" + req.url)); }
  if (req.url === "/snap") return res.end(readFileSync(SNAP));
  res.setHeader("content-type", "text/html"); res.end(`<!doctype html><script type="module" src="/page.js"></script><script type="module" src="/dl.js"></script>`);
}).listen(0);
const base = `http://127.0.0.1:${http.address().port}/`;

async function session(profile) {
  const ctx = await chromium.launchPersistentContext(profile, { headless: true });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(base); await page.waitForFunction(() => window.probe && window.dl);
  return { ctx, page };
}

if (!existsSync(SNAP)) {
  const { ctx, page } = await session(mkdtempSync(join(tmpdir(), "lat-")));
  const d = await page.evaluate((gw) => window.dl(gw), GW);
  writeFileSync(SNAP, Buffer.from(d.b64, "base64"));
  console.log("snapshot via gateway:", d.totalMs, "ms, dial", d.dialMs, "ms,", Buffer.from(d.b64, "base64").length, "bytes\n", d.head);
  await ctx.close();
}

const results = { gatewaySnapshot: [], hostSnapshot: [], storageReuse: [] };
const boot = (page, useSnap) => page.evaluate(async ([gw, useSnap]) => {
  const config = { gateways: [gw] };
  if (useSnap) config.bootstrap = new Uint8Array(await (await fetch("/snap")).arrayBuffer());
  return window.probe.boot(config);
}, [GW, useSnap]);
const read = (page) => page.evaluate((u) => window.probe.one(u, "eth_blockNumber", []), RPC);

for (let i = 0; i < TRIALS; i++) {
  // interleaved so network drift hits every arm
  for (const useSnap of [false, true]) {
    const prof = mkdtempSync(join(tmpdir(), "lat-"));
    let { ctx, page } = await session(prof);
    const ms = await Promise.race([boot(page, useSnap), new Promise((_, j) => setTimeout(() => j(new Error("boot>120s")), 120000))]).catch((e) => String(e.message));
    const first = typeof ms === "number" ? await read(page) : null;
    (useSnap ? results.hostSnapshot : results.gatewaySnapshot).push({ bootMs: ms, firstReadMs: first?.ms, ok: first?.ok });
    console.log(useSnap ? "hostSnapshot" : "gatewaySnapshot", ms, first?.ms, first?.ok);
    await ctx.close();
    if (!useSnap) {
      ({ ctx, page } = await session(prof));
      const ms2 = await Promise.race([boot(page, false), new Promise((_, j) => setTimeout(() => j(new Error("boot>120s")), 120000))]).catch((e) => String(e.message));
      const f2 = typeof ms2 === "number" ? await read(page) : null;
      results.storageReuse.push({ bootMs: ms2, firstReadMs: f2?.ms, ok: f2?.ok });
      console.log("storageReuse", ms2, f2?.ms, f2?.ok);
      await ctx.close();
    }
  }
}
writeFileSync(HERE + "res-boot.json", JSON.stringify(results, null, 2));
http.close(); process.exit(0);
