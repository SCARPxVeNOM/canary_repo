// End-to-end: the real extension, loaded unpacked into Chromium, against the
// leaky fixture dapp. Everything is local; *.test hosts are mapped to
// 127.0.0.1 with --host-resolver-rules, and the anon-rpc worker is EF's
// passthrough reference bundle, hash-verified exactly as on chain.
//
//   CHROME_BIN=/path/to/chromium node test/e2e.mjs
//
// Runs: (1) baseline without Canary, (2) with Canary, (3) read endpoint down →
// fail closed, (4) same with "allow direct" on, (5) protection off for the site,
// (6) undeclared recipient blocked on the site. Saves popup and dashboard
// screenshots to test/out/.

import { build } from "esbuild";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import { keccak_256 } from "@noble/hashes/sha3";
import { decodeFunctionData, encodeAbiParameters, namehash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildExtension } from "../build.mjs";
import { compareDeclared, signVerdict } from "./shared-src.mjs";

const HERE = import.meta.dirname;
const CHROME = process.env.CHROME_BIN;
const ADDR = "0x5ca1ab1e00000000000000000000000000c0ffee";
const ADDR_HEX = ADDR.slice(2);
const ADDR_B64 = Buffer.from(ADDR_HEX, "hex").toString("base64").replace(/=+$/, "");

/* --- servers -------------------------------------------------------------- */

const bundle = await readFile(resolve(HERE, "fixtures/passthrough-worker.js"));
const workerHash = Buffer.from(keccak_256(bundle)).toString("hex");
const sel = (s) => "0x" + Buffer.from(keccak_256(Buffer.from(s))).toString("hex").slice(0, 8);
const word = (n) => n.toString(16).padStart(64, "0");
const strArr = (ss) => {
  let h = word(32) + word(ss.length), off = "", body = "", cur = ss.length * 32;
  for (const s of ss) {
    const b = Buffer.from(s), p = Math.ceil(b.length / 32) * 32;
    off += word(cur); body += word(b.length) + b.toString("hex").padEnd(p * 2, "0"); cur += 32 + p;
  }
  return "0x" + h + off + body;
};

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, GET, OPTIONS" };
const logs = { provider: [], ws: [], hostile: [], tracker: [], read: [], points: [], indexer: [] };
const reset = () => Object.values(logs).forEach((l) => (l.length = 0));
let readDown = false;

const ANSWERS = {
  provider: { eth_chainId: "0xaa36a7", eth_blockNumber: "0x111", eth_getBalance: "0x1", eth_call: "0x" + word(1), alchemy_getTokenBalances: { from: "provider" } },
  read: { eth_chainId: "0xaa36a7", eth_blockNumber: "0x222", eth_getBalance: "0x2", eth_call: "0x" + word(2) },
};

