#!/usr/bin/env node
/* Canary Swap's wallet handling, against simulated wallets: none, a legacy
   window.ethereum, one or several EIP-6963 wallets, and wallets that reject,
   hang, answer -32002, share no account, switch accounts, sit on another
   network, don't know Sepolia (4902, also wrapped in -32603 as MetaMask mobile
   does), refuse the switch, or answer eth_chainId with a number. Each wallet
   logs the calls it gets; nothing is signed or sent (sends are rejected).

     npm start                         # terminal 1 (or --url https://canary-swap.vercel.app/)
     node test/wallets.mjs [--url http://localhost:3300/] [--chrome <path>]

   The happy path with a real signing wallet is test/live.mjs. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values: opt } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:3300/" },
    chrome: { type: "string", default: process.env.CHROME_BIN },
  },
});
const HARD_LIMIT = setTimeout(() => (console.log("FAIL: hard limit of 6 minutes"), process.exit(3)), 6 * 60_000);

const A1 = "0x000000000000000000000000000000000000dEaD";
const A2 = "0xE9bb50BCfC7C97320903645D0eEBe79650593d19";
const SEPOLIA = "0xaa36a7";

/* The simulated wallets, installed in the page before it loads. `ws` is a list of
   { name, rdns, legacy?, eip6963?, chainId, knows: [chainIds], accounts, connect, switch, send, numericChainId?, noEvents? }. */
