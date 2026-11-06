// A new address must not reach a third party in a URL (pixel, image, script, frame) before
// Canary's rule for it exists. The page only learns it once the rule is confirmed, on connect
// and on an account switch, whatever kind of wallet object the page has:
//
//   emitter  an EventEmitter-like class whose events go through its emit(); the page adds its
//            listener in the same script that installs the wallet, before Canary can hook it
//   frozen   the same, with the wallet object frozen
//   custom   no emit(): the wallet calls its listeners itself; the page listens in a later script
//
// Each case connects, then switches to an account nobody has seen. The tracker's own log says
// whether a pixel with the address arrived. Also checks: without Canary the pixels do arrive;
// a switch away and back ends on the right account; removed listeners stay removed.
//
//   CHROME_BIN=/path/to/chromium node test/wallet-hold.mjs

import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { buildExtension } from "../build.mjs";

const CHROME = process.env.CHROME_BIN;
const HARD_LIMIT = setTimeout(() => (console.log("FAIL: hard limit of 4 minutes"), process.exit(3)), 4 * 60_000);
const fresh = () => `0x${randomBytes(20).toString("hex")}`; // an address no one has seen

/* --- the dapp and its tracker -------------------------------------------- */

// The wallet, as the page sees it. Its state lives in `s` so that freezing the object leaves it working.
const WALLET = `
class Emitter {
  constructor() { this._ev = {}; }
  on(e, f) { (this._ev[e] = this._ev[e] || []).push(f); return this; }
  addListener(e, f) { return this.on(e, f); }
  once(e, f) { const w = (...a) => { this.removeListener(e, w); f.apply(this, a); }; w.listener = f; return this.on(e, w); }
  removeListener(e, f) { const l = this._ev[e] || []; const i = l.findIndex((x) => x === f || x.listener === f); if (i >= 0) l.splice(i, 1); return this; }
  off(e, f) { return this.removeListener(e, f); }
  emit(e, ...a) { const l = (this._ev[e] || []).slice(); for (const f of l) f.apply(this, a); return l.length > 0; }
}
class Wallet extends Emitter {
  constructor(account) { super(); this.s = { account, ok: false }; }
  async request({ method }) {
    if (method === "eth_requestAccounts") { await new Promise((r) => setTimeout(r, 50)); this.s.ok = true; return [this.s.account]; }
    if (method === "eth_accounts") return this.s.ok ? [this.s.account] : [];
    if (method === "eth_chainId") return "0xaa36a7";
    throw Object.assign(new Error("unsupported"), { code: -32601 });
  }
  switchTo(a) { this.s.account = a; this.emit("accountsChanged", [a]); }
}
function customWallet(account) {
  const ls = [];
  const s = { account, ok: false };
  return {
    async request({ method }) {
      if (method === "eth_requestAccounts") { await new Promise((r) => setTimeout(r, 50)); s.ok = true; return [s.account]; }
      if (method === "eth_accounts") return s.ok ? [s.account] : [];
      if (method === "eth_chainId") return "0xaa36a7";
      throw Object.assign(new Error("unsupported"), { code: -32601 });
    },
    on(e, f) { if (e === "accountsChanged") ls.push(f); return this; },
    removeListener(e, f) { const i = ls.indexOf(f); if (i >= 0) ls.splice(i, 1); return this; },
    switchTo(a) { s.account = a; for (const f of ls.slice()) f([a]); },
  };
}`;

// What the dapp does with an address: tell the tracker, in an image URL.
const DAPP = (tracker) => `
window.__shown = [];
window.__pixel = (a) => { new Image().src = "${tracker}/p.gif?uid=" + a; };
window.__onAccounts = (accs) => { window.__shown.push(accs[0]); window.__pixel(accs[0]); };
window.__connect = async () => { const [a] = await window.ethereum.request({ method: "eth_requestAccounts" }); window.__pixel(a); return a; };`;

function page(kind, account, tracker) {
  const install = {
    emitter: `window.ethereum = new Wallet("${account}");`,
    frozen: `window.ethereum = Object.freeze(new Wallet("${account}"));`,
    custom: `window.ethereum = customWallet("${account}");`,
  }[kind];
  // emitter/frozen: wallet and listener in one script, so nothing can run in between.
  // custom: the page listens in its own, later script.
  const listen = `window.ethereum.on("accountsChanged", window.__onAccounts);`;
  const scripts = kind === "custom" ? [`${WALLET}\n${install}`, `${DAPP(tracker)}\n${listen}`] : [`${WALLET}\n${install}\n${DAPP(tracker)}\n${listen}`];
  return `<!doctype html><html><head><meta charset="utf-8">${scripts.map((s) => `<script>${s}</script>`).join("")}</head><body>wallet hold</body></html>`;
}