// LeakyDash's ENS name, answered by the read endpoint's Universal Resolver:
// it declares its RPC provider and indexer, not its tracker (idea.md §3.4),
// and carries a verdict from a verifier it delegated privacy.verdict.canary to.
const UR = "0xeeeeeeee14d718c2b47d9923deab1335e144eeee";
const RESOLVER = "0x" + "22".repeat(20);
const VERIFIER_KEY = "0x6cbed15c793ce57650b9877cf6fa156fbef513c4e6134f022a85b1ffdd59b2a1";
const VERIFIER = privateKeyToAccount(VERIFIER_KEY).address;
let verdictRecord = "";
let labelRecord = "";
const ensRecords = () => ({
  "leakydash.eth": {
    url: `http://leakydash.test:${P}`,
    "privacy.manifest": JSON.stringify({ name: "leakydash.eth", recipients: [{ host: "rpc.provider.test", kind: "rpc", purpose: "reads balances" }, { host: "indexer.test", kind: "backend" }, { host: "cdn.leakydash-assets.test", kind: "backend" }] }),
    "privacy.verdict.canary": verdictRecord,
  },
  "verifier.canary.eth": { addr: VERIFIER },
  // A site with no manifest of its own: Canary's label for it (packages/ens/src/label.ts).
  "labelled-test.labels.canary.eth": { url: `http://labelled.test:${P}`, "privacy.verdict.canary": labelRecord },
});
const ensAbi = [
  { type: "function", name: "resolve", inputs: [{ type: "bytes" }, { type: "bytes" }], outputs: [{ type: "bytes" }, { type: "address" }] },
  { type: "function", name: "findResolver", inputs: [{ type: "bytes" }], outputs: [{ type: "address" }, { type: "bytes32" }, { type: "uint256" }] },
  { type: "function", name: "text", inputs: [{ type: "bytes32" }, { type: "string" }], outputs: [{ type: "string" }] },
  { type: "function", name: "addr", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "setText", inputs: [{ type: "bytes" }, { type: "string" }, { type: "string" }], outputs: [] },
  { type: "function", name: "roles", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
];
function ensAnswer(m) {
  const call = m.params?.[0];
  const to = call?.to?.toLowerCase();
  if (m.method !== "eth_call" || (to !== UR && to !== RESOLVER)) return undefined;
  const ok = (types, values) => ({ jsonrpc: "2.0", id: m.id, result: encodeAbiParameters(types, values) });
  const revert = { jsonrpc: "2.0", id: m.id, error: { code: 3, message: "execution reverted" } };
  const d = decodeFunctionData({ abi: ensAbi, data: call.data });
  if (d.functionName === "findResolver") return ok([{ type: "address" }, { type: "bytes32" }, { type: "uint256" }], [RESOLVER, "0x" + "00".repeat(32), 0n]);
  if (d.functionName === "roles") return ok([{ type: "uint256" }], [0n]);
  // the verifier holds the one-key role; nobody else can write
  if (d.functionName === "setText") return d.args[1] === "privacy.verdict.canary" && call.from?.toLowerCase() === VERIFIER.toLowerCase() ? { jsonrpc: "2.0", id: m.id, result: "0x" } : revert;
  const inner = decodeFunctionData({ abi: ensAbi, data: d.args[1] });
  const recs = Object.entries(ensRecords()).find(([n]) => namehash(n) === inner.args[0])?.[1] ?? {};
  const v = inner.functionName === "addr" ? recs.addr : recs[inner.args[1]];
  if (!v) return revert;
  const enc = inner.functionName === "addr" ? encodeAbiParameters([{ type: "address" }], [v]) : encodeAbiParameters([{ type: "string" }], [v]);
  return ok([{ type: "bytes" }, { type: "address" }], [enc, RESOLVER]);
}

const rpcAnswer = (answers, m) =>
  (answers === ANSWERS.read && ensAnswer(m)) ||
  (answers[m.method] === undefined
    ? { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no ${m.method}` } }
    : { jsonrpc: "2.0", id: m.id, result: answers[m.method] });

let dappJs = "";
let P;
const server = createServer((req, res) => {
  const host = (req.headers.host ?? "").split(":")[0];
  const origin = req.headers.origin ?? "(none)";
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
    const json = (code, v) => res.writeHead(code, { ...CORS, "content-type": "application/json" }).end(JSON.stringify(v));
    const rpc = (answers, log) => {
      const body = JSON.parse(raw || "{}");
      for (const m of Array.isArray(body) ? body : [body]) log.push({ method: m.method, origin, body: raw });
      return json(200, Array.isArray(body) ? body.map((m) => rpcAnswer(answers, m)) : rpcAnswer(answers, body));
    };
    switch (host) {
      case "leakydash.test":
        if (req.url === "/") return res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>LeakyDash (fixture)</title><h1>LeakyDash</h1><script src="/app.js"></script>`);
        if (req.url === "/app.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(dappJs);
        if (req.url.startsWith("/api/points")) return logs.points.push({ url: req.url }), json(200, { points: 42 });
        if (req.url === "/.well-known/canary.json") return json(200, { ens: "leakydash.eth" });
        return res.writeHead(404).end();
      case "labelled.test":
        // No /.well-known/canary.json; a wallet that hands the page its address on load.
        if (req.url === "/") return res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Labelled (fixture)</title><h1>A site with no manifest</h1><script>
          window.ethereum = { request: async ({ method }) => (method === "eth_accounts" || method === "eth_requestAccounts" ? ["${ADDR}"] : method === "eth_chainId" ? "0xaa36a7" : null), on() {} };
          addEventListener("load", () => ethereum.request({ method: "eth_requestAccounts" }));
        </script>`);
        return res.writeHead(404).end();
      case "rpc.provider.test":
        return rpc(ANSWERS.provider, logs.provider);
      case "torblock.provider.test":
        // Refuses anonymized traffic (the worker's requests carry Origin: null), like Tenderly over Tor.
        if (origin === "null") return logs.hostile.push({ method: "(refused)", origin, body: raw }), json(403, { error: "anonymous traffic not allowed" });
        return rpc(ANSWERS.provider, logs.hostile);
      case "read.canary.test":
        if (readDown) return json(503, { error: "down" });
        return rpc(ANSWERS.read, logs.read);
      case "tracker.test":
        logs.tracker.push({ path: req.url, body: raw });
        if (req.url.startsWith("/pixel.gif")) return res.writeHead(200, { "content-type": "image/gif" }).end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
        return res.writeHead(204, CORS).end();
      case "indexer.test":
        logs.indexer.push({ path: req.url });
        return json(200, { name: "vitalik.eth" });
      case "chain.test": {
        if (req.url === "/worker.js") return res.writeHead(200, { ...CORS, "content-type": "text/javascript" }).end(bundle);
        const m = JSON.parse(raw || "{}");
        if (m.method === "eth_chainId") return json(200, { jsonrpc: "2.0", id: m.id, result: "0x1" });
        if (m.params?.[0]?.data === sel("workerHash()")) return json(200, { jsonrpc: "2.0", id: m.id, result: "0x" + workerHash });
        if (m.params?.[0]?.data === sel("workerResolvers()")) return json(200, { jsonrpc: "2.0", id: m.id, result: strArr([`http://chain.test:${P}/worker.js`]) });
        return json(404, {});
      }
    }
    res.writeHead(404).end();
  });
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, sock, head) =>
  wss.handleUpgrade(req, sock, head, (ws) => {
    ws.on("message", (data) => {
      const s = String(data);
      const body = JSON.parse(s);
      for (const m of Array.isArray(body) ? body : [body]) logs.ws.push({ method: m.method, origin: req.headers.origin });
      ws.send(JSON.stringify(Array.isArray(body) ? body.map((m) => rpcAnswer(ANSWERS.provider, m)) : rpcAnswer(ANSWERS.provider, body)));
    });
  }),
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
P = server.address().port;
dappJs = (await build({ entryPoints: [resolve(HERE, "fixtures/dapp.ts")], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022", define: { __P__: JSON.stringify(String(P)) }, logLevel: "warning" })).outputFiles[0].text;
const DAPP = `http://leakydash.test:${P}/`;
verdictRecord = JSON.stringify(await signVerdict({
  name: "leakydash.eth", origin: new URL(DAPP).origin, verifier: "verifier.canary.eth", buildHash: "e36522b683b8", scannerHash: "296015c80bdd",
  flows: ["load", "connect: clicked", "scroll"], result: "undeclared", undeclaredHosts: ["tracker.test"], notInspected: ["WebRTC"],
  issuedAt: Math.floor(Date.now() / 1000) - 3600, expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
}, VERIFIER_KEY));
const LABELLED = `http://labelled.test:${P}/`;
labelRecord = JSON.stringify(await signVerdict({
  name: "labelled-test.labels.canary.eth", origin: new URL(LABELLED).origin, verifier: "verifier.canary.eth", buildHash: "5256f32b3c52", scannerHash: "296015c80bdd",
  flows: ["load", "connect: clicked", "scroll"], result: "incomplete", undeclaredHosts: [], addressRecipients: [{ host: "tracker.test", kind: "analytics" }], notInspected: ["WebRTC"],
  issuedAt: Math.floor(Date.now() / 1000) - 3600, expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
}, VERIFIER_KEY));

/* --- extension ------------------------------------------------------------ */

const extDir = await mkdtemp(resolve(tmpdir(), "canary-ext-"));
await buildExtension({
  network: { id: "passthrough", label: "passthrough (test)", specifier: "0x4fd77be300f31c5fe6ab266d35d27750a3478d27", bootstrapRpc: `http://chain.test:${P}/` },
  readEndpoints: { "11155111": `http://read.canary.test:${P}/` },
  timeoutMs: 8000,
  matches: ["http://*/*"],
  hostPermissions: ["http://*/*"],
}, extDir);

async function launch(withCanary) {
  const profile = await mkdtemp(resolve(tmpdir(), "canary-prof-"));
  const args = ["--no-sandbox", "--no-proxy-server", `--host-resolver-rules=MAP *.test 127.0.0.1`];
  if (withCanary) args.push(`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`);
  const ctx = await chromium.launchPersistentContext(profile, { headless: true, executablePath: CHROME, args, viewport: { width: 900, height: 700 } });
  let sw;
  if (withCanary) sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 30000 }));
  return { ctx, sw, close: async () => (await ctx.close(), await rm(profile, { recursive: true, force: true })) };
}
async function runPage(ctx, opts) {
  const page = await ctx.newPage();
  await page.goto(DAPP);
  const result = await page.evaluate((o) => window.runDapp(o), opts ?? {});
  return { page, result };
}
const tabStateOf = (sw, site = "leakydash") =>
  sw.evaluate(async (site) => {
    await new Promise((r) => setTimeout(r, 400)); // coverage is persisted with a 150 ms debounce
    const all = await chrome.storage.session.get(null);
    const [k, v] = Object.entries(all).find(([k, v]) => k.startsWith("tab:") && v.origin.includes(site)) ?? [];
    return k ? { tabId: Number(k.slice(4)), ...v } : null;
  }, site);
