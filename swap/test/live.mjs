#!/usr/bin/env node
/* Live end-to-end run of Canary Swap on Sepolia: a real Chromium, the built
   page, and a test wallet that signs in Node with a key from a file (the
   stand-in for MetaMask: it broadcasts through its own RPC, as a wallet does).

   It quotes, connects, swaps ETH → CNRY, mints CNRY, swaps CNRY → ETH (Permit2
   approvals the first time), and checks every receipt on chain. With
   --canary <dist> the Canary extension is loaded as well, and the run checks
   that the page's reads were answered through anon-rpc.

     npm run build && npm start                       # terminal 1
     node test/live.mjs --key-file ../swap-test.key [--canary ../extension/dist-local] [--out <dir>]

   The key file holds a Sepolia test key (fund it with a little Sepolia ETH);
   it is never printed. Not part of `npm test`: it spends test ETH. */

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { createPublicClient, createWalletClient, formatEther, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { ABI, V4 } from "../src/v4.js";

const { values: opt } = parseArgs({
  options: {
    "key-file": { type: "string" },
    canary: { type: "string" },
    url: { type: "string", default: "http://localhost:3300/" },
    rpc: { type: "string", default: "https://ethereum-sepolia-rpc.publicnode.com" },
    chrome: { type: "string", default: process.env.CHROME_BIN },
    out: { type: "string" },
  },
});
if (!opt["key-file"]) throw new Error("--key-file <file> is required");
const HARD_LIMIT = setTimeout(() => (console.log("FAIL: hard limit of 8 minutes"), process.exit(3)), 8 * 60_000);

const readKey = (file) => {
  const line = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const hex = line.slice(line.lastIndexOf("=") + 1).trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${file}: no private key found`);
  return hex.startsWith("0x") ? hex : `0x${hex}`;
};

const account = privateKeyToAccount(readKey(opt["key-file"]));
const transport = http(opt.rpc);
const client = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ chain: sepolia, transport, account });
const deployed = JSON.parse(await readFile(new URL("../sepolia.json", import.meta.url), "utf8"));
const CNRY = deployed.token.address;

const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${s}`);
const result = { url: opt.url, withCanary: !!opt.canary, wallet: account.address, at: new Date().toISOString(), steps: [], txs: [], errors: [] };
const fail = (why) => {
  result.errors.push(why);
  log(`FAIL: ${why}`);
};

/* --- the browser and the test wallet -------------------------------------- */

const profile = await mkdtemp(resolve(tmpdir(), "canary-swap-"));
const args = opt.canary ? [`--disable-extensions-except=${resolve(opt.canary)}`, `--load-extension=${resolve(opt.canary)}`] : [];
const ctx = await chromium.launchPersistentContext(profile, { headless: true, executablePath: opt.chrome, args, viewport: { width: 1280, height: 1000 } });
const sw = opt.canary ? (ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 30000 }))) : null;

// EIP-1193 + EIP-6963 in the page; requests go to the Node side below.
await ctx.addInitScript(() => {
  const listeners = {};
  const provider = {
    isCanarySwapTest: true,
    request: ({ method, params }) =>
      window.__swapTestWallet(method, params ?? []).then((r) => {
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return r.result;
      }),
    on(e, f) { (listeners[e] = listeners[e] || []).push(f); return provider; },
    removeListener(e, f) { listeners[e] = (listeners[e] || []).filter((x) => x !== f); return provider; },
  };
  const info = Object.freeze({ uuid: "0b1d6c3e-7a51-4f0e-9d7a-5a9c2b7e1c11", name: "Canary Swap test wallet", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/%3E", rdns: "xyz.canary.swaptest" });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  window.ethereum = provider;
});
await ctx.exposeFunction("__swapTestWallet", async (method, params) => {
  try {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return { result: [account.address] };
      case "eth_chainId":
        return { result: `0x${sepolia.id.toString(16)}` };
      case "wallet_switchEthereumChain":
        return { result: null };
      case "eth_sendTransaction": {
        const [tx] = params;
        const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0) });
        result.txs.push({ hash, to: tx.to, selector: tx.data?.slice(0, 10) });
        return { result: hash };
      }
      default: {
        const r = await fetch(opt.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        return await r.json();
      }
    }
  } catch (e) {
    return { error: { code: e.code ?? -32603, message: e.shortMessage ?? e.message } };
  }
});

const page = await ctx.newPage();
page.on("pageerror", (e) => fail(`pageerror: ${e.message}`));
const text = (sel) => page.locator(sel).innerText({ timeout: 5000 }).catch(() => "");
const waitText = (sel, re, timeout) => page.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent ?? ""), [sel, re.source], { timeout });

async function quote(amount) {
  await page.fill("#amountIn", "");
  await page.waitForFunction(() => document.getElementById("details").hidden, null, { timeout: 5000 });
  await page.fill("#amountIn", amount);
  await page.waitForFunction(() => !document.getElementById("details").hidden && document.getElementById("amountOut").textContent !== "…", null, { timeout: 60000 });
  return { out: await text("#amountOut"), details: (await text("#details")).replace(/\n/g, " "), sent: (await text("#sentList")).split("\n").filter(Boolean), addr: await text("#sentAddr") };
}
async function swap(label) {
  await page.click("#swap");
  await waitText("#status", /^(Swapped|Not swapped)/, 240000);
  const s = await text("#status");
  const href = await page.locator("#status a").getAttribute("href").catch(() => null);
  log(`${label}: ${s}`);
  if (!s.startsWith("Swapped")) fail(`${label}: ${s}`);
  return { status: s, tx: href?.split("/tx/")[1] };
}
const balances = async () => {
  const [eth, cnry] = await Promise.all([client.getBalance({ address: account.address }), client.readContract({ address: CNRY, abi: ABI.erc20, functionName: "balanceOf", args: [account.address] })]);
  return { ETH: formatEther(eth), CNRY: formatUnits(cnry, 18) };
};

