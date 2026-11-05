#!/usr/bin/env node
// Live check: the real network, end to end (test-repo.md §13).
//
//   npm run build
//   node scripts/live-check.mjs [--config examples/viem-agent/canary.config.json] [--ens-name <sepolia name>] [--out live-check.json]
//
// Boots the gateway from the config (tor-js by default), then checks, over the
// real anon-rpc network:
//   1. the worker boots, then serves: tor-js can report ready minutes before it
//      builds a circuit through the KPS gateway, so both times are reported
//   2. each configured chain: local eth_chainId, reads through anon-rpc, latency
//   3. a batch carrying two wallets is answered (split per wallet)
//   4. the SDK: viem through the gateway; an undeclared host refused;
//      an `anon` host from the manifest fetched through anon-rpc
//   5. ENSv2 on Sepolia: the Universal Resolver viem uses has code; with
//      --ens-name, the name's resolver and which delegation API it exposes
//   6. the coverage report: nothing failed closed, nothing went direct
// Prints PASS/FAIL/INFO lines and writes a JSON summary to --out.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createPublicClient, http, toFunctionSelector } from "viem";
import { sepolia } from "viem/chains";
import { createGateway } from "@canary/gateway";
import { createCanary } from "@canary/agent";
import { resolverOf, readText } from "@canary/ens";

const ROOT = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    config: { type: "string", default: resolve(ROOT, "examples/viem-agent/canary.config.json") },
    "ens-name": { type: "string" },
    out: { type: "string", default: resolve(ROOT, "live-check.json") },
    "boot-timeout": { type: "string", default: "300000" },
    "serve-timeout": { type: "string", default: "300000" },
  },
});

const results = [];
const t0 = Date.now();
const line = (status, name, detail = "") => {
  results.push({ status, name, detail, at: Date.now() - t0 });
  console.log(`${status.padEnd(4)} ${name}${detail ? ` — ${detail}` : ""}`);
};
const step = async (name, f) => {
  const s = Date.now();
  try {
    const detail = await f();
    line("PASS", name, [detail, `${Date.now() - s} ms`].filter(Boolean).join(" · "));
  } catch (e) {
    line("FAIL", name, (e?.shortMessage ?? e?.message ?? String(e)).split("\n")[0]);
  }
};

