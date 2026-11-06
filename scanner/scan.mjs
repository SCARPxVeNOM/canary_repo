#!/usr/bin/env node
// Canary scanner: load a dapp with a fake wallet holding a fresh canary
// address, record every request through mitmproxy, and report who received
// the address, in which encoding, and whether it was declared.
//
//   node scan.mjs <url>                            # baseline
//   node scan.mjs <url> --canary ../extension/dist # with Canary loaded
//   node scan.mjs <url> --compare --canary ../extension/dist   # both + before/after table
//
// Options: --chain 0x1 (wallet chain) · --rpc <url> (scanner-side RPC for wallet reads)
//          --manifest <file.json> · --out <dir> · --wait <ms> · --headful · --chrome <path>

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { checksum, classify, match, needles, site } from "./lib/matcher.mjs";

const HERE = import.meta.dirname;
const VERSION = "0.1.0";

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    canary: { type: "string" },
    compare: { type: "boolean", default: false },
    chain: { type: "string", default: "0x1" },
    rpc: { type: "string" },
    manifest: { type: "string" },
    out: { type: "string", default: "scans" },
    wait: { type: "string", default: "8000" },
    headful: { type: "boolean", default: false },
    chrome: { type: "string", default: process.env.CHROME_BIN },
    port: { type: "string", default: "8899" },
    keep: { type: "boolean", default: false },
  },
});
const url = positionals[0];
if (!url) {
  console.error("usage: node scan.mjs <url> [--canary <extension dist>] [--compare] [--manifest m.json]");
  process.exit(2);
}

/* --- one scan ------------------------------------------------------------ */

async function scannerHash() {
  const h = createHash("sha256");
  for (const f of ["scan.mjs", "addon.py", "lib/matcher.mjs", "lib/wallet.js"]) h.update(await readFile(resolve(HERE, f)));
  return h.digest("hex").slice(0, 12);
}

function waitPort(port, ms = 20000) {
  const until = Date.now() + ms;
  return new Promise((res, rej) => {
    const tryOnce = () => {
      const s = createConnection(port, "127.0.0.1");
      s.on("connect", () => (s.end(), res()));
      s.on("error", () => (Date.now() > until ? rej(new Error("mitmdump did not start")) : setTimeout(tryOnce, 250)));
    };
    tryOnce();
  });
}

async function connectFlow(page, log) {
  const btn = page.locator("button, [role=button], a").filter({ hasText: /^\s*(connect( wallet)?|sign in|log ?in)\s*$/i });
  if ((await btn.count()) === 0) return log("connect: no connect button found");
  await btn.first().click({ timeout: 5000 }).catch(() => {});
  log("connect: clicked");
  await page.waitForTimeout(1500);
  const pick = page.getByText(/Canary Scanner|Browser Wallet|Injected/i).first();
  if (await pick.isVisible().catch(() => false)) {
    await pick.click({ timeout: 3000 }).catch(() => {});
    log("connect: picked the scanner wallet in a modal");
  }
}