/* --- the run --------------------------------------------------------------- */

try {
  result.before = await balances();
  log(`wallet ${account.address}: ${result.before.ETH} ETH, ${result.before.CNRY} CNRY`);
  await page.goto(opt.url);

  const q0 = await quote("0.0001");
  log(`quote before connecting: 0.0001 ETH → ${q0.out} CNRY · ${q0.sent.length} requests`);
  result.steps.push({ step: "quote, not connected", ...q0 });

  await page.click("#connect");
  await waitText("#connect", /^0x/, 15000);
  const q1 = await quote("0.0001");
  log(`quote connected: ${q1.out} CNRY · ${q1.addr}`);
  if (!/in none of them/.test(q1.addr)) fail(`the quote requests carried the address: ${q1.addr}`);
  result.steps.push({ step: "quote, connected", ...q1 });

  result.steps.push({ step: "swap ETH → CNRY", ...(await swap("swap 0.0001 ETH → CNRY")) });

  await page.click("#mint");
  await waitText("#status", /(minted|Not minted)/, 180000);
  log(`mint: ${await text("#status")}`);
  result.steps.push({ step: "mint CNRY", status: await text("#status") });

  await page.click("#flip");
  const q2 = await quote("5");
  log(`quote 5 CNRY → ${q2.out} ETH`);
  result.steps.push({ step: "quote, CNRY → ETH", ...q2 });
  result.steps.push({ step: "swap CNRY → ETH", ...(await swap("swap 5 CNRY → ETH")) });

  // Every transaction the page asked the wallet to send, checked on chain.
  for (const t of result.txs) {
    const r = await client.waitForTransactionReceipt({ hash: t.hash });
    t.status = r.status;
    t.gasUsed = String(r.gasUsed);
    t.what = { "0x3593564c": "Universal Router: execute (V4_SWAP)", "0x87517c45": "Permit2: approve the Universal Router", "0x095ea7b3": "CNRY: approve Permit2", "0x40c10f19": "CNRY: mint" }[t.selector] ?? `${t.to} ${t.selector}`;
    log(`  ${t.what} ${t.hash} ${r.status}`);
    if (r.status !== "success") fail(`${t.hash} ${r.status}`);
  }
  result.after = await balances();
  log(`wallet after: ${result.after.ETH} ETH, ${result.after.CNRY} CNRY`);

  if (sw) {
    const [key, tab] = await sw.evaluate(async (origin) => {
      await new Promise((r) => setTimeout(r, 400));
      const all = await chrome.storage.session.get(null);
      return Object.entries(all).find(([k, v]) => k.startsWith("tab:") && v.origin === origin) ?? [null, null];
    }, new URL(opt.url).origin);
    const events = tab?.events ?? [];
    const by = {};
    for (const e of events) by[e.category] = (by[e.category] ?? 0) + 1;
    const reads = events.filter((e) => e.channel !== "wallet" && e.methods?.length);
    result.canary = { counts: tab?.counts, byCategory: by, readsVia: [...new Set(reads.map((e) => e.via).filter(Boolean))], hosts: [...new Set(events.map((e) => e.host))], notProtected: reads.filter((e) => e.category !== "protected").map((e) => ({ host: e.host, category: e.category, methods: e.methods, note: e.note })) };
    log(`canary: ${JSON.stringify(by)} · reads via ${result.canary.readsVia.join(", ")}`);
    // The popup for this tab, as the user would open it.
    const pop = await ctx.newPage();
    await pop.setViewportSize({ width: 400, height: 900 });
    await pop.goto(`chrome-extension://${await sw.evaluate(() => chrome.runtime.id)}/popup.html?tabId=${key?.slice(4)}`);
    await pop.waitForTimeout(2000);
    const inner = (sel) => pop.locator(sel).innerText({ timeout: 5000 }).catch(() => "");
    result.canary.popup = { origin: await inner("#origin"), badge: (await inner("header")).split("\n").pop(), headline: await inner("#headline"), summary: (await inner("#summary")).split("\n") };
    if (opt.out) await pop.screenshot({ path: `${opt.out}/popup-canary.png` }).catch(() => {});
    log(`popup: ${result.canary.popup.badge} · ${result.canary.popup.summary.join(" | ")}`);
    if (!reads.length) fail("Canary recorded no reads");
    if (result.canary.notProtected.length) fail(`reads not answered through anon-rpc: ${JSON.stringify(result.canary.notProtected)}`);
  }
} catch (e) {
  fail(e.message.split("\n")[0]);
} finally {
  if (opt.out) {
    await mkdir(opt.out, { recursive: true });
    await page.screenshot({ path: `${opt.out}/swap${opt.canary ? "-canary" : ""}.png`, fullPage: true }).catch(() => {});
    await writeFile(`${opt.out}/live${opt.canary ? "-canary" : ""}.json`, JSON.stringify(result, null, 2) + "\n");
  }
  await ctx.close();
  await rm(profile, { recursive: true, force: true });
  clearTimeout(HARD_LIMIT);
}
console.log(result.errors.length ? `\n${result.errors.length} failure(s)` : `\nok: ${result.txs.length} transactions, all mined`);
process.exit(result.errors.length ? 1 : 0);
