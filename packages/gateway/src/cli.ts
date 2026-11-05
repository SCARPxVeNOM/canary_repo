#!/usr/bin/env node
/* canary-gateway --config canary.config.json

   Config (JSON): GatewayConfig plus `manifestFile` (path to a manifest JSON).
   The report key comes from CANARY_REPORT_KEY, never from the config file. */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createGateway } from "./gateway.js";

const { values } = parseArgs({ options: { config: { type: "string", short: "c" } } });
if (!values.config) {
  console.error("usage: canary-gateway --config canary.config.json");
  process.exit(2);
}
const path = resolve(values.config);
const cfg = JSON.parse(await readFile(path, "utf8"));
if (cfg.manifestFile) cfg.manifest = JSON.parse(await readFile(resolve(dirname(path), cfg.manifestFile), "utf8"));
if (process.env.CANARY_REPORT_KEY) cfg.reportKey = process.env.CANARY_REPORT_KEY;

const gw = await createGateway(cfg);
const s = gw.backend.status();
console.log(`canary gateway ${gw.manifest.agent ?? ""}`.trim());
console.log(`  backend   ${s.backend} · ${s.network} · ${s.state}`);
for (const id of Object.keys(cfg.chains)) console.log(`  RPC_URL   ${gw.rpcUrl(id)}   (chain ${id})`);
if (gw.proxyUrl) console.log(`  PROXY     ${gw.proxyUrl}   (HTTPS_PROXY / HTTP_PROXY; HTTPS is direct/block per host)`);
console.log(`  policy    ${gw.policyHash}  undeclared hosts: ${gw.manifest.undeclared}`);
console.log(`  report    ${gw.url}/canary/report`);
gw.backend.onLog?.((l) => (l.level === "warn" || l.level === "error") && console.warn(`[anon-rpc ${l.level}]`, ...l.args));
gw.backend.ready.then(
  () => console.log(`  anon-rpc worker ready in ${gw.backend.status().bootMs} ms`),
  (e) => console.error(`  anon-rpc worker failed: ${e.message} (requests fail closed)`),
);
const stop = async () => (await gw.close(), process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