const received = []; // uids the tracker got
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.hostname === "pixel.test") {
    if (url.searchParams.get("uid")) received.push(url.searchParams.get("uid").toLowerCase());
    return res.writeHead(200, { "content-type": "image/gif" }).end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
  }
  if (url.hostname === "dapp.test") return res.writeHead(200, { "content-type": "text/html" }).end(page(url.searchParams.get("kind"), url.searchParams.get("a"), `http://pixel.test:${P}`));
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const P = server.address().port;

/* --- the extension ------------------------------------------------------- */

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
  const args = ["--no-sandbox", "--no-proxy-server", "--host-resolver-rules=MAP *.test 127.0.0.1"];
  if (withCanary) args.push(`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`);
  const ctx = await chromium.launchPersistentContext(profile, { headless: true, executablePath: CHROME, args });
  if (withCanary) ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 30000 }));
  return { ctx, close: async () => (await ctx.close(), await rm(profile, { recursive: true, force: true })) };
}

let failed = 0;
const check = (what, ok, got) => {
  console.log(`  ${ok ? "✓" : "✗"} ${what}${ok ? "" : `: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};
const leaked = (a) => received.includes(a);

/** Opens the dapp with a fresh account, connects, switches to another fresh account. */
async function run(ctx, kind, extra) {
  const a1 = fresh();
  const a2 = fresh();
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`http://dapp.test:${P}/?kind=${kind}&a=${a1}`);
  const connected = await p.evaluate(() => window.__connect());
  await p.evaluate((a) => window.ethereum.switchTo(a), a2);
  await p.waitForFunction((a) => window.__shown.includes(a), a2, { timeout: 5000 }).catch(() => errors.push("the page never heard of the switch"));
  const more = extra ? await extra(p, a1) : undefined;
  await p.waitForTimeout(800); // pixels that were going to leave have arrived
  await p.close();
  return { a1, a2, connected, errors, more };
}

/* --- runs ---------------------------------------------------------------- */

console.log("without Canary (the harness leaks as a dapp would)");
{
  const b = await launch(false);
  const r = await run(b.ctx, "emitter");
  check("connect pixel reached the tracker", leaked(r.a1), received);
  check("switch pixel reached the tracker", leaked(r.a2), received);
  await b.close();
}

console.log("with Canary");
const b = await launch(true);
for (const kind of ["emitter", "frozen", "custom"]) {
  const r = await run(b.ctx, kind);
  check(`${kind}: connect returned the account`, r.connected === r.a1, r.connected);
  check(`${kind}: no pixel with the connected address`, !leaked(r.a1), r.a1);
  check(`${kind}: no pixel with the switched-to address`, !leaked(r.a2), r.a2);
  check(`${kind}: no page errors`, r.errors.length === 0, r.errors);
}

// A switch to a new account and straight back: held events keep their order.
{
  const r = await run(b.ctx, "emitter", async (p, a1) => {
    const a3 = fresh();
    await p.evaluate(([x, y]) => (window.ethereum.switchTo(x), window.ethereum.switchTo(y)), [a3, a1]);
    await p.waitForTimeout(1000);
    return { a3, shown: await p.evaluate(() => window.__shown.slice(-2)) };
  });
  check("away and back: the page ends on the account switched to last", r.more.shown.join() === [r.more.a3, r.a1].join(), r.more.shown);
  check("away and back: no pixel with the new address", !leaked(r.more.a3), r.more.a3);
}

// Listeners added after Canary hooked the wallet (once / on), then removed, stay removed.
{
  const r = await run(b.ctx, "emitter", async (p) => {
    const a4 = fresh();
    const calls = await p.evaluate(async (a) => {
      const hits = { once: 0, on: 0, kept: 0 };
      const f = () => hits.once++;
      const g = () => hits.on++;
      window.ethereum.once("accountsChanged", f);
      window.ethereum.removeListener("accountsChanged", f);
      window.ethereum.on("accountsChanged", g);
      window.ethereum.off("accountsChanged", g);
      window.ethereum.once("accountsChanged", () => hits.kept++);
      window.ethereum.switchTo(a);
      await new Promise((r) => setTimeout(r, 800));
      window.ethereum.switchTo(a);
      await new Promise((r) => setTimeout(r, 300));
      return hits;
    }, a4);
    return calls;
  });
  check("removed listeners stay removed; a once() listener fires once", r.more.once === 0 && r.more.on === 0 && r.more.kept === 1, r.more);
}
await b.close();

server.close();
await rm(extDir, { recursive: true, force: true });
clearTimeout(HARD_LIMIT);
console.log(failed ? `\n${failed} checks failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
