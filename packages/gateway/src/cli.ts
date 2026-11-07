#!/usr/bin/env node
/* canary-gateway --config canary.config.json
   canary-gateway ca [--dir ~/.canary/ca]     create/show the opt-in MITM CA and how to trust it

   Config (JSON): GatewayConfig plus `manifestFile` (path to a manifest JSON).
   With `ens` and no manifest, the policy is read from the agent's ENS name.
   The report key comes from CANARY_REPORT_KEY, never from the config file. */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createGateway } from "./gateway.js";
import { loadOrCreateCa } from "./mitm.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: "string", short: "c" }, dir: { type: "string" }, help: { type: "boolean", short: "h" } } });
const USAGE = "usage: canary-gateway --config canary.config.json | canary-gateway ca [--dir path]";
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (positionals[0] === "ca") {
  const { files, created } = await loadOrCreateCa(values.dir);
  console.log(`${created ? "created" : "found"} Canary's local CA in ${files.dir} (key stays there, mode 0600)
Trust it in the agent's runtime only, then set "mitm": true in the gateway config:
  Node:          NODE_EXTRA_CA_CERTS=${files.cert}
  Python/requests REQUESTS_CA_BUNDLE=${files.bundle}
  OpenSSL/curl:  SSL_CERT_FILE=${files.bundle}   CURL_CA_BUNDLE=${files.bundle}
and point the agent at the proxy: HTTPS_PROXY=http://127.0.0.1:18080`);
  process.exit(0);
}
if (!values.config) {
  console.error(USAGE);
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
if (gw.proxyUrl) console.log(`  PROXY     ${gw.proxyUrl}   (HTTPS_PROXY / HTTP_PROXY; ${gw.ca ? `HTTPS inspected with the local CA ${gw.ca.cert}` : "HTTPS is direct/block per host; see `canary-gateway ca`"})`);
console.log(`  policy    ${gw.policyHash}  undeclared hosts: ${gw.manifest.undeclared}`);
console.log(`  report    ${gw.url}/canary/report`);
if (gw.ens) {
  const e = gw.ens.status;
  console.log(`  ens       ${e.name} (chain ${e.chainId}) · manifest from ${e.manifest.source}${e.reporter ? ` · reporter ${e.reporter}` : " · no report key: reports are not published"}`);
  if (e.reporter) console.log(`  publish   POST ${gw.url}/canary/publish`);
}
gw.backend.onLog?.((l) => (l.level === "warn" || l.level === "error") && console.warn(`[anon-rpc ${l.level}]`, ...l.args));
gw.backend.ready.then(
  () => console.log(`  anon-rpc worker ready in ${gw.backend.status().bootMs} ms`),
  (e) => console.error(`  anon-rpc worker failed: ${e.message} (requests fail closed)`),
);
const stop = async () => (await gw.close(), process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
