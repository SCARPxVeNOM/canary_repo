// Boot tor-js and nym once (specifier read from mainnet), then hit many public
// RPC endpoints through each arm and directly, to see which endpoints accept
// anonymized traffic. Drives the repo's own bench page.
const SITE = "/Users/mac/Desktop/canary/anon-rpc/impl/site/";
const { createServer } = await import(SITE + "node_modules/vite/dist/node/index.js").catch(
  () => import("/Users/mac/Desktop/canary/anon-rpc/impl/node_modules/vite/dist/node/index.js"));
const { chromium } = await import("/Users/mac/Desktop/canary/anon-rpc/impl/node_modules/playwright/index.mjs");
const { readFileSync } = await import("node:fs");
const JSON5 = (await import("/Users/mac/Desktop/canary/anon-rpc/impl/node_modules/json5/lib/index.js")).default;

const workers = JSON5.parse(readFileSync("/Users/mac/Desktop/canary/anon-rpc/adopters.json5", "utf8")).workers;
const arms = workers.filter((w) => ["tor-js", "nym"].includes(w.id))
  .map((w) => ({ id: w.id, specifier: w.specifier, config: w.exampleConfig }));

const ENDPOINTS = {
  mainnet: [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://cloudflare-eth.com",
    "https://eth.drpc.org",
    "https://1rpc.io/eth",
    "https://rpc.flashbots.net",
    "https://eth.merkle.io",
  ],
  sepolia: [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://sepolia.drpc.org",
    "https://1rpc.io/sepolia",
    "https://rpc.sepolia.org",
    "https://sepolia.gateway.tenderly.co",
  ],
};
const WATCH = "0x00000000219ab540356cBB839Cbe05303d7705Fa";

const vite = await createServer({ configFile: SITE + "vite.config.js", root: SITE + "src", server: { port: 0 }, logLevel: "silent" });
await vite.listen();
const base = vite.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${base}/bench/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof window.__bench?.boot === "function");

const boots = await page.evaluate(([a, r]) => window.__bench.boot(a, r), [arms, "https://ethereum-rpc.publicnode.com"]);
for (const b of boots) console.log(`boot ${b.id}: ${b.ok ? Math.round(b.bootMs) + "ms" : "FAIL " + b.error}`);
const live = ["direct", ...boots.filter((b) => b.ok).map((b) => b.id)];

const rows = [];
for (const [net, urls] of Object.entries(ENDPOINTS)) {
  for (const url of urls) {
    const row = { net, url };
    for (const arm of live) {
      const res = [];
      for (let i = 0; i < 3; i++) {
        const s = await Promise.race([
          page.evaluate(([a, u, w]) => window.__bench.sample(a, u, w), [arm, url, WATCH]),
          new Promise((r) => setTimeout(() => r({ ok: false, ms: 30000, error: "timeout" }), 30000)),
        ]);
        res.push(s);
      }
      const ok = res.filter((s) => s.ok);
      const ms = ok.map((s) => s.ms).sort((a, b) => a - b);
      row[arm] = ok.length ? `${ok.length}/3 ~${Math.round(ms[Math.floor(ms.length / 2)])}ms`
        : `0/3 (${(res[0].error || "").slice(0, 40)})`;
    }
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}
console.log("\n| net | endpoint | " + live.join(" | ") + " |\n|---|---|" + live.map(() => "---").join("|") + "|");
for (const r of rows) console.log(`| ${r.net} | ${r.url.replace("https://", "")} | ${live.map((a) => r[a]).join(" | ")} |`);
await browser.close();
await vite.close();
process.exit(0);