async function scanOnce({ withCanary }) {
  const address = checksum("0x" + randomBytes(20).toString("hex"));
  const work = await mkdtemp(resolve(tmpdir(), "canary-scan-"));
  const flowsFile = resolve(work, "flows.jsonl");
  const steps = [];
  const log = (s) => (steps.push(s), console.log(`  · ${s}`));

  const mitm = spawn("mitmdump", ["-q", "-p", opt.port, "-s", resolve(HERE, "addon.py"), "--set", "ssl_insecure=true"], {
    env: { ...process.env, CANARY_SCAN_OUT: flowsFile },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitPort(Number(opt.port));

  const args = [
    `--proxy-server=http://127.0.0.1:${opt.port}`,
    "--proxy-bypass-list=<-loopback>", // send localhost through the proxy too
    "--disable-quic",
    "--ignore-certificate-errors",
    "--no-sandbox",
  ];
  if (withCanary) args.push(`--disable-extensions-except=${resolve(opt.canary)}`, `--load-extension=${resolve(opt.canary)}`);
  const ctx = await chromium.launchPersistentContext(resolve(work, "profile"), {
    headless: !opt.headful,
    executablePath: opt.chrome,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
    args,
  });
  let sw;
  try {
    if (withCanary) sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 30000 }));
    await ctx.exposeBinding("__canaryScannerRpc", async (_src, method, params) => {
      if (!opt.rpc) throw Object.assign(new Error("no scanner RPC configured"), { code: 4200 });
      const r = await fetch(opt.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
      return j.result;
    });
    const wallet = (await readFile(resolve(HERE, "lib/wallet.js"), "utf8")).replaceAll("__ADDR__", address).replaceAll("__CHAIN__", opt.chain);
    await ctx.addInitScript(wallet);

    const page = await ctx.newPage();
    log(`load ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);
    await connectFlow(page, log);
    await page.waitForTimeout(Number(opt.wait));
    log("scroll");
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(3000);

    var canaryStats = null;
    if (sw) {
      canaryStats = await sw.evaluate(async (origin) => {
        await new Promise((r) => setTimeout(r, 500));
        const all = await chrome.storage.session.get(null);
        const hit = Object.entries(all).find(([k, v]) => k.startsWith("tab:") && v.origin === origin);
        return hit ? hit[1] : null;
      }, new URL(url).origin);
    }
  } finally {
    await ctx.close();
    mitm.kill("SIGINT");
    await new Promise((r) => mitm.on("exit", r));
  }
  const records = (await readFile(flowsFile, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  await rm(work, { recursive: true, force: true });
  return { address, records, canaryStats, steps, raw: opt.keep ? records : null };
}

/* --- analysis ------------------------------------------------------------ */

async function loadManifest() {
  if (!opt.manifest) return null;
  return JSON.parse(await readFile(resolve(opt.manifest), "utf8"));
}
const declaredIn = (manifest, host) =>
  !manifest ? null : manifest.recipients.some((r) => r.host === host || site(r.host) === site(host));

function analyze({ address, records, canaryStats, steps }, manifest, withCanary) {
  const pageHost = new URL(url).hostname;
  const n = needles(address);
  const recipients = new Map();
  const canaryEgress = [];
  let rpcDirect = 0, rpcDirectWithAddress = 0;
  const fp = [];

  for (const rec of records) {
    if (rec.respSha256 && site(rec.host) === site(pageHost)) fp.push(`${new URL(rec.url).pathname} ${rec.respSha256}`);
    const cls = classify(rec, pageHost);
    const hits = [
      ...match(rec.url, n).map((e) => `${e} in URL`),
      ...match(rec.body, n).map((e) => `${e} in ${rec.type === "ws" ? "WS frame" : "body"}`),
    ];
    if (cls.party === "canary") {
      canaryEgress.push({ kind: cls.kind, host: rec.host, carried: hits.length > 0 });
      continue;
    }
    const dest = rec.headers?.["sec-fetch-dest"];
    const isAsset = ["script", "style", "image", "font", "document", "iframe", "manifest"].includes(dest) && !hits.length && cls.kind !== "analytics";
    if (isAsset) continue;
    if (cls.kind === "rpc") {
      rpcDirect += cls.methods.length;
      if (hits.length) rpcDirectWithAddress += cls.methods.length;
    }
    const r = recipients.get(rec.host) ?? { host: rec.host, party: cls.party, kinds: new Set(), requests: 0, carried: 0, encodings: new Set(), methods: new Set(), channels: new Set() };
    r.kinds.add(cls.kind);
    r.requests++;
    r.channels.add(rec.type === "ws" ? "websocket" : dest || "fetch/xhr");
    for (const m of cls.methods ?? []) r.methods.add(m);
    if (hits.length) {
      r.carried++;
      hits.forEach((h) => r.encodings.add(h));
    }
    recipients.set(rec.host, r);
  }

  const list = [...recipients.values()].map((r) => ({
    host: r.host,
    party: r.party,
    kind: [...r.kinds].join("+"),
    requests: r.requests,
    carriedAddress: r.carried,
    encodings: [...r.encodings],
    methods: [...r.methods],
    channels: [...r.channels],
    declared: r.party === "first" ? true : declaredIn(manifest, r.host),
  })).sort((a, b) => b.carriedAddress - a.carriedAddress || b.requests - a.requests);

  const c = canaryStats?.counts;
  const viaAnon = c ? c.protected + c.protectedIpOnly : 0;
  const undeclared = list.filter((r) => r.carriedAddress && r.declared === false).map((r) => r.host);
  return {
    url,
    scannedAt: new Date().toISOString(),
    scanner: { version: VERSION, hash: null },
    build: { fingerprint: createHash("sha256").update(fp.sort().join("\n")).digest("hex").slice(0, 12), documents: fp.length },
    withCanary,
    canaryAddress: address,
    flows: steps,
    requestsSeen: records.length,
    recipients: list,
    rpc: {
      directCalls: rpcDirect,
      directCallsWithAddress: rpcDirectWithAddress,
      viaAnonRpc: viaAnon,
      coveragePct: viaAnon + rpcDirect ? Math.round((100 * viaAnon) / (viaAnon + rpcDirect)) : null,
    },
    canary: canaryStats ? { counts: canaryStats.counts, notes: canaryStats.notes, latencyMs: pcts(canaryStats.latencies) } : null,
    canaryEgress: summarizeEgress(canaryEgress),
    undeclared,
    notInspected: ["service workers' own traffic", "WebRTC", "encrypted or arbitrarily obfuscated payloads", "flows beyond load → connect → scroll"],
  };
}
const pcts = (xs) => {
  if (!xs?.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { p50: p(0.5), p95: p(0.95), n: s.length };
};
function summarizeEgress(list) {
  const out = {};
  for (const e of list) {
    const k = `${e.kind} → ${e.host}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/* --- reports ------------------------------------------------------------- */

function markdown(r) {
  const yes = (b) => (b === null ? "—" : b ? "yes" : "**no**");
  const lines = [
    `# Canary scan: ${r.url}`,
    "",
    `${r.withCanary ? "**With Canary.**" : "**Baseline (no Canary).**"} Scanned ${r.scannedAt} · build \`${r.build.fingerprint}\` · scanner ${r.scanner.version} (\`${r.scanner.hash}\`) · canary address \`${r.canaryAddress}\` (synthetic)`,
    "",
    `Flows: ${r.flows.join(" → ")}`,
    "",
    "## Who received the canary address",
    "",
    "| Recipient | Party | Kind | Requests | With address | Encodings | Declared |",
    "|---|---|---|---|---|---|---|",
    ...r.recipients.map((x) => `| \`${x.host}\` | ${x.party} | ${x.kind}${x.methods.length ? ` (${x.methods.slice(0, 4).join(", ")})` : ""} | ${x.requests} | ${x.carriedAddress || "0"} | ${x.encodings.join("; ") || "—"} | ${yes(x.declared)} |`),
    "",
    "## RPC",
    "",
    `- JSON-RPC calls the proxy saw leave the page directly: **${r.rpc.directCalls}** (${r.rpc.directCallsWithAddress} containing the address)`,
    `- JSON-RPC calls answered via anon-rpc (from Canary): **${r.rpc.viaAnonRpc}**`,
    `- Coverage: **${r.rpc.coveragePct ?? "—"}${r.rpc.coveragePct === null ? "" : "%"}** of RPC calls went through anon-rpc`,
    ...(r.canary ? [`- Canary's own counts: ${Object.entries(r.canary.counts).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ")}${r.canary.latencyMs ? ` · latency p50 ${r.canary.latencyMs.p50} ms, p95 ${r.canary.latencyMs.p95} ms` : ""}`] : []),
    ...(Object.keys(r.canaryEgress).length ? ["", `Canary's own egress seen by the proxy (an anonymizing worker sends over WebRTC and never shows up here; the passthrough test worker does): ${Object.entries(r.canaryEgress).map(([k, v]) => `${k} ×${v}`).join(", ")}`] : []),
    "",
    "## Verdict",
    "",
    r.undeclared.length
      ? `Undeclared recipients of the address observed: ${r.undeclared.map((h) => `\`${h}\``).join(", ")}.`
      : r.recipients.some((x) => x.declared === null && x.carriedAddress && x.party === "third")
        ? "No manifest supplied: third-party recipients above are unchecked."
        : `No undeclared recipients observed in ${r.flows.length} flow steps on build \`${r.build.fingerprint}\`.`,
    "",
    `Not inspected: ${r.notInspected.join(", ")}. "No leak observed" is not "no leak".`,
    "",
  ];
  return lines.join("\n");
}

function compareMd(a, b) {
  const hosts = [...new Set([...a.recipients, ...b.recipients].map((x) => x.host))];
  const get = (r, h) => r.recipients.find((x) => x.host === h);
  const cell = (x) => (x ? `${x.carriedAddress}/${x.requests}` : "0/0");
  return [
    `# Before / after: ${a.url}`,
    "",
    `Build \`${a.build.fingerprint}\` → \`${b.build.fingerprint}\` · scanner \`${a.scanner.hash}\` · each run used a fresh synthetic canary address.`,
    "",
    "| Recipient | Party | Without Canary (with address / requests) | With Canary |",
    "|---|---|---|---|",
    ...hosts.map((h) => `| \`${h}\` | ${(get(a, h) ?? get(b, h)).party} | ${cell(get(a, h))} | ${cell(get(b, h))} |`),
    "",
    `| RPC | Without | With |`,
    `|---|---|---|`,
    `| Calls leaving the page directly | ${a.rpc.directCalls} | ${b.rpc.directCalls} |`,
    `| Calls via anon-rpc | ${a.rpc.viaAnonRpc} | ${b.rpc.viaAnonRpc} |`,
    `| Coverage | ${a.rpc.coveragePct ?? 0}% | ${b.rpc.coveragePct ?? "—"}% |`,
    "",
    `Third parties that received the address: **${a.recipients.filter((x) => x.party === "third" && x.carriedAddress).length} → ${b.recipients.filter((x) => x.party === "third" && x.carriedAddress).length}**.`,
    "",
  ].join("\n");
}

/* --- main ---------------------------------------------------------------- */

const manifest = await loadManifest();
const hash = await scannerHash();
await mkdir(resolve(opt.out), { recursive: true });
const slug = new URL(url).host.replace(/[^a-z0-9.-]/gi, "_");

async function run(withCanary) {
  console.log(`\n${withCanary ? "With Canary" : "Baseline"}: ${url}`);
  const raw = await scanOnce({ withCanary });
  const report = analyze(raw, manifest, withCanary);
  report.scanner.hash = hash;
  const base = resolve(opt.out, `${slug}.${withCanary ? "canary" : "baseline"}`);
  await writeFile(`${base}.json`, JSON.stringify(report, null, 2));
  await writeFile(`${base}.md`, markdown(report));
  if (raw.raw) await writeFile(`${base}.flows.jsonl`, raw.raw.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`  → ${base}.md`);
  return report;
}

if (opt.compare) {
  if (!opt.canary) throw new Error("--compare needs --canary <extension dist>");
  const a = await run(false);
  const b = await run(true);
  const file = resolve(opt.out, `${slug}.compare.md`);
  await writeFile(file, compareMd(a, b));
  console.log(`\n${compareMd(a, b)}\n→ ${file}`);
} else {
  const r = await run(!!opt.canary);
  console.log("\n" + markdown(r));
}
