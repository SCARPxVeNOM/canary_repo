// Read-only latency probes for tor-js through the real on-chain specifier.
// usage: node drive.mjs <suite> [gateway]   (suite: all | cold | gateway-compare)
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMPL = process.env.ANON_RPC_IMPL ?? "../../../anon-rpc/impl/";
const require = createRequire(IMPL + "package.json");
const esbuild = require("esbuild");
const { chromium } = await import(IMPL + "node_modules/playwright/index.mjs");
const HERE = new URL(".", import.meta.url).pathname;

const DEMO_GW = "152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ";
const suite = process.argv[2] ?? "all";
const GW = process.argv[3] ?? DEMO_GW;
const RPC = "https://ethereum-rpc.publicnode.com";
const SEP = "https://ethereum-sepolia-rpc.publicnode.com";
// 20 well-known, distinct mainnet addresses (contract addresses, none personal).
const ADDRS = ["0x00000000219ab540356cBB839Cbe05303d7705Fa","0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2","0xdAC17F958D2ee523a2206206994597C13D831ec7","0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","0x6B175474E89094C44Da98b954EedeAC495271d0F","0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984","0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D","0xE592427A0AEce92De3Edee1F18E0157C05861564","0x514910771AF9Ca656af840dff83E8264EcF986CA","0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599","0x7Be8076f4EA4A4AD08075C2508e481d6C946D12b","0x5a0b54d5dc17e0AadC383d2db43B0a0D3E029c4c","0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE","0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84","0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0","0x1F98431c8aD98523631AE4a59f267346ea31F984","0xcA11bde05977b3631167028862bE2a173976CA11","0x00000000006c3852cbEf3e08E8dF289169EdE581","0xBe0eB53F46cd790Cd13851d5EFf43D12404d33E8","0x40B38765696e3d5d8d9d834D8AaD4bB6e418E489"];

await esbuild.build({ entryPoints: [HERE + "page.ts"], bundle: true, format: "esm", outfile: HERE + "out/page.js", nodePaths: [IMPL + "node_modules"], logLevel: "error", platform: "browser" });
const http = createServer((req, res) => {
  if (req.url.startsWith("/page.js")) { res.setHeader("content-type", "text/javascript"); return res.end(readFileSync(HERE + "out/page.js")); }
  res.setHeader("content-type", "text/html"); res.end('<!doctype html><script type="module" src="/page.js"></script>');
}).listen(0);
const base = `http://127.0.0.1:${http.address().port}/`;

const stat = (a) => { const s = [...a].sort((x, y) => x - y); return { n: s.length, min: s[0], p50: s[Math.floor(s.length / 2)], p90: s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)], max: s[s.length - 1] }; };
const out = { suite, gateway: GW };
const save = (name) => writeFileSync(`${HERE}${name}.json`, JSON.stringify(out, null, 2));
const say = (k, v) => { out[k] = v; console.log(k, JSON.stringify(v)); save(`res-${suite}`); };

async function session(profile) {
  const ctx = await chromium.launchPersistentContext(profile, { headless: true });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(base); await page.waitForFunction(() => window.probe);
  return { ctx, page };
}
const P = (page, fn, ...args) => page.evaluate(([f, a]) => window.probe[f](...a), [fn, args]);

if (suite === "cold" || suite === "gateway-compare") {
  // Cold boot on a fresh profile, then again on the same profile (storage cache).
  const prof = mkdtempSync(join(tmpdir(), "lat-"));
  for (const run of ["cold-fresh-profile", "warm-storage-1", "warm-storage-2"]) {
    const { ctx, page } = await session(prof);
    const ms = await P(page, "boot", { gateways: [GW] });
    const logs = await P(page, "logs");
    const first = await P(page, "one", RPC, "eth_blockNumber", []);
    say(run, { bootMs: ms, firstRead: first, logTail: logs.filter(l => /bootstrap|ready|consensus|snapshot|demo/i.test(l[2])).slice(0, 12) });
    await ctx.close();
  }
  if (suite === "gateway-compare") {
    const { ctx, page } = await session(prof);
    await P(page, "boot", { gateways: [GW] });
    await P(page, "one", RPC, "eth_blockNumber", []);
    const r = await P(page, "sequential", RPC, 15, ADDRS);
    say("seq15", { ...stat(r.each), ok: r.ok });
    const s = await P(page, "sequential", SEP, 15, [ADDRS[0]]);
    say("seq15-sepolia", { ...stat(s.each), ok: s.ok });
    await ctx.close();
  }
}

