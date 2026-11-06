#!/usr/bin/env node
/* Stress run of the Canary extension on Canary Swap: a real Chromium with the
   extension, the test wallet (test/wallet.mjs), and hundreds of JSON-RPC calls
   from the page.

   Each round quotes ETH → CNRY at three amounts, swaps, flips, quotes and
   swaps CNRY → ETH, then fires a burst of reads from the page at once to
   several Sepolia RPC URLs (fetch, batches, XHR). Then quotes on Ethereum and
   two Ethereum bursts, and a last burst of every swap's receipt.

   Every burst read is pinned to a block, so its answer is compared with the
   same call sent from Node straight to the read endpoint. The run checks that
   Canary counted every call, answered all of them through anon-rpc (none
   direct or failed closed), and that every swap was mined.

     node test/stress.mjs --key-file ../swap-test.key --canary ../extension/dist-local \
       [--url https://canary-swap.vercel.app/] [--rounds 5] [--out <dir>]

   Not part of `npm test`: it spends test ETH (two swaps a round). */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { createPublicClient, encodeFunctionData, formatEther, formatUnits, http, parseAbi, parseEther, toHex } from "viem";
import { mainnet } from "viem/chains";
import { MARKETS } from "../src/markets.js";
import { ABI, V4, poolId } from "../src/v4.js";
import { TX_LABEL, installWallet } from "./wallet.mjs";

const { values: opt } = parseArgs({
  options: {
    "key-file": { type: "string" },
    canary: { type: "string" },
    url: { type: "string", default: "http://localhost:3300/" },
    rpc: { type: "string", default: "https://ethereum-sepolia-rpc.publicnode.com" },
    chrome: { type: "string", default: process.env.CHROME_BIN },
    rounds: { type: "string", default: "5" },
    out: { type: "string" },
  },
});
if (!opt["key-file"] || !opt.canary) throw new Error("--key-file <file> and --canary <dist> are required");
const ROUNDS = Number(opt.rounds);
const HARD_LIMIT = setTimeout(() => (console.log("FAIL: hard limit of 30 minutes"), process.exit(3)), 30 * 60_000);

// The read endpoints Canary is configured with (extension/config/local-gateway.json): the direct reads compare against these.
const READ = { 1: "https://ethereum-rpc.publicnode.com", 11155111: "https://ethereum-sepolia-rpc.publicnode.com" };
// What the page asks. Canary knows each one's chain from its URL and answers from the read endpoint.
const URLS = {
  11155111: ["https://ethereum-sepolia-rpc.publicnode.com", "https://1rpc.io/sepolia", "https://sepolia.drpc.org", "https://sepolia.gateway.tenderly.co", "https://eth-sepolia.g.alchemy.com/v2/demo"],
  1: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://cloudflare-eth.com", "https://eth.merkle.io", "https://1rpc.io/eth", "https://rpc.flashbots.net"],
};
const direct = { 1: createPublicClient({ chain: mainnet, transport: http(READ[1]) }) };

const deployed = JSON.parse(await readFile(new URL("../sepolia.json", import.meta.url), "utf8"));
const CNRY = deployed.token.address;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const ERC20 = parseAbi(["function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)", "function transfer(address, uint256) returns (bool)"]);
const call = (to, abi, functionName, args = []) => ({ to, data: encodeFunctionData({ abi, functionName, args }) });

const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const result = { url: opt.url, at: new Date().toISOString(), rounds: ROUNDS, quotes: [], swaps: [], bursts: [], txs: [], mismatches: [], errors: [] };
const fail = (why) => {
  result.errors.push(why);
  log(`FAIL: ${why}`);
};

/* --- the browser, the extension and the test wallet ----------------------- */

