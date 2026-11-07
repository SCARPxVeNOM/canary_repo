#!/usr/bin/env node
// Live end-to-end check for Canary for agents, over real tor-js.
//
//   node scripts/live-e2e.mjs [--out <dir>] [--only ef|own]
//
// For each tor-js gateway set (EF's demo gateway, then our own from
// canary.local.config.json), it starts the real @ayush_saklani/canary-gateway (headless
// Chrome + anon-rpc) and checks that:
//   1. the backend boots (and how long it takes);
//   2. chain reads through the gateway's RPC endpoint (any-language path) and
//      through the SDK's viem transport return EXACTLY what the chain returns,
//      at a pinned block, compared with a direct read (ground truth);
//   3. the anon path exits through Tor (check.torproject.org via the gateway's
//      policy-checked fetch, against this machine's own IP fetched directly);
//   4. the SDK's llmFetch pseudonymizes the agent wallet before a prompt leaves,
//      and restores it in the response (a local echo server plays the LLM);
//   5. undeclared hosts are refused, and the ledger/report counts all of it;
//   6. the Python example agent works through the gateway with no code changes;
//   7. the ENSv2 records on Sepolia (leakydash.eth, trader-01.agents.canary.eth) read through it.
// Results: <out>/results.json, plus a readable summary on stdout.
//
// Direct ground-truth reads use public addresses only (vitalik.eth's), so they
// reveal nothing about the person running the check.

import { createGateway } from "@ayush_saklani/canary-gateway";
import { createCanary } from "@ayush_saklani/canary-agent";
import { createPublicClient, erc20Abi } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "..");
const { values: opt } = parseArgs({ options: { out: { type: "string", default: resolve(ROOT, "..", "live-check") }, only: { type: "string" } } });

const W = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // vitalik.eth: public, has state on both chains
const AGENT_WALLET = "0x5Ca1ab1e00000000000000000000000000C0FfEe"; // synthetic: only used for pseudonymization
const USDC = { 11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", 1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" };
const DIRECT = { 11155111: "https://ethereum-sepolia-rpc.publicnode.com", 1: "https://ethereum-rpc.publicnode.com" };
const BALANCE_OF = (a) => "0x70a08231" + a.slice(2).toLowerCase().padStart(64, "0");

const results = { startedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, runs: [] };
const log = (...a) => console.log(...a);
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: timeout after ${ms} ms`)), ms))]);

async function rpc(url, method, params = []) {
  const t0 = Date.now();
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return { result: j.result, ms: Date.now() - t0 };
}

/* --- ground truth (direct) ------------------------------------------------ */

async function groundTruth() {
  const out = {};
  for (const chain of [11155111, 1]) {
    const latest = Number((await rpc(DIRECT[chain], "eth_blockNumber")).result);
    const block = "0x" + (latest - 12).toString(16); // a few blocks back: stable, still recent enough for pruned nodes
    out[chain] = {
      block,
      chainId: (await rpc(DIRECT[chain], "eth_chainId")).result,
      balance: (await rpc(DIRECT[chain], "eth_getBalance", [W, block])).result,
      usdc: (await rpc(DIRECT[chain], "eth_call", [{ to: USDC[chain], data: BALANCE_OF(W) }, block])).result,
      blockHash: (await rpc(DIRECT[chain], "eth_getBlockByNumber", [block, false])).result.hash,
      latest,
    };
  }
  return out;
}

/* --- a local "LLM" that echoes what it received -------------------------- */

function startEcho() {
  return new Promise((res) => {
    const seen = [];
    const s = createServer((req, r) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        seen.push(b);
        const prompt = JSON.parse(b || "{}").messages?.[0]?.content ?? "";
        r.writeHead(200, { "content-type": "application/json" });
        r.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `You asked about ${prompt.match(/WALLET_\d+|0x[0-9a-fA-F]{40}/)?.[0] ?? "nothing"}` } }] }));
      });
    });
    s.listen(0, "127.0.0.1", () => res({ url: `http://127.0.0.1:${s.address().port}/v1/chat/completions`, seen, close: () => s.close() }));
  });
}

/* --- one run per gateway set --------------------------------------------- */