const noticeOf = (page) => page.locator("[data-canary-notice] .box").innerText({ timeout: 15000 }).catch(() => "");

// Send a message to the service worker the way the popup does.
async function ext(b, msg) {
  const id = await b.sw.evaluate(() => chrome.runtime.id);
  const p = await b.ctx.newPage();
  await p.goto(`chrome-extension://${id}/popup.html?tabId=-1`);
  const r = await p.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  await p.close();
  return r;
}
const leaked = (entries) => entries.filter((e) => { const s = (e.path ?? "") + (e.body ?? ""); return s.toLowerCase().includes(ADDR_HEX) || s.includes(ADDR_B64); });
const reads = (log) => log.filter((l) => ["eth_blockNumber", "eth_getBalance", "eth_call"].includes(l.method));

const checks = [];
const check = (name, ok, detail) => { checks.push([name, !!ok]); console.log(`  ${ok ? "✓" : "✗"} ${name}${!ok && detail !== undefined ? `\n      ${JSON.stringify(detail).slice(0, 400)}` : ""}`); };

/* --- 1. baseline ----------------------------------------------------------- */
console.log("\n1. Baseline: no extension");
{
  reset();
  const b = await launch(false);
  const { result } = await runPage(b.ctx);
  await b.close();
  console.log("   dapp:", JSON.stringify(result));
  check("provider received reads from the page's origin", reads(logs.provider).some((l) => l.origin.includes("leakydash")));
  check("WebSocket provider received reads", reads(logs.ws).length > 0);
  check("tracker received the address (fetch, base64, beacon, XHR, pixel)", leaked(logs.tracker).length >= 5, logs.tracker.map((e) => e.path));
}