const profile = await mkdtemp(resolve(tmpdir(), "canary-stress-"));
const dist = resolve(opt.canary);
const ctx = await chromium.launchPersistentContext(profile, { headless: true, executablePath: opt.chrome, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`], viewport: { width: 1280, height: 1000 } });
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 30000 }));
const { account, client } = await installWallet(ctx, { keyFile: opt["key-file"], rpc: opt.rpc, onTx: (t) => result.txs.push(t) });
const me = account.address;
result.wallet = me;
direct[11155111] = client;

const page = await ctx.newPage();
page.on("pageerror", (e) => fail(`pageerror: ${e.message}`));
const text = (sel) => page.locator(sel).innerText({ timeout: 5000 }).catch(() => "");
const waitText = (sel, re, timeout) => page.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent ?? ""), [sel, re.source], { timeout });

/** This tab's state in the extension: counts, rpcCalls, events. */
const origin = new URL(opt.url).origin;
const tabState = () =>
  sw.evaluate(async (o) => {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all).find(([k, v]) => k.startsWith("tab:") && v.origin === o) ?? [null, null];
  }, origin);
/** Waits until Canary has seen no new call for 2.5 s, so a burst's count is its own. */
async function settle() {
  let last = -1;
  let still = 0;
  for (let i = 0; i < 240 && still < 5; i++) {
    const n = (await tabState())[1]?.rpcCalls ?? 0;
    still = n === last ? still + 1 : 0;
    last = n;
    await page.waitForTimeout(500);
  }
  return last;
}

async function quote(amount) {
  await page.fill("#amountIn", "");
  await page.waitForFunction(() => document.getElementById("details").hidden, null, { timeout: 5000 });
  const t = Date.now();
  await page.fill("#amountIn", amount);
  await page.waitForFunction(() => !document.getElementById("details").hidden && document.getElementById("amountOut").textContent !== "…", null, { timeout: 90000 });
  const q = { chain: Number(await page.locator("#chain").inputValue()), amount, out: await text("#amountOut"), ms: Date.now() - t, requests: (await text("#sentList")).split("\n").filter(Boolean).length, addr: await text("#sentAddr") };
  if (!/in none of them/.test(q.addr)) fail(`quote ${amount} on ${q.chain}: ${q.addr}`);
  result.quotes.push(q);
  log(`quote ${amount} on ${q.chain === 1 ? "Ethereum" : "Sepolia"} → ${q.out} · ${q.requests} requests · ${q.ms} ms`);
  return q;
}
async function swap(label) {
  // The last swap's "Swapped." is still on the page: clear it so this one's is the one waited for.
  await page.evaluate(() => (document.getElementById("status").textContent = ""));
  const t = Date.now();
  await page.click("#swap");
  await waitText("#status", /^(Swapped|Not swapped)/, 240000);
  const s = { label, status: await text("#status"), ms: Date.now() - t, tx: (await page.locator("#status a").getAttribute("href").catch(() => null))?.split("/tx/")[1] };
  result.swaps.push(s);
  log(`${label}: ${s.status} · ${s.ms} ms`);
  if (!s.status.startsWith("Swapped")) fail(`${label}: ${s.status}`);
  return s;
}

/* --- bursts: JSON-RPC from the page, all at once -------------------------- */

let ids = 0;
const rpc = (method, params) => ({ jsonrpc: "2.0", id: ++ids, method, params });

/** Single calls spread over the chain's URLs, two batches (string ids, one call twice), and a few over XHR. */
function jobsFor(chainId, calls) {
  const urls = URLS[chainId];
  const jobs = calls.map(([m, p], i) => ({ url: urls[i % urls.length], body: rpc(m, p) }));
  for (const [b, start] of [[0, 3], [1, 9]]) {
    const batch = Array.from({ length: Math.min(8, calls.length) }, (_, i) => calls[(start + i) % calls.length]).map(([m, p], i) => ({ ...rpc(m, p), id: `b${ids}-${b}-${i}` }));
    batch.push({ ...batch[0], id: `b${ids}-${b}-again` });
    jobs.push({ url: urls[(b + 1) % urls.length], body: batch });
  }
  for (let i = 0; i < 3; i++) jobs.push({ url: urls[(i + 2) % urls.length], body: rpc(...calls[(i * 5 + 4) % calls.length]), xhr: true });
  return jobs;
}

function sepoliaCalls(block, hashes) {
  const b = toHex(block);
  const { stateView, quoter, permit2, universalRouter } = V4[11155111];
  const key = deployed.pool.key;
  return [
    ["eth_chainId", []],
    ["eth_blockNumber", []],
    ["eth_blockNumber", []],
    ["eth_getBalance", [me, b]],
    ["eth_getBalance", [universalRouter, b]],
    ["eth_getBalance", [DEAD, b]],
    ["eth_call", [call(CNRY, ABI.erc20, "balanceOf", [me]), b]],
    ["eth_call", [call(CNRY, ERC20, "totalSupply"), b]],
    ["eth_call", [call(CNRY, ABI.erc20, "allowance", [me, permit2]), b]],
    ["eth_call", [call(permit2, ABI.permit2, "allowance", [me, CNRY, universalRouter]), b]],
    ["eth_call", [call(stateView, ABI.stateView, "getSlot0", [deployed.pool.id]), b]],
    ["eth_call", [call(stateView, ABI.stateView, "getLiquidity", [deployed.pool.id]), b]],
    ["eth_call", [call(quoter, ABI.quoter, "quoteExactInputSingle", [{ poolKey: key, zeroForOne: true, exactAmount: parseEther("0.0001"), hookData: "0x" }]), b]],
    ["eth_call", [call(quoter, ABI.quoter, "quoteExactInputSingle", [{ poolKey: key, zeroForOne: false, exactAmount: parseEther("9"), hookData: "0x" }]), b]],
    ["eth_getTransactionCount", [me, b]],
    ["eth_getTransactionCount", [DEAD, b]],
    ["eth_getCode", [CNRY, b]],
    ["eth_getCode", [universalRouter, b]],
    ["eth_getCode", [me, b]],
    ["eth_getStorageAt", [CNRY, "0x2", b]],
    ["eth_getBlockByNumber", [b, false]],
    ["eth_feeHistory", ["0x4", b, [25, 75]]],
    ["eth_getLogs", [{ address: CNRY, fromBlock: toHex(block - 50n), toBlock: b }]],
    ["eth_estimateGas", [{ from: me, ...call(CNRY, ERC20, "transfer", [DEAD, 1n]) }, b]],
    ["eth_gasPrice", []],
    ["eth_maxPriorityFeePerGas", []],
    ["eth_getBalance", ["0x123", b]], // not an address: the node's error must come back as it is
    ...hashes.flatMap((h) => [["eth_getTransactionReceipt", [h]], ["eth_getTransactionByHash", [h]]]),
  ];
}

function mainnetCalls(block) {
  const b = toHex(block);
  const { stateView, quoter, poolManager, universalRouter } = V4[1];
  const usdc = MARKETS[1].tokens[1].address;
  return [
    ["eth_chainId", []],
    ["eth_blockNumber", []],
    ...MARKETS[1].pools.flatMap((k) => [
      ["eth_call", [call(stateView, ABI.stateView, "getSlot0", [poolId(k)]), b]],
      ["eth_call", [call(stateView, ABI.stateView, "getLiquidity", [poolId(k)]), b]],
      ["eth_call", [call(quoter, ABI.quoter, "quoteExactInputSingle", [{ poolKey: k, zeroForOne: true, exactAmount: parseEther("1"), hookData: "0x" }]), b]],
    ]),
    ["eth_call", [call(usdc, ABI.erc20, "balanceOf", [me]), b]],
    ["eth_call", [call(usdc, ABI.erc20, "balanceOf", [poolManager]), b]],
    ["eth_call", [call(usdc, ERC20, "totalSupply"), b]],
    ["eth_call", [call(usdc, ERC20, "decimals"), b]],
    ["eth_getBalance", [me, b]],
    ["eth_getBalance", [poolManager, b]],
    ["eth_getTransactionCount", [me, b]],
    ["eth_getCode", [usdc, b]],
    ["eth_getCode", [stateView, b]],
    ["eth_getCode", [universalRouter, b]],
    ["eth_getStorageAt", [usdc, "0x1", b]],
    ["eth_getBlockByNumber", [b, false]],
    ["eth_feeHistory", ["0x4", b, [10, 50, 90]]],
    ["eth_estimateGas", [{ from: me, to: DEAD, value: "0x0" }, b]],
    ["eth_gasPrice", []],
    ["eth_maxPriorityFeePerGas", []],
    ["eth_blobBaseFee", []],
  ];
}

// Key order aside: publicnode's backends answer the same eth_feeHistory with its keys in either order.
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x));

/** Two answers to the same call agree. Pinned reads must be equal; "latest" ones only close. */
function same(method, a, b) {
  if (a?.error || b?.error) return !!a?.error === !!b?.error;
  const [x, y] = [a?.result, b?.result];
  switch (method) {
    case "eth_blockNumber": return Math.abs(Number(x) - Number(y)) <= 30;
    case "eth_gasPrice": case "eth_maxPriorityFeePerGas": case "eth_blobBaseFee": return /^0x[0-9a-f]+$/i.test(x);
    case "eth_getBlockByNumber": return x?.hash === y?.hash;
    // publicnode's Sepolia backends disagree on the reward percentiles of the same block, so only their shape is compared.
    case "eth_feeHistory": return !!x && canon({ ...x, reward: x.reward?.map((r) => r.length) }) === canon({ ...y, reward: y?.reward?.map((r) => r.length) });
    case "eth_getTransactionReceipt": return !!x && x.transactionHash === y?.transactionHash && x.blockHash === y?.blockHash && x.status === y?.status && x.gasUsed === y?.gasUsed;
    case "eth_getTransactionByHash": return !!x && x.hash === y?.hash && x.blockHash === y?.blockHash && x.input === y?.input;
    default: return canon(x) === canon(y);
  }
}

/** The same calls from Node, straight to the read endpoint, in batches of 10. This machine's IP gets
    rate-limited by the endpoint after a few runs (-32005), so those calls are asked again after a pause. */
async function directly(chainId, calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 10) {
    const chunk = calls.slice(i, i + 10).map((c, j) => ({ jsonrpc: "2.0", id: j, method: c.method, params: c.params }));
    let answers = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const ask = chunk.filter((c) => !answers[c.id] || answers[c.id].error?.code === -32005);
      if (!ask.length) break;
      if (attempt) await new Promise((ok) => setTimeout(ok, 3000 * attempt));
      const r = await fetch(READ[chainId], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ask) }).then((x) => x.json()).catch(() => []);
      for (const a of Array.isArray(r) ? r : []) answers[a.id] = a;
    }
    out.push(...chunk.map((c) => answers[c.id]));
  }
  return out;
}

const latencies = { single: [], batch: [], xhr: [] };
async function burst(name, chainId, calls) {
  const jobs = jobsFor(chainId, calls);
  const n = jobs.reduce((s, j) => s + (Array.isArray(j.body) ? j.body.length : 1), 0);
  const before = await settle();
  const t = Date.now();
  const answers = await page.evaluate(
    (jobs) =>
      Promise.all(
        jobs.map(async ({ url, body, xhr }) => {
          const t0 = performance.now();
          try {
            const text = xhr
              ? await new Promise((ok, no) => {
                  const x = new XMLHttpRequest();
                  x.open("POST", url);
                  x.setRequestHeader("content-type", "application/json");
                  x.onload = () => ok(x.responseText);
                  x.onerror = () => no(new Error("XHR failed"));
                  x.send(body);
                })
              : await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })).text();
            return { ms: performance.now() - t0, text };
          } catch (e) {
            return { ms: performance.now() - t0, error: String(e?.message ?? e) };
          }
        }),
      ),
    jobs.map((j) => ({ url: j.url, body: JSON.stringify(j.body), xhr: !!j.xhr })),
  );
  const wallMs = Date.now() - t;
  const after = await settle();

  // Every call's answer: right shape, its own id, and the same as the direct read.
  const flat = [];
  jobs.forEach((j, i) => {
    const a = answers[i];
    (Array.isArray(j.body) ? latencies.batch : j.xhr ? latencies.xhr : latencies.single).push(a.ms);
    let parsed;
    try {
      parsed = a.error ? undefined : JSON.parse(a.text);
    } catch {}
    const reqs = Array.isArray(j.body) ? j.body : [j.body];
    const resp = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    if (!parsed || Array.isArray(parsed) !== Array.isArray(j.body)) fail(`${name}: ${j.url} answered ${a.error ?? String(a.text).slice(0, 120)}`);
    for (const q of reqs) {
      const mine = resp.filter((r) => r.id === q.id);
      if (parsed && (mine.length !== 1 || mine[0].jsonrpc !== "2.0")) fail(`${name}: id ${q.id} answered ${mine.length} times`);
      flat.push({ q, got: mine[0], host: new URL(j.url).hostname, kind: Array.isArray(j.body) ? "batch" : j.xhr ? "xhr" : "single" });
    }
  });
  const want = await directly(chainId, flat.map((f) => f.q));
  const mismatches = [];
  flat.forEach((f, i) => {
    if (!same(f.q.method, f.got, want[i])) mismatches.push({ burst: name, method: f.q.method, host: f.host, kind: f.kind, got: canon(f.got?.error ?? f.got?.result)?.slice(0, 160), want: canon(want[i]?.error ?? want[i]?.result)?.slice(0, 160) });
  });
  result.mismatches.push(...mismatches);
  const b = { name, chainId, requests: jobs.length, calls: n, wallMs, canaryCounted: after - before, mismatches: mismatches.length, hosts: [...new Set(jobs.map((j) => new URL(j.url).hostname))] };
  result.bursts.push(b);
  log(`burst ${name}: ${jobs.length} requests, ${n} calls in ${wallMs} ms · Canary counted ${b.canaryCounted} · ${mismatches.length} differ from the direct read`);
  if (b.canaryCounted !== n) fail(`${name}: sent ${n} calls, Canary counted ${b.canaryCounted}`);
  for (const m of mismatches) fail(`${name}: ${m.method} via ${m.host} (${m.kind}) got ${m.got}, direct ${m.want}`);
}

const pinned = async (chainId) => (await direct[chainId].getBlockNumber()) - 5n;
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : null;
};
const stats = (xs) => ({ n: xs.length, mean: xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null, p50: pct(xs, 50), p95: pct(xs, 95), max: xs.length ? Math.round(Math.max(...xs)) : null });

/* --- the run --------------------------------------------------------------- */

try {
  const bal = async () => {
    const [eth, cnry] = await Promise.all([client.getBalance({ address: me }), client.readContract({ address: CNRY, abi: ABI.erc20, functionName: "balanceOf", args: [me] })]);
    return { ETH: formatEther(eth), CNRY: formatUnits(cnry, 18) };
  };
  result.before = await bal();
  log(`wallet ${me}: ${result.before.ETH} ETH, ${result.before.CNRY} CNRY`);
  await page.goto(opt.url);
  await page.click("#connect");
  await waitText("#connect", /^0x/, 15000);

  for (let r = 1; r <= ROUNDS; r++) {
    for (const a of ["0.00005", "0.0002", "0.0001"]) await quote(a);
    await swap(`round ${r}: swap 0.0001 ETH → CNRY`);
    await page.click("#flip");
    await quote("9");
    await swap(`round ${r}: swap 9 CNRY → ETH`);
    await page.click("#flip");
    // Receipts only of earlier rounds' swaps: a just-mined one can be missing on a node a block behind.
    const older = result.swaps.slice(0, -2).map((s) => s.tx).filter(Boolean).slice(-2);
    await burst(`sepolia-${r}`, 11155111, sepoliaCalls(await pinned(11155111), older));
  }

  await page.selectOption("#chain", "1");
  for (const a of ["0.01", "0.1", "0.5", "1", "2", "5", "10", "25", "50", "100"]) await quote(a);
  await burst("ethereum-1", 1, mainnetCalls(await pinned(1)));
  await burst("ethereum-2", 1, mainnetCalls(await pinned(1)));
  await page.selectOption("#chain", "11155111");

  // Every swap's receipt and transaction, mined a while ago by now.
  await page.waitForTimeout(15000);
  const hashes = result.swaps.map((s) => s.tx).filter(Boolean);
  const b = toHex(await pinned(11155111));
  await burst("receipts", 11155111, [["eth_blockNumber", []], ["eth_getBlockByNumber", [b, false]], ...hashes.flatMap((h) => [["eth_getTransactionReceipt", [h]], ["eth_getTransactionByHash", [h]]])]);

  for (const t of result.txs) {
    const rc = await client.waitForTransactionReceipt({ hash: t.hash });
    Object.assign(t, { status: rc.status, block: String(rc.blockNumber), what: TX_LABEL[t.selector] ?? `${t.to} ${t.selector}` });
    if (rc.status !== "success") fail(`${t.hash} ${rc.status}`);
  }
  log(`${result.txs.length} transactions, ${result.txs.filter((t) => t.status === "success").length} mined successfully`);
  result.after = await bal();
  log(`wallet after: ${result.after.ETH} ETH, ${result.after.CNRY} CNRY`);

  // What Canary recorded for the tab, over the whole run.
  await settle();
  const [key, tab] = await tabState();
  const reads = (tab?.events ?? []).filter((e) => e.channel !== "wallet" && e.methods?.length);
  const burstCalls = result.bursts.reduce((s, x) => s + x.calls, 0);
  result.canary = {
    counts: tab?.counts,
    rpcCalls: tab?.rpcCalls,
    answeredWithoutRequest: tab?.noRequest,
    fromBursts: burstCalls,
    fromThePage: (tab?.rpcCalls ?? 0) - burstCalls,
    readsVia: [...new Set(reads.map((e) => e.via).filter(Boolean))],
    hosts: [...new Set(reads.map((e) => e.host))],
    eventsKept: reads.length,
    notProtected: reads.filter((e) => e.category !== "protected").map((e) => ({ host: e.host, category: e.category, methods: e.methods, note: e.note })),
    latency: stats(tab?.latencies ?? []),
  };
  log(`canary: ${tab?.rpcCalls} calls (${burstCalls} from the bursts, ${result.canary.fromThePage} from quotes and swaps) · ${JSON.stringify(tab?.counts)}`);
  if (!(tab?.rpcCalls >= 500)) fail(`Canary counted ${tab?.rpcCalls} calls, fewer than 500`);
  const c = tab?.counts ?? {};
  if (c.protected !== tab?.rpcCalls) fail(`not every call was answered through anon-rpc: ${JSON.stringify(c)}`);
  if (c.failedClosed || c.direct) fail(`failed closed ${c.failedClosed}, direct ${c.direct}`);
  if (result.canary.notProtected.length) fail(`reads not protected: ${JSON.stringify(result.canary.notProtected.slice(0, 5))}`);

  result.latency = { single: stats(latencies.single), batch: stats(latencies.batch), xhr: stats(latencies.xhr), quote: stats(result.quotes.map((q) => q.ms)), swap: stats(result.swaps.map((s) => s.ms)) };
  const all = [...latencies.single, ...latencies.batch, ...latencies.xhr];
  result.latency.allBurstRequests = stats(all);
  result.latency.raw = Object.fromEntries(Object.entries(latencies).map(([k, v]) => [k, v.map(Math.round)]));
  for (const [k, v] of Object.entries({ ...latencies, "all burst requests": all, "page quote": result.quotes.map((q) => q.ms), "page swap": result.swaps.map((s) => s.ms), "Canary's own (last 200)": tab?.latencies ?? [] })) {
    const x = stats(v);
    log(`latency ${k}: mean ${x.mean} ms · p50 ${x.p50} · p95 ${x.p95} · max ${x.max} (n ${x.n})`);
  }

  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 400, height: 900 });
  await pop.goto(`chrome-extension://${await sw.evaluate(() => chrome.runtime.id)}/popup.html?tabId=${key?.slice(4)}`);
  await pop.waitForTimeout(2000);
  const inner = (sel) => pop.locator(sel).innerText({ timeout: 5000 }).catch(() => "");
  result.canary.popup = { badge: (await inner("header")).split("\n").pop(), headline: await inner("#headline"), summary: (await inner("#summary")).split("\n") };
  log(`popup: ${result.canary.popup.badge} · ${result.canary.popup.summary.join(" | ")}`);
  if (opt.out) {
    await mkdir(opt.out, { recursive: true });
    await pop.screenshot({ path: `${opt.out}/stress-popup.png` }).catch(() => {});
  }
} catch (e) {
  fail(e.message.split("\n")[0]);
} finally {
  if (opt.out) {
    await mkdir(opt.out, { recursive: true });
    await writeFile(`${opt.out}/stress-canary.json`, JSON.stringify(result, null, 2) + "\n");
  }
  await ctx.close();
  await rm(profile, { recursive: true, force: true });
  clearTimeout(HARD_LIMIT);
}
const calls = result.canary?.rpcCalls ?? 0;
console.log(result.errors.length ? `\n${result.errors.length} failure(s)` : `\nok: ${calls} calls through Canary, ${result.bursts.reduce((s, b) => s + b.calls, 0)} of them checked against direct reads, ${result.swaps.length} swaps mined`);
process.exit(result.errors.length ? 1 : 0);