function install(ws) {
  const log = (window.__walletLog = []);
  const err = (code, message, data) => Object.assign(new Error(message), { code, data });
  window.__wallets = {};
  for (const w of ws) {
    const listeners = {};
    const key = `mock.connected.${w.rdns}`;
    const state = { chainId: w.chainId ?? SEPOLIA_, knows: new Set(w.knows ?? ["0x1", SEPOLIA_]), accounts: w.accounts };
    const emit = (e, v) => (listeners[e] || []).forEach((f) => f(v));
    const provider = {
      async request({ method, params }) {
        log.push(`${w.name}:${method}`);
        switch (method) {
          case "eth_requestAccounts":
            if (w.connect === "reject") throw err(4001, "User rejected the request.");
            if (w.connect === "pending") throw err(-32002, "Request of type 'wallet_requestPermissions' already pending");
            if (w.connect === "hang") return new Promise((ok) => (window.__wallets[w.name].release = () => (localStorage.setItem(key, "1"), ok(state.accounts))));
            if (w.connect === "empty") return [];
            localStorage.setItem(key, "1");
            return state.accounts;
          case "eth_accounts":
            return localStorage.getItem(key) ? state.accounts : [];
          case "eth_chainId":
            return w.numericChainId ? Number(state.chainId) : state.chainId;
          case "wallet_switchEthereumChain": {
            const want = params[0].chainId;
            if (w.switch === "reject") throw err(4001, "User rejected the request.");
            if (!state.knows.has(want)) {
              if (w.switch === "wrapped") throw err(-32603, "Unrecognized chain ID. Try adding the chain using wallet_addEthereumChain first.", { originalError: { code: 4902 } });
              throw err(4902, "Unrecognized chain ID.");
            }
            state.chainId = want;
            emit("chainChanged", want);
            return null;
          }
          case "wallet_addEthereumChain":
            state.knows.add(params[0].chainId);
            state.chainId = params[0].chainId;
            emit("chainChanged", state.chainId);
            return null;
          case "wallet_revokePermissions":
            localStorage.removeItem(key);
            return null;
          case "eth_sendTransaction":
            throw err(4001, "User denied transaction signature.");
          default:
            throw err(-32601, `${method} not supported by this test wallet`);
        }
      },
      on: w.noEvents ? undefined : (e, f) => ((listeners[e] = listeners[e] || []).push(f), provider),
      removeListener: (e, f) => ((listeners[e] = (listeners[e] || []).filter((x) => x !== f)), provider),
    };
    window.__wallets[w.name] = { emit, state, w };
    if (w.legacy) window.ethereum = provider;
    if (w.eip6963 !== false) {
      const info = Object.freeze({ uuid: crypto.randomUUID(), name: w.name, rdns: w.rdns, icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3Crect width='1' height='1' fill='%23e8831d'/%3E%3C/svg%3E" });
      const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    }
  }
}

const profile = await mkdtemp(resolve(tmpdir(), "swap-wallets-"));
const browser = await chromium.launch({ headless: true, executablePath: opt.chrome });
const results = [];
let failures = 0;

async function scenario(name, ws, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(`const SEPOLIA_ = "${SEPOLIA}"; (${install})(${JSON.stringify(ws)});`);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  const t = (sel) => page.locator(sel).innerText({ timeout: 5000 }).catch(() => "");
  const h = {
    page,
    t,
    status: () => t("#status"),
    button: () => t("#connect"),
    menu: async () => ((await page.locator("#wallets").isVisible()) ? (await t("#wallets")).split("\n").filter(Boolean) : null),
    calls: () => page.evaluate(() => window.__walletLog.slice()),
    waitStatus: (re) => page.waitForFunction((r) => new RegExp(r).test(document.getElementById("status").textContent), re.source, { timeout: 30000 }).catch(() => {}),
    waitButton: (re) => page.waitForFunction((r) => new RegExp(r).test(document.getElementById("connect").textContent), re.source, { timeout: 15000 }).catch(() => {}),
  };
  const checks = [];
  const expect = (what, ok, got) => checks.push({ what, ok: !!ok, got });
  try {
    await page.goto(opt.url);
    await page.waitForTimeout(500);
    await fn(h, expect);
  } catch (e) {
    expect("ran without throwing", false, e.message.split("\n")[0]);
  }
  expect("no page or console errors", errors.length === 0, errors);
  const ok = checks.every((c) => c.ok);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  for (const c of checks) if (!c.ok) console.log(`       ✗ ${c.what}: ${JSON.stringify(c.got)}`);
  results.push({ name, ok, checks });
  await ctx.close();
}

const mm = (over = {}) => ({ name: "MetaMask", rdns: "io.metamask", accounts: [A2], ...over });
const rabby = (over = {}) => ({ name: "Rabby Wallet", rdns: "io.rabby", accounts: [A1], ...over });

await scenario("no wallet: says so, quotes still work", [], async (h, expect) => {
  await h.page.click("#connect");
  expect("status says no wallet", /No wallet found/.test(await h.status()), await h.status());
  expect("button unchanged", (await h.button()) === "Connect wallet", await h.button());
});

await scenario("legacy window.ethereum only (no EIP-6963)", [mm({ legacy: true, eip6963: false })], async (h, expect) => {
  await h.page.click("#connect");
  await h.waitButton(/^0x/);
  expect("connected", /^0xE9bb/.test(await h.button()), await h.button());
  expect("no menu for one wallet", (await h.menu()) === null, await h.menu());
});

await scenario("one EIP-6963 wallet: connects at once", [mm()], async (h, expect) => {
  await h.page.click("#connect");
  await h.waitButton(/^0x/);
  expect("connected", /^0xE9bb/.test(await h.button()), await h.button());
  expect("status cleared", (await h.status()) === "", await h.status());
});

await scenario("two wallets: pick one, remembered after reload without a prompt", [mm(), rabby()], async (h, expect) => {
  await h.page.click("#connect");
  const menu = await h.menu();
  expect("menu lists both", menu && menu.includes("MetaMask") && menu.includes("Rabby Wallet"), menu);
  await h.page.getByRole("button", { name: "Rabby Wallet" }).click();
  await h.waitButton(/^0x/);
  expect("connected with Rabby's account", /^0x0000/.test(await h.button()), await h.button());
  expect("only Rabby was asked", (await h.calls()).filter((c) => c.endsWith("eth_requestAccounts")).join() === "Rabby Wallet:eth_requestAccounts", await h.calls());
  await h.page.reload();
  await h.waitButton(/^0x/);
  expect("reconnected after reload", /^0x0000/.test(await h.button()), await h.button());
  expect("no prompt on reload", !(await h.calls()).some((c) => c.endsWith("eth_requestAccounts")), await h.calls());
});

await scenario("menu closes on Escape and on a click outside", [mm(), rabby()], async (h, expect) => {
  await h.page.click("#connect");
  await h.page.keyboard.press("Escape");
  expect("Escape closes", (await h.menu()) === null, await h.menu());
  await h.page.click("#connect");
  await h.page.click("main");
  expect("outside click closes", (await h.menu()) === null, await h.menu());
});

await scenario("rejected in the wallet (4001), then connects on retry", [mm({ connect: "reject" })], async (h, expect) => {
  await h.page.click("#connect");
  await h.waitStatus(/Not connected/);
  expect("says it was cancelled", /Not connected: you cancelled it in your wallet\./.test(await h.status()), await h.status());
  expect("button back to Connect", (await h.button()) === "Connect wallet", await h.button());
  await h.page.evaluate(() => delete window.__wallets.MetaMask.w.connect); // approves this time
  await h.page.click("#connect");
  await h.waitButton(/^0x/);
  expect("connects on the second try", /^0xE9bb/.test(await h.button()), await h.button());
});

await scenario("a request already pending in the wallet (-32002)", [mm({ connect: "pending" })], async (h, expect) => {
  await h.page.click("#connect");
  await h.waitStatus(/Not connected/);
  expect("tells you to open the wallet", /already has a request waiting/.test(await h.status()), await h.status());
});

await scenario("wallet never answers: no second request, button says Connecting…", [mm({ connect: "hang" })], async (h, expect) => {
  await h.page.click("#connect");
  await h.page.click("#connect");
  await h.page.click("#connect");
  expect("button shows Connecting…", (await h.button()) === "Connecting…", await h.button());
  expect("one request only", (await h.calls()).filter((c) => c.endsWith("eth_requestAccounts")).length === 1, await h.calls());
  expect("status says approve in MetaMask", /Approve the connection in MetaMask/.test(await h.status()), await h.status());
});

await scenario("one wallet hangs: pick another, the late answer is ignored", [mm({ connect: "hang" }), rabby()], async (h, expect) => {
  await h.page.click("#connect");
  await h.page.getByRole("button", { name: "MetaMask" }).click();
  await h.page.click("#connect");
  const menu = await h.menu();
  expect("menu offers the others, MetaMask marked waiting", menu && menu.includes("MetaMask (waiting)") && menu.includes("Rabby Wallet"), menu);
  await h.page.getByRole("button", { name: "Rabby Wallet" }).click();
  await h.waitButton(/^0x0000/);
  expect("connected with Rabby", /^0x0000/.test(await h.button()), await h.button());
  await h.page.evaluate(() => window.__wallets.MetaMask.release());
  await h.page.waitForTimeout(800);
  expect("still Rabby after MetaMask answers late", /^0x0000/.test(await h.button()), await h.button());
  expect("status not overwritten", (await h.status()) === "", await h.status());
});

await scenario("wallet shares no account", [mm({ connect: "empty" })], async (h, expect) => {
  await h.page.click("#connect");
  await h.waitStatus(/Not connected/);
  expect("says so", /Not connected: MetaMask shared no account\./.test(await h.status()), await h.status());
});

await scenario("account switched in the wallet, then the site disconnected there", [mm()], async (h, expect) => {
  await h.page.click("#connect");
  await h.waitButton(/^0x/);
  await h.page.evaluate((a) => window.__wallets.MetaMask.emit("accountsChanged", [a]), A1);
  await h.waitButton(/^0x0000/);
  expect("follows the new account", /^0x0000/.test(await h.button()), await h.button());
  await h.page.evaluate(() => window.__wallets.MetaMask.emit("accountsChanged", []));
  await h.waitButton(/^Connect wallet$/);
  expect("disconnected", (await h.button()) === "Connect wallet", await h.button());
  await h.page.reload();
  await h.page.waitForTimeout(800);
  expect("not reconnected after reload", (await h.button()) === "Connect wallet", await h.button());
});

await scenario("Disconnect from the menu revokes, and stays disconnected after reload", [mm()], async (h, expect) => {
  await h.page.click("#connect");
  await h.waitButton(/^0x/);
  await h.page.click("#connect");
  const menu = await h.menu();
  expect("menu shows the wallet and Disconnect", menu && menu.some((l) => /Connected with MetaMask/.test(l)) && menu.includes("Disconnect"), menu);
  await h.page.getByRole("button", { name: "Disconnect" }).click();
  await h.waitButton(/^Connect wallet$/);
  expect("disconnected", (await h.button()) === "Connect wallet", await h.button());
  expect("asked the wallet to revoke", (await h.calls()).includes("MetaMask:wallet_revokePermissions"), await h.calls());
  await h.page.reload();
  await h.page.waitForTimeout(800);
  expect("still disconnected after reload", (await h.button()) === "Connect wallet", await h.button());
});

for (const [name, w] of [
  ["wallet on mainnet without Sepolia (4902): adds it, then the send is the user's call", mm({ chainId: "0x1", knows: ["0x1"] })],
  ["same, with 4902 wrapped in -32603 (MetaMask mobile)", mm({ chainId: "0x1", knows: ["0x1"], switch: "wrapped" })],
]) {
  await scenario(name, [w], async (h, expect) => {
    await h.page.click("#connect");
    await h.waitButton(/^0x/);
    await h.page.click("#mint");
    await h.waitStatus(/Not minted/);
    const calls = await h.calls();
    expect("switch, then add Sepolia, then send", ["MetaMask:wallet_switchEthereumChain", "MetaMask:wallet_addEthereumChain", "MetaMask:eth_sendTransaction"].every((c) => calls.includes(c)), calls);
    expect("rejection reads as cancelled", /Not minted: you cancelled it in your wallet\./.test(await h.status()), await h.status());
    expect("mint button usable again", await h.page.locator("#mint").isEnabled(), "disabled");
  });
}

await scenario("switch to Sepolia refused (4001)", [mm({ chainId: "0x1", switch: "reject" })], async (h, expect) => {
  await h.page.click("#connect");
  await h.waitButton(/^0x/);
  await h.page.click("#mint");
  await h.waitStatus(/Not minted/);
  expect("says it was cancelled", /Not minted: you cancelled it in your wallet\./.test(await h.status()), await h.status());
  expect("nothing sent", !(await h.calls()).includes("MetaMask:eth_sendTransaction"), await h.calls());
});

await scenario("eth_chainId as a number: no needless switch", [mm({ numericChainId: true })], async (h, expect) => {
  await h.page.click("#connect");
  await h.waitButton(/^0x/);
  await h.page.click("#mint");
  await h.waitStatus(/Not minted/);
  expect("no switch asked", !(await h.calls()).includes("MetaMask:wallet_switchEthereumChain"), await h.calls());
});

await scenario("wallet without events (no .on)", [mm({ noEvents: true })], async (h, expect) => {
  await h.page.click("#connect");
  await h.waitButton(/^0x/);
  expect("connected", /^0xE9bb/.test(await h.button()), await h.button());
});

await scenario("swap rejected in the wallet: says so, Swap usable again", [mm()], async (h, expect) => {
  await h.page.click("#connect");
  await h.waitButton(/^0x/);
  await h.page.fill("#amountIn", "0.0001");
  await h.page.waitForFunction(() => document.getElementById("swap").textContent === "Swap", null, { timeout: 60000 });
  await h.page.click("#swap");
  await h.waitStatus(/Not swapped/);
  expect("says it was cancelled", /Not swapped: you cancelled it in your wallet\./.test(await h.status()), await h.status());
  await h.page.waitForFunction(() => document.getElementById("swap").textContent === "Swap", null, { timeout: 60000 }).catch(() => {});
  expect("Swap usable again", (await h.t("#swap")) === "Swap" && (await h.page.locator("#swap").isEnabled()), await h.t("#swap"));
});

await browser.close();
await rm(profile, { recursive: true, force: true });
clearTimeout(HARD_LIMIT);
console.log(failures ? `\n${failures} of ${results.length} scenarios failed` : `\nall ${results.length} scenarios ok`);
process.exit(failures ? 1 : 0);