/* --- 2. with Canary ------------------------------------------------------- */
console.log("\n2. With Canary");
const c = await launch(true);
let tab;
{
  reset();
  const { page, result } = await runPage(c.ctx);
  // The connect moment: the site's privacy label, on the page (it auto-hides after 12 s, so read it first).
  const notice = await noticeOf(page);
  await mkdir(resolve(HERE, "out"), { recursive: true });
  await page.screenshot({ path: resolve(HERE, "out/notice.png") });
  await page.waitForTimeout(500);
  tab = await tabStateOf(c.sw);
  console.log("   dapp:", JSON.stringify(result));
  console.log("   counts:", JSON.stringify(tab?.counts), "notes:", JSON.stringify(tab?.notes));
  console.log("   provider got:", logs.provider.map((l) => `${l.method}@${l.origin}`).join(", ") || "(nothing)");
  console.log("   tracker got:", logs.tracker.map((e) => e.path).join(", ") || "(nothing)");

  check("dapp works: reads answered by the read endpoint (546 / 2)", result.blockNumber === "546" && result.balance === "2" && JSON.stringify(result.batch) === '["546","2"]', result);
  check("eth_call substituted", result.call === "0x" + word(2), result.call);
  check("XHR JSON-RPC substituted", result.xhrBalance === "0x2", result.xhrBalance);
  check("WebSocket JSON-RPC substituted (socket carried no reads)", result.wsBlockNumber === "546" && reads(logs.ws).length === 0, { ws: result.wsBlockNumber, log: logs.ws });
  check("provider saw no read methods", reads(logs.provider).length === 0, logs.provider);
  check("nothing reached the provider from the page's origin", !logs.provider.some((l) => l.origin.includes("leakydash")), logs.provider);
  check("non-standard method forwarded over anon path (IP only)", JSON.stringify(result.custom) === '{"from":"provider"}' && logs.provider.some((l) => l.method === "alchemy_getTokenBalances" && l.origin === "null"));
  check("Tor-hostile provider: read still answered (chain from wallet, labelled)", result.hostileBalance === "2" && tab?.notes.some((n) => n.includes("assumed from the wallet")), { r: result.hostileBalance, notes: tab?.notes });
  check("tracker received NO request carrying the address", leaked(logs.tracker).length === 0, leaked(logs.tracker));
  check("tracker's clean pageview still went through", logs.tracker.some((e) => e.path === "/event"));
  check("leaks blocked: fetch, base64 fetch, XHR, pixel all failed for the page", String(result.trackerFetch).startsWith("failed") && String(result.trackerBase64).startsWith("failed") && result.trackerXhr === 0 && result.trackerPixel === "error", result);
  check("first-party /api/points allowed and reported as detected", logs.points.length === 1 && tab?.recipients["leakydash.test"]?.categories.detected >= 1);
  check("indexer traffic allowed and reported as backend", logs.indexer.length === 1 && tab?.recipients["indexer.test"]?.categories.backend >= 1);
  check("coverage counts: blocked ≥ 5, protected ≥ 8, failedClosed 0", tab?.counts.blocked >= 5 && tab?.counts.protected >= 8 && tab?.counts.failedClosed === 0, tab?.counts);
  check("wallet address learned via EIP-1193/6963", (await c.sw.evaluate(() => chrome.storage.local.get("walletAddresses"))).walletAddresses?.includes(ADDR));
  check("eth_chainId answered from Canary's cache: the read endpoint was never asked", result.chainId === 11155111 && !logs.read.some((l) => l.method === "eth_chainId") && tab?.noRequest >= 1, { read: logs.read.map((l) => l.method), noRequest: tab?.noRequest });
  const st = await ext(c, { type: "state", tabId: tab.tabId });
  check("pipeline sent fewer anon-rpc requests than it answered calls", st.pipeline.requests < st.pipeline.calls, st.pipeline);

  // Declared vs observed: the site names leakydash.eth, whose manifest leaves the tracker out.
  for (let i = 0; i < 50 && (!tab?.declared || tab.declared.state === "pending"); i++) tab = await tabStateOf(c.sw);
  check("manifest read from ENS (site ↔ name bound both ways)", tab?.declared?.state === "ok" && tab.declared.ens === "leakydash.eth", tab?.declared);
  check("ENS lookups went over the anon path to the read endpoint", logs.read.some((l) => l.method === "eth_call" && l.origin === "null" && l.body.toLowerCase().includes(UR.slice(2))));
  const cmp = tab?.declared?.manifest ? compareDeclared(tab.declared.manifest, Object.values(tab.recipients)) : { rows: [] };
  const status = Object.fromEntries(cmp.rows.map((r) => [r.host, r.status]));
  const vc = tab?.declared?.verdict;
  check("verifier's verdict: signed by the verifier name's addr, role still delegated", vc?.signed && vc.signerIsVerifier && vc.delegated === true && vc.matchesSite && !vc.expired && vc.verdict.result === "undeclared", vc);
  check("connect notice on the page: the site's label, and what the verifier found beyond it", notice.includes("The site says 3 third parties get your address") && notice.includes("rpc.provider.test") && notice.includes("more: tracker.test") && notice.includes("Protection is on"), notice);
  check("the page learned the address: connect time recorded", tab?.connectedAt > 0, tab?.connectedAt);
  check("tracker is an undeclared recipient; provider and indexer are declared", status["tracker.test"] === "undeclared" && status["rpc.provider.test"] === "declared" && status["cdn.leakydash-assets.test"] === "notSeen" && !("leakydash.test" in status), status);

  // popup screenshot
  const id = await c.sw.evaluate(() => chrome.runtime.id);
  const pop = await c.ctx.newPage();
  await pop.setViewportSize({ width: 400, height: 900 });
  await pop.goto(`chrome-extension://${id}/popup.html?tabId=${tab.tabId}`);
  await pop.waitForTimeout(1200);
  check("popup shows the privacy label", (await pop.locator("#label").innerText()).includes("The site says 3 third parties get your address"), await pop.locator("#label").innerText());
  check("popup headline: reads go through anon-rpc", (await pop.locator("#headline").innerText()).includes("going through anon-rpc"), await pop.locator("#headline").innerText());
  const summary = await pop.locator("#summary").innerText();
  await pop.locator("#summary").screenshot({ path: resolve(HERE, "out/popup-summary.png") }).catch(() => {});
  check("popup summary: reads via anon-rpc, the blocked tracker, the manifest, coverage", /Reads via anon-rpc\s+\d+/.test(summary) && /Third-party leaks blocked\s+[1-9]/.test(summary) && /On ENS\s+[1-9] undeclared/.test(summary) && /Coverage\s+\d+ % protected or blocked/.test(summary), summary);
  await pop.screenshot({ path: resolve(HERE, "out/popup.png") });
  check("events recorded: a blocked request to tracker.test", tab?.events?.some((e) => e.category === "blocked" && e.host === "tracker.test"), tab?.events?.length);
  const prot = tab?.events?.find((e) => e.category === "protected" && e.via);
  check("receipts recorded: the tracker request around your address; reads with the call and where it went", tab?.events?.some((e) => e.category === "blocked" && e.host === "tracker.test" && e.snippet) && prot?.via === "read.canary.test" && /^eth_\w+\(/.test(prot?.sample ?? ""), prot);
  await pop.getByRole("tab", { name: "Activity" }).click();
  await pop.waitForTimeout(300);
  check("popup Activity lists the blocked tracker request", (await pop.locator("body").innerText()).includes("tracker.test"));
  await pop.getByRole("button", { name: /tracker\.test/ }).filter({ hasText: "Blocked" }).first().click();
  await pop.waitForTimeout(300);
  const shown = pop.locator("[data-receipt]:visible").first();
  const receipt = await shown.innerText().catch(() => "");
  await shown.screenshot({ path: resolve(HERE, "out/popup-receipt.png") }).catch(() => {});
  check("receipt: what the tracker would have seen, and that it got nothing", receipt.includes("Without Canary") && receipt.includes("Nothing: it never left your browser") && (receipt.toLowerCase().includes(ADDR_HEX) || receipt.includes(ADDR_B64)), receipt);
  await pop.screenshot({ path: resolve(HERE, "out/popup-activity.png") });
  await pop.getByRole("tab", { name: "Manifest" }).click();
  await pop.waitForTimeout(300);
  check("popup shows the verdict", (await pop.locator("#declared").innerText()).includes("Signed verdict by verifier.canary.eth: Found undeclared recipients: tracker.test"), await pop.locator("#declared").innerText());
  check("popup lists the undeclared tracker", /tracker\.test[\s\S]*Undeclared recipient/.test(await pop.locator("#declaredRows").innerText()), await pop.locator("#declaredRows").innerText());
  await pop.screenshot({ path: resolve(HERE, "out/popup-manifest.png") });
  await pop.close();
  const dash = await c.ctx.newPage();
  await dash.setViewportSize({ width: 1280, height: 900 });
  await dash.goto(`chrome-extension://${id}/dashboard.html?tabId=${tab.tabId}#manifest`);
  await dash.waitForTimeout(1200);
  check("dashboard manifest page flags tracker.test as undeclared", /not in the manifest[\s\S]*tracker\.test/.test(await dash.locator("main").innerText()));
  await dash.screenshot({ path: resolve(HERE, "out/dashboard-manifest.png"), fullPage: true });
  await dash.goto(`chrome-extension://${id}/dashboard.html?tabId=${tab.tabId}#overview`);
  await dash.waitForTimeout(1200);
  check("dashboard overview shows the coverage count", /\d+ of \d+\s*observed requests protected or blocked/.test(await dash.locator("main").innerText()));
  await dash.screenshot({ path: resolve(HERE, "out/dashboard.png"), fullPage: true });
  await dash.close();
  await page.close();
}

/* --- 3. read endpoint down → fail closed --------------------------------- */
console.log("\n3. Anon path down (read endpoint 503) → fail closed");
{
  reset();
  readDown = true;
  const { page, result } = await runPage(c.ctx, { leaks: false });
  const t = await tabStateOf(c.sw);
  console.log("   dapp:", JSON.stringify(result));
  check("connect notice not repeated for a site this browser session", (await page.locator("[data-canary-notice]").count()) === 0);
  check("reads failed with an error instead of going direct", String(result.balance).startsWith("ERR") && reads(logs.provider).length === 0, { result, provider: logs.provider });
  check("counted as failed closed", t?.counts.failedClosed > 0, t?.counts);
  await page.close();
}

/* --- 4. allow direct ------------------------------------------------------ */
console.log("\n4. Same, with \"allow direct\" on for this site");
{
  reset();
  await ext(c, { type: "setSite", origin: new URL(DAPP).origin, patch: { allowDirect: true } });
  const { page, result } = await runPage(c.ctx, { leaks: false });
  const t = await tabStateOf(c.sw);
  check("reads went directly to the provider (user's choice) and the dapp works", result.balance === "1" && reads(logs.provider).some((l) => l.origin.includes("leakydash")), { result, provider: logs.provider.length });
  // Only calls Canary answered from its own cache (e.g. the read endpoint's chain id) may count as protected here.
  check("counted as direct, not protected", t?.counts.direct > 0 && t?.counts.protected <= (t?.noRequest ?? 0), { counts: t?.counts, noRequest: t?.noRequest });
  readDown = false;
  await page.close();
}

/* --- 5. protection off ---------------------------------------------------- */
console.log("\n5. Protection off for this site");
{
  reset();
  await ext(c, { type: "setSite", origin: new URL(DAPP).origin, patch: { enabled: false, allowDirect: false } });
  const { page, result } = await runPage(c.ctx);
  check("everything behaves like baseline (reads to provider, tracker gets the address)", result.balance === "1" && reads(logs.provider).length > 0 && leaked(logs.tracker.filter((e) => !e.path.startsWith("/pixel"))).length >= 4, { result, tracker: logs.tracker.map((e) => e.path) });
  check("DNR pixel rule exempts the disabled site", result.trackerPixel === "loaded", result.trackerPixel);
  await page.close();
}

/* --- 6. undeclared recipient blocked ------------------------------------- */
console.log("\n6. \"Block undeclared recipients\" on this site");
{
  reset();
  await ext(c, { type: "setSite", origin: new URL(DAPP).origin, patch: { enabled: true } });
  await ext(c, { type: "blockHosts", origin: new URL(DAPP).origin, hosts: ["tracker.test"] });
  const { page, result } = await runPage(c.ctx);
  const t = await tabStateOf(c.sw);
  check("tracker received nothing at all, not even the clean pageview", logs.tracker.length === 0, logs.tracker.map((e) => e.path));
  check("the dapp still works", result.balance === "2", result);
  check("blocked as undeclared, and said so", t?.events?.some((e) => e.host === "tracker.test" && e.category === "blocked" && e.note?.includes("manifest")), t?.events?.filter((e) => e.host === "tracker.test"));
  await page.close();
  const ov = await ext(c, { type: "overview" });
  check("earlier page loads kept in history", ov.history.filter((h) => h.origin.includes("leakydash")).length >= 3, ov.history.length);
  await ext(c, { type: "unblockHost", origin: new URL(DAPP).origin, host: "tracker.test" });
}

/* --- 7. Canary's label ---------------------------------------------------- */
console.log("\n7. A site with no manifest of its own: Canary's label on ENS");
{
  reset();
  const page = await c.ctx.newPage();
  await page.goto(LABELLED);
  const notice = await noticeOf(page);
  await page.screenshot({ path: resolve(HERE, "out/notice-label.png") });
  check("connect notice shows Canary's label", notice.includes("1 third party got your address in Canary's scan") && notice.includes("tracker.test") && notice.includes("signed by verifier.canary.eth"), notice);
  let t;
  for (let i = 0; i < 50 && (!t?.declared || t.declared.state === "pending"); i++) t = await tabStateOf(c.sw, "labelled");
  const lv = t?.declared?.label?.verdict;
  check("no well-known file: label read from labelled-test.labels.canary.eth, signed, delegated, bound to the site", t?.declared?.state === "none" && t.declared.label?.ens === "labelled-test.labels.canary.eth" && lv?.signed && lv.signerIsVerifier && lv.delegated === true && lv.matchesSite && !lv.expired, t?.declared);
  const id = await c.sw.evaluate(() => chrome.runtime.id);
  const pop = await c.ctx.newPage();
  await pop.setViewportSize({ width: 400, height: 900 });
  await pop.goto(`chrome-extension://${id}/popup.html?tabId=${t.tabId}`);
  await pop.waitForTimeout(1200);
  check("popup shows Canary's label, and badges it", (await pop.locator("#label").innerText()).includes("1 third party got your address") && (await pop.locator("header").innerText()).includes("Label: 1 third party"), await pop.locator("header").innerText());
  await pop.screenshot({ path: resolve(HERE, "out/popup-label.png") });
  await pop.close();
  await page.close();
}

await c.close();
await rm(extDir, { recursive: true, force: true });
server.close();
const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