if (suite === "all") {
  const prof = mkdtempSync(join(tmpdir(), "lat-"));
  const { ctx, page } = await session(prof);
  say("boot", await P(page, "boot", { gateways: [GW] }));
  await P(page, "one", RPC, "eth_blockNumber", []);

  // 1. Direct control from Node (no Tor)
  const d = [];
  for (let i = 0; i < 10; i++) { const t = performance.now(); await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [ADDRS[0], "latest"] }) }).then(r => r.text()); d.push(Math.round(performance.now() - t)); }
  say("direct", stat(d));

  // 2. Warm sequential, no key
  const seq = await P(page, "sequential", RPC, 20, ADDRS);
  say("seq20-nokey", { ...stat(seq.each), totalMs: seq.totalMs, ok: seq.ok, each: seq.each });

  // 3. Is isolationKey real, and what does a new key cost?
  const ips = {};
  for (const k of [undefined, "k-a", "k-b", "k-a"]) { const j = await P(page, "ip", k).catch(e => ({ err: String(e) })); ips[k ?? "none"] = (ips[k ?? "none"] ?? []).concat(j.IP ?? j.err); }
  say("exitIpByKey", ips);
  const firsts = [], seconds = [];
  for (let i = 0; i < 6; i++) { const k = `addr:probe-${i}`; const a = await P(page, "one", RPC, "eth_getBalance", [ADDRS[i], "latest"], k); const b = await P(page, "one", RPC, "eth_getBalance", [ADDRS[i], "latest"], k); if (a.ok) firsts.push(a.ms); if (b.ok) seconds.push(b.ms); }
  say("newKey-firstRead", stat(firsts)); say("newKey-secondRead", stat(seconds));

  // 4. 20 reads, four shapes
  for (let round = 0; round < 3; round++) {
    say(`r${round}-seq20`, await P(page, "sequential", RPC, 20, ADDRS).then(r => ({ totalMs: r.totalMs, ok: r.ok })));
    say(`r${round}-par20`, await P(page, "parallel", RPC, 20, ADDRS).then(r => ({ totalMs: r.totalMs, ok: r.ok, p50: r.each[10], max: r.each[19] })));
    say(`r${round}-jsonrpc-batch20`, await P(page, "batch", RPC, 20, ADDRS));
    say(`r${round}-multicall20`, await P(page, "multicall", RPC, 20, ADDRS));
  }
  // 5. Hedging: same read on two preheated keys; take the winner.
  const hedge = await page.evaluate(async ([url, addr]) => {
    const p = window.probe; const singles = [], hedged = [];
    await p.one(url, "eth_getBalance", [addr, "latest"], "h1"); await p.one(url, "eth_getBalance", [addr, "latest"], "h2");
    for (let i = 0; i < 15; i++) {
      const [a, b] = await Promise.all([p.one(url, "eth_getBalance", [addr, "latest"], "h1"), p.one(url, "eth_getBalance", [addr, "latest"], "h2")]);
      singles.push(a.ms); hedged.push(Math.min(a.ok ? a.ms : 1e9, b.ok ? b.ms : 1e9));
    }
    return { singles, hedged };
  }, [RPC, ADDRS[0]]);
  say("hedge-single", stat(hedge.singles)); say("hedge-race2", stat(hedge.hedged));

  // 6. Idle: does a read after a quiet period pay extra?
  for (const idle of [30, 120]) { await new Promise(r => setTimeout(r, idle * 1000)); say(`afterIdle${idle}s`, await P(page, "one", RPC, "eth_getBalance", [ADDRS[0], "latest"])); }

  // 7. Endpoint choice over Tor
  for (const url of [RPC, "https://1rpc.io/eth", "https://eth.drpc.org", "https://rpc.ankr.com/eth", "https://eth-mainnet.public.blastapi.io", SEP, "https://1rpc.io/sepolia"]) {
    const r = await P(page, "sequential", url, 8, [ADDRS[0]]);
    say(`endpoint ${url}`, { ...stat(r.each), ok: r.ok });
  }
  await ctx.close();
}
http.close(); process.exit(0);