const cfgPath = resolve(values.config);
const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
if (cfg.manifestFile) cfg.manifest = JSON.parse(await readFile(resolve(dirname(cfgPath), cfg.manifestFile), "utf8"));
delete cfg.ens; // this check uses the local manifest; ENS is probed read-only below
const WALLETS = ["0x00000000219ab540356cBB839Cbe05303d7705Fa", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"];

console.log(`Canary live check · ${new Date().toISOString()} · node ${process.version} · ${process.platform}`);
console.log(`config ${cfgPath} · network ${cfg.network?.label ?? cfg.network?.id}\n`);

let gw;
try {
  gw = await createGateway({ ...cfg, port: 0, proxyPort: 0, wallets: WALLETS });
} catch (e) {
  line("FAIL", "gateway starts", e.message);
  await finish();
}
line("PASS", "gateway starts", `${gw.url} · proxy ${gw.proxyUrl}`);
gw.backend.onLog?.((l) => (l.level === "error" || l.level === "warn") && console.log(`     [worker ${l.level}] ${l.args.join(" ").slice(0, 200)}`));

await step("anon-rpc worker boots", async () => {
  await Promise.race([gw.backend.ready, new Promise((_, rej) => setTimeout(() => rej(new Error(`not ready after ${values["boot-timeout"]} ms: ${JSON.stringify(gw.backend.status())}`)), Number(values["boot-timeout"])))]);
  const s = gw.backend.status();
  return `${s.network} ready in ${s.bootMs} ms`;
});

const rpc = async (chain, body) => {
  const r = await fetch(gw.rpcUrl(chain), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
};

await step("anon path serves reads", async () => {
  const chain = Object.keys(cfg.chains)[0];
  const end = Date.now() + Number(values["serve-timeout"]);
  let tries = 0;
  for (;;) {
    tries++;
    const r = await rpc(chain, { jsonrpc: "2.0", id: 1, method: "eth_blockNumber" }).catch((e) => ({ error: { message: e.message } }));
    if (r.result) break;
    if (Date.now() > end) throw new Error(`no read got through in ${values["serve-timeout"]} ms (${tries} tries): ${JSON.stringify(gw.backend.status().path)}`);
    await new Promise((res) => setTimeout(res, 5000));
  }
  const s = gw.backend.status();
  return `first read through anon-rpc ${s.path.firstOkMs} ms after launch (worker ready at ${s.bootMs ?? "?"} ms) · ${tries} tries`;
});

for (const chain of Object.keys(cfg.chains)) {
  await step(`chain ${chain}: eth_chainId answered locally`, async () => {
    const r = await rpc(chain, { jsonrpc: "2.0", id: 1, method: "eth_chainId" });
    if (BigInt(r.result) !== BigInt(chain)) throw new Error(JSON.stringify(r));
  });
  const lat = [];
  for (let i = 0; i < 3; i++) {
    await step(`chain ${chain}: eth_blockNumber via anon-rpc (#${i + 1})`, async () => {
      const s = Date.now();
      const r = await rpc(chain, { jsonrpc: "2.0", id: 1, method: "eth_blockNumber" });
      if (!r.result) throw new Error(JSON.stringify(r.error ?? r));
      lat.push(Date.now() - s);
      return `block ${BigInt(r.result)}`;
    });
  }
  if (lat.length) line("INFO", `chain ${chain}: read latency over anon-rpc`, `${lat.join(", ")} ms`);
  await step(`chain ${chain}: batch with two wallets (split per wallet)`, async () => {
    const r = await rpc(chain, WALLETS.map((w, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_getBalance", params: [w, "latest"] })));
    if (!Array.isArray(r) || r.some((x) => !x.result)) throw new Error(JSON.stringify(r).slice(0, 200));
    return r.map((x) => `${BigInt(x.result) / 10n ** 15n} mETH`).join(", ");
  });
}

const firstChain = Number(Object.keys(cfg.chains)[0]);
let canary;
await step("SDK connects to the gateway", async () => {
  canary = await createCanary({ gateway: gw.url, wallets: WALLETS, chainId: firstChain });
  return `policy ${canary.policyHash.slice(0, 10)}…`;
});
if (canary) {
  await step("SDK: viem client reads through the gateway", async () => {
    const client = createPublicClient({ chain: { ...sepolia, id: firstChain }, transport: canary.viemTransport() });
    return `block ${await client.getBlockNumber()}`;
  });
  await step("SDK: undeclared host is refused", async () => {
    const r = await canary.fetch("https://example.com/");
    if (r.status !== 403) throw new Error(`expected 403, got ${r.status} (${r.headers.get("x-canary-decision")})`);
    return r.headers.get("x-canary-decision");
  });
  const anonHost = Object.entries(gw.manifest.hosts).find(([h, r]) => r === "anon" && !h.startsWith("*."))?.[0];
  if (anonHost) {
    await step(`SDK: ${anonHost} (declared anon) through anon-rpc`, async () => {
      const r = await canary.fetch(`https://${anonHost}/api/v3/ping`);
      const d = r.headers.get("x-canary-decision");
      if (d !== "anon") throw new Error(`decision ${d}, HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
      return `HTTP ${r.status} from a Tor exit${r.status >= 400 ? " (the API answered with an error: it may refuse Tor exits)" : ""}`;
    });
  }
  await step("SDK: prompt pseudonymized locally", async () => {
    const t = canary.pseudonymizer.redact(`wallet ${WALLETS[0]}`).text;
    if (t !== "wallet WALLET_1") throw new Error(t);
    return t;
  });
}

// ENSv2 on Sepolia, read-only, through the gateway (so over anon-rpc too)
if (cfg.chains["11155111"]) {
  const client = createPublicClient({ chain: sepolia, transport: http(gw.rpcUrl(11155111)) });
  const ur = sepolia.contracts?.ensUniversalResolver?.address;
  await step("ENS Sepolia: Universal Resolver viem uses has code", async () => {
    const code = await client.getCode({ address: ur });
    if (!code || code === "0x") throw new Error(`no code at ${ur}`);
    return `${ur} (${(code.length - 2) / 2} bytes)`;
  });
  const name = values["ens-name"];
  if (name) {
    await step(`ENS Sepolia: ${name} resolves; delegation API`, async () => {
      const resolver = await resolverOf(client, name);
      if (!resolver) throw new Error(`${name} has no resolver`);
      const code = (await client.getCode({ address: resolver })) ?? "0x";
      const has = (sig) => code.includes(toFunctionSelector(sig).slice(2));
      const apis = {
        "setText(bytes,string,string)": has("setText(bytes,string,string)"),
        "authorizeTextRoles(bytes,string,address,bool)": has("authorizeTextRoles(bytes,string,address,bool)"),
        "grantSetterRoles(bytes,address)": has("grantSetterRoles(bytes,address)"),
        "hasRoles(uint256,uint256,address)": has("hasRoles(uint256,uint256,address)"),
      };
      line("INFO", `ENS Sepolia: resolver ${resolver} selectors (proxied resolvers show none)`, JSON.stringify(apis));
      const manifest = await readText(client, name, "privacy.manifest").catch((e) => `error: ${e.shortMessage ?? e.message}`);
      return `privacy.manifest: ${manifest ? String(manifest).slice(0, 80) : "(not set)"}`;
    });
  } else line("INFO", "ENS Sepolia: pass --ens-name <your sepolia name> to probe its resolver");
}

await step("coverage: nothing failed closed, nothing went direct", async () => {
  const c = gw.ledger.counts;
  if (c.rpc.direct || c.http.direct) throw new Error(`direct: ${JSON.stringify(c)}`);
  return `rpc ${JSON.stringify(c.rpc)} · http ${JSON.stringify(c.http)}${c.rpc.failedClosed ? " (some calls failed closed: see FAIL lines)" : ""}`;
});

await finish();

async function finish() {
  const fails = results.filter((r) => r.status === "FAIL").length;
  const passes = results.filter((r) => r.status === "PASS").length;
  console.log(`\n${passes} passed, ${fails} failed · ${Math.round((Date.now() - t0) / 1000)} s`);
  await writeFile(values.out, JSON.stringify({ at: new Date().toISOString(), node: process.version, platform: process.platform, network: cfg.network?.id, passes, fails, results }, null, 2));
  console.log(`summary written to ${values.out}`);
  await canary?.close().catch(() => {});
  await gw?.close().catch(() => {});
  process.exit(fails ? 1 : 0);
}
