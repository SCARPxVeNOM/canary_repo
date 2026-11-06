#!/usr/bin/env node
// Point every default config at your tor-js gateways, in one step.
//
//   npm run gateways -- <ip:port:certhash> [<ip:port:certhash> ...] [--with-ef]
//
// Writes `network.workerConfig.gateways` in:
//   extension/config/live.json                 (what `npm run build` in extension/ uses)
//   examples/viem-agent/canary.config.json     (`npm run gateway`)
//   examples/viem-agent/canary.ens.config.json (`npm run gateway:ens`)
//
// Get an address by running a gateway (gateway/README.md): `docker logs canary-gateway`
// prints it. --with-ef appends EF's demo gateway as a last resort (it was not
// completing boots on 6 Nov 2026; test-repo.md §19). Then rebuild the extension.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const EF = "152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ";
const FILES = ["extension/config/live.json", "examples/viem-agent/canary.config.json", "examples/viem-agent/canary.ens.config.json"];
// ip(v4 or [v6]):port:multibase certhash, as tor-js-gateway prints it
const ADDRESS = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):\d{1,5}:u[A-Za-z0-9_-]{40,}$/;

const args = process.argv.slice(2);
const withEf = args.includes("--with-ef");
const gateways = args.filter((a) => !a.startsWith("--"));
const bad = gateways.filter((g) => !ADDRESS.test(g));
if (!gateways.length || bad.length) {
  console.error(`usage: npm run gateways -- <ip:port:certhash> [...] [--with-ef]${bad.length ? `\nnot a gateway address: ${bad.join(", ")}` : ""}`);
  process.exit(2);
}
const list = [...new Set([...gateways, ...(withEf ? [EF] : [])])];

for (const f of FILES) {
  const path = resolve(ROOT, f);
  const cfg = JSON.parse(await readFile(path, "utf8"));
  cfg.network.workerConfig = { ...(cfg.network.workerConfig ?? {}), gateways: list };
  cfg.network.label = withEf ? "tor-js (own gateways + EF)" : "tor-js (own gateways)";
  await writeFile(path, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`${f}: ${list.length} gateway${list.length > 1 ? "s" : ""}`);
}
console.log("\nRebuild the extension (cd extension && npm run build) and restart any running gateway.");