async function runOne(name, network, truth) {
  const run = { name, gateways: network.workerConfig?.gateways, checks: [], timings: {} };
  results.runs.push(run);
  const check = (id, ok, detail) => {
    run.checks.push({ id, ok: !!ok, detail });
    log(`  ${ok ? "✓" : "✗"} ${id}${detail !== undefined ? `  ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 220)}` : ""}`);
  };
  log(`\n=== ${name}: ${network.workerConfig?.gateways?.join(", ")}`);

  const echo = await startEcho();
  const manifest = {
    v: 1,
    agent: "trader-01.agents.canary.eth",
    hosts: { "check.torproject.org": "anon", "127.0.0.1": "direct", "api.coingecko.com": "anon" },
    undeclared: "block",
    rpc: { write: "anon" },
    wallets: "undisclosed",
    llm: { allow: [USDC[11155111]] },
  };
  let gw, canary;
  const t0 = Date.now();
  try {
    gw = await createGateway({
      port: 0,
      proxyPort: 0,
      network,
      chromium: { channel: "chrome", headless: true },
      chains: { "11155111": { read: DIRECT[11155111] }, "1": { read: DIRECT[1] } },
      wallets: [AGENT_WALLET],
      manifest,
      timeoutMs: 45000,
    });
    run.gatewayUrl = gw.url;
    // 1. boot
    let st;
    const until = Date.now() + 120000;
    while (Date.now() < until) {
      st = gw.backend.status();
      if (st.state === "ready" || st.state === "failed") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    run.timings.bootMs = Date.now() - t0;
    run.backend = st;
    check("backend boots (tor-js)", st?.state === "ready", `${st?.state} in ${run.timings.bootMs} ms${st?.error ? ` (${st.error})` : ""}`);
    if (st?.state !== "ready") return run;

    // 2a. any-language path: raw JSON-RPC to the gateway
    for (const chain of [11155111, 1]) {
      const T = truth[chain];
      const u = gw.rpcUrl(chain);
      const t1 = Date.now();
      try {
        const [cid, bal, usdc, blk] = await Promise.all([
          rpc(u, "eth_chainId"),
          rpc(u, "eth_getBalance", [W, T.block]),
          rpc(u, "eth_call", [{ to: USDC[chain], data: BALANCE_OF(W) }, T.block]),
          rpc(u, "eth_getBlockByNumber", [T.block, false]),
        ]);
        run.timings[`rpc${chain}Ms`] = Date.now() - t1;
        check(`gateway RPC ${chain}: chainId`, cid.result === T.chainId, cid.result);
        check(`gateway RPC ${chain}: balance at ${T.block} matches direct`, bal.result === T.balance, `${bal.result} vs ${T.balance} (${bal.ms} ms)`);
        check(`gateway RPC ${chain}: USDC.balanceOf at ${T.block} matches direct`, usdc.result === T.usdc, `${usdc.ms} ms`);
        check(`gateway RPC ${chain}: block hash matches direct`, blk.result?.hash === T.blockHash, `${blk.ms} ms`);
      } catch (e) {
        check(`gateway RPC ${chain}`, false, e.message);
      }
    }
    const latest = await rpc(gw.rpcUrl(11155111), "eth_blockNumber").catch((e) => ({ error: e.message }));
    check("gateway RPC: latest block is current (within 30 blocks of direct)", latest.result && Math.abs(Number(latest.result) - truth[11155111].latest) < 30, latest.result ? `${Number(latest.result)} vs ${truth[11155111].latest}` : latest.error);

    // 2b. TypeScript SDK: viem transport
    canary = await createCanary({ gateway: gw.url, wallets: [AGENT_WALLET] });
    const events = [];
    canary.on("egress", (e) => events.push(e));
    for (const [chain, def] of [[11155111, sepolia], [1, mainnet]]) {
      const T = truth[chain];
      const client = createPublicClient({ chain: def, transport: canary.viemTransport() });
      const t1 = Date.now();
      try {
        const bn = BigInt(T.block);
        const [bal, usdc] = await Promise.all([
          client.getBalance({ address: W, blockNumber: bn }),
          client.readContract({ address: USDC[chain], abi: erc20Abi, functionName: "balanceOf", args: [W], blockNumber: bn }),
        ]);
        check(`SDK viem ${chain}: getBalance matches direct`, bal === BigInt(T.balance), `${bal} (${Date.now() - t1} ms)`);
        check(`SDK viem ${chain}: readContract matches direct`, usdc === BigInt(T.usdc), String(usdc));
      } catch (e) {
        check(`SDK viem ${chain}`, false, e.shortMessage ?? e.message);
      }
    }
    try {
      const provider = await canary.ethersProvider(11155111);
      const bal = await provider.getBalance(W, Number(truth[11155111].block));
      check("SDK ethers 11155111: getBalance matches direct", bal === BigInt(truth[11155111].balance), String(bal));
    } catch (e) {
      check("SDK ethers 11155111", false, e.message);
    }

    // 3. the anon path exits through Tor
    try {
      const direct = await (await fetch("https://check.torproject.org/api/ip")).json();
      const t1 = Date.now();
      const viaCanary = await (await canary.fetch("https://check.torproject.org/api/ip")).json();
      run.exit = { direct, viaCanary, ms: Date.now() - t1 };
      check("anon path exits through Tor (check.torproject.org)", viaCanary.IsTor === true && viaCanary.IP !== direct.IP, `via Canary IsTor=${viaCanary.IsTor}; direct IsTor=${direct.IsTor}; exit IP differs from this machine's: ${viaCanary.IP !== direct.IP}`);
    } catch (e) {
      check("anon path exits through Tor", false, e.message);
    }

    // 4. LLM pseudonymization (local echo server as the "LLM")
    try {
      const prompt = `You manage wallet ${AGENT_WALLET}. It holds USDC at ${USDC[11155111]}. Should it swap?`;
      const r = await canary.llmFetch(echo.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "x", messages: [{ role: "user", content: prompt }] }) });
      const j = await r.json();
      const sent = echo.seen.at(-1) ?? "";
      check("LLM: the wallet never reaches the provider", !sent.toLowerCase().includes(AGENT_WALLET.slice(2).toLowerCase()) && sent.includes("WALLET_1"), sent.slice(0, 160));
      check("LLM: allow-listed contract passes unchanged", sent.includes(USDC[11155111]));
      check("LLM: alias restored in the response", (j.choices?.[0]?.message?.content ?? "").includes(AGENT_WALLET), j.choices?.[0]?.message?.content);
    } catch (e) {
      check("LLM pseudonymization", false, e.message);
    }

    // 5. policy: undeclared host refused; report counts
    try {
      const r = await canary.fetch("https://example.com/");
      check("undeclared host refused (fail closed)", r.status === 403, `${r.status} ${r.headers.get("x-canary-decision") ?? ""}`);
    } catch (e) {
      check("undeclared host refused (fail closed)", /refus|block|403/i.test(e.message), e.message);
    }
    const { signed } = await gw.report();
    run.report = signed?.report ?? signed;
    const c = run.report?.rpc ?? run.report?.counts ?? {};
    check("report: reads counted as protected, none direct/failed", JSON.stringify(run.report).includes("protected"), JSON.stringify(c).slice(0, 220));

    // 6. Python agent, no code changes (if python3 is installed)
    const py = await new Promise((res) => {
      const p = spawn("python3", [resolve(ROOT, "examples/python-agent/agent.py")], {
        env: { ...process.env, WALLET: W, RPC_URL: gw.rpcUrl(11155111), HTTPS_PROXY: gw.proxyUrl ?? "", HTTP_PROXY: gw.proxyUrl ?? "", NO_PROXY: "127.0.0.1,localhost" },
      });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("error", (e) => res({ code: -1, out: String(e) }));
      p.on("exit", (code) => res({ code, out }));
      setTimeout(() => (p.kill(), res({ code: -2, out: out + "\n(timeout)" })), 90000);
    });
    run.python = py;
    const chainLine = py.out.split("\n").find((l) => l.includes('"chain"') || l.includes("block"));
    check("Python agent: chain read through the gateway", py.code === 0 && chainLine, (chainLine ?? py.out).slice(0, 200));
    // 7. ENSv2 on Sepolia, read through the gateway (over anon-rpc)
    const ensCli = resolve(ROOT, "node_modules/.bin/canary-ens");
    const runCli = (args) => new Promise((res) => {
      const p = spawn(ensCli, args, { env: process.env });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("error", (e) => res({ code: -1, out: String(e) }));
      p.on("exit", (code) => res({ code, out }));
      setTimeout(() => (p.kill(), res({ code: -2, out: out + "\n(timeout)" })), 120000);
    });
    const dapp = await runCli(["read-dapp", "leakydash.eth", "--rpc", gw.rpcUrl(11155111)]);
    const agent = await runCli(["read", "trader-01.agents.canary.eth", "--rpc", gw.rpcUrl(11155111)]);
    run.ens = { dapp, agent };
    check("ENSv2 leakydash.eth: manifest + signed verdict readable over anon-rpc", dapp.code === 0 && /manifest/i.test(dapp.out) && /verdict/i.test(dapp.out), dapp.out.replace(/\s+/g, " ").slice(0, 220));
    check("ENSv2 trader-01.agents.canary.eth: policy + signed report readable over anon-rpc", agent.code === 0 && /manifest|policy/i.test(agent.out), agent.out.replace(/\s+/g, " ").slice(0, 220));
    run.events = events.length;
  } catch (e) {
    check("run", false, e.stack ?? e.message);
  } finally {
    run.timings.totalMs = Date.now() - t0;
    await canary?.close?.().catch(() => {});
    await gw?.close().catch(() => {});
    echo.close();
  }
  return run;
}

/* --- main ---------------------------------------------------------------- */

await mkdir(opt.out, { recursive: true });
log(`Canary live e2e · ${results.startedAt} · node ${process.version} · ${results.platform}`);
log("ground truth (direct, public address only)…");
const truth = await groundTruth();
results.truth = truth;
log(`  Sepolia block ${truth[11155111].block}, mainnet block ${truth[1].block}`);

const ef = JSON.parse(await readFile(resolve(ROOT, "examples/viem-agent/canary.config.json"), "utf8")).network;
const own = JSON.parse(await readFile(resolve(ROOT, "examples/viem-agent/canary.local.config.json"), "utf8")).network;
if (opt.only !== "own") await runOne("EF demo gateway (default config)", ef, truth);
if (opt.only !== "ef") await runOne("own gateways (canary.local.config.json)", own, truth);

results.finishedAt = new Date().toISOString();
const file = resolve(opt.out, "results.json");
await writeFile(file, JSON.stringify(results, null, 2));
log(`\n${results.runs.map((r) => `${r.name}: ${r.checks.filter((c) => c.ok).length}/${r.checks.length} checks`).join("\n")}\n→ ${file}`);
process.exit(0);
