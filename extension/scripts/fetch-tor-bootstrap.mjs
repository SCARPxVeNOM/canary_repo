// Fetch tor-js's fast-bootstrap snapshot (/bootstrap.zip.zst) from a gateway,
// for build.mjs to package into the extension.
//
//   node scripts/fetch-tor-bootstrap.mjs [--gateway ip:port:certhash] [--out .tor-bootstrap]
//
// Gateways speak KPS, which Node can't dial on every platform (the QUIC client
// needs native bindings), so this dials over WebRTC from headless Chromium, the
// way the browser itself would. The snapshot is the same public Tor directory
// for every client; tor-js checks it with arti's signature checks before use,
// so where it was fetched from doesn't need to be trusted.

import { build } from "esbuild";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const HERE = import.meta.dirname;

const DIAL = `
import { dial } from "@kpstreams/webrtc-client";
window.fetchSnapshot = async (addr) => {
  const conn = await dial(addr, { signal: AbortSignal.timeout(20000) });
  const s = await conn.openStream();
  const w = s.writable.getWriter();
  await w.write(new TextEncoder().encode("GET /bootstrap.zip.zst HTTP/1.1\\r\\nHost: gateway\\r\\n\\r\\n"));
  await w.close();
  const r = s.readable.getReader();
  const parts = []; let n = 0;
  for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value); n += value.length; }
  conn.close?.();
  const all = new Uint8Array(n); let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  let i = 0;
  while (i + 3 < n && !(all[i] === 13 && all[i + 1] === 10 && all[i + 2] === 13 && all[i + 3] === 10)) i++;
  const head = new TextDecoder().decode(all.subarray(0, i));
  const body = all.subarray(i + 4);
  let bin = "";
  for (let k = 0; k < body.length; k += 0x8000) bin += String.fromCharCode(...body.subarray(k, k + 0x8000));
  return { head, b64: btoa(bin) };
};`;

/** Reads the consensus times out of the snapshot (a stored zip inside zstd). */
export function snapshotInfo(bytes) {
  const text = zstdDecompressSync(bytes).toString("latin1");
  const at = (k) => {
    const m = text.match(new RegExp(`\\n?${k} (\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d)`));
    return m ? Date.parse(m[1].replace(" ", "T") + "Z") : NaN;
  };
  return { validAfter: at("valid-after"), validUntil: at("valid-until") };
}

export async function fetchTorBootstrap(gateways, outDir) {
  const js = (await build({ stdin: { contents: DIAL, resolveDir: HERE, loader: "js" }, bundle: true, write: false, format: "esm", platform: "browser", logLevel: "error" })).outputFiles[0].text;
  const server = createServer((req, res) => {
    if (req.url === "/dial.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(js);
    res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><script type="module" src="/dial.js"></script>');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.fetchSnapshot);
    const errors = [];
    for (const gw of gateways) {
      try {
        const t0 = Date.now();
        const { head, b64 } = await page.evaluate((a) => window.fetchSnapshot(a), gw);
        if (!/^HTTP\/1\.1 200/.test(head)) throw new Error(head.split("\r\n")[0]);
        const bytes = Buffer.from(b64, "base64");
        const info = snapshotInfo(bytes);
        if (!Number.isFinite(info.validAfter)) throw new Error("no consensus in the snapshot");
        await mkdir(outDir, { recursive: true });
        await writeFile(resolve(outDir, "bootstrap.zip.zst"), bytes);
        const meta = { gateway: gw, fetchedAt: Date.now(), ms: Date.now() - t0, bytes: bytes.length, ...info };
        await writeFile(resolve(outDir, "bootstrap.json"), JSON.stringify(meta, null, 2) + "\n");
        return meta;
      } catch (e) {
        errors.push(`${gw.split(":")[0]}: ${String(e?.message ?? e).split("\n")[0]}`);
      }
    }
    throw new Error(`no gateway served a snapshot (${errors.join("; ")})`);
  } finally {
    await browser.close();
    server.close();
  }
}

/** The packaged snapshot, fetched again if it is missing or older than `refreshHours`. */
export async function ensureTorBootstrap(gateways, outDir, refreshHours = 3) {
  try {
    const meta = JSON.parse(await readFile(resolve(outDir, "bootstrap.json"), "utf8"));
    if (Date.now() - meta.validAfter < refreshHours * 3600_000) return meta;
  } catch {
    /* none yet */
  }
  return fetchTorBootstrap(gateways, outDir);
}

if (process.argv[1] === import.meta.filename) {
  const { values } = parseArgs({ options: { gateway: { type: "string", multiple: true }, out: { type: "string", default: ".tor-bootstrap" }, config: { type: "string", default: "config/live.json" } } });
  const gateways = values.gateway ?? JSON.parse(await readFile(resolve(HERE, "..", values.config), "utf8")).network.workerConfig.gateways;
  const meta = await fetchTorBootstrap(gateways, resolve(HERE, "..", values.out));
  console.log(`snapshot: ${(meta.bytes / 1e6).toFixed(2)} MB from ${meta.gateway.split(":")[0]} in ${meta.ms} ms; consensus valid-after ${new Date(meta.validAfter).toISOString()}`);
}
