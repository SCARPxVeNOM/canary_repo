#!/usr/bin/env node
// One results table across sites, from the reports `scan.mjs --compare` wrote.
//
//   node summary.mjs scans/ > scans/RESULTS.md

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "scans");
const files = await readdir(dir);
const hosts = files.filter((f) => f.endsWith(".baseline.json") && files.includes(f.replace(".baseline.", ".canary."))).map((f) => f.slice(0, -".baseline.json".length));
if (!hosts.length) {
  console.error(`no <host>.baseline.json + <host>.canary.json pairs in ${dir}`);
  process.exit(1);
}

const load = async (h, run) => JSON.parse(await readFile(resolve(dir, `${h}.${run}.json`), "utf8"));
const thirdWithAddress = (r) => r.recipients.filter((x) => x.party === "third" && x.carriedAddress).map((x) => x.host);
const firstWithAddress = (r) => r.recipients.filter((x) => x.party === "first" && x.carriedAddress).reduce((n, x) => n + x.carriedAddress, 0);

const rows = [];
const notes = [];
const scanners = new Set();
for (const h of hosts) {
  const [a, b] = [await load(h, "baseline"), await load(h, "canary")];
  scanners.add(a.scanner.hash).add(b.scanner.hash);
  const c = b.canary?.counts ?? {};
  const lat = b.canary?.latencyMs;
  rows.push(
    `| ${new URL(a.url).host} | ${thirdWithAddress(a).length} → **${thirdWithAddress(b).length}** | ${a.rpc.directCalls} → **${b.rpc.directCalls}** | ${b.rpc.viaAnonRpc} | ${a.rpc.coveragePct ?? "—"}% → **${b.rpc.coveragePct ?? "—"}%** | ${c.blocked ?? 0} | ${firstWithAddress(a)} → ${firstWithAddress(b)} | ${c.failedClosed ?? 0} | ${lat ? `${lat.p50} ms (n=${lat.n})` : "—"} |`,
  );
  notes.push(`- **${new URL(a.url).host}**: before, the address reached ${thirdWithAddress(a).map((x) => `\`${x}\``).join(", ") || "no third party"}. Flows: ${b.flows.slice(1).join(" → ")}.${b.canary?.notes?.length ? ` Canary noted: ${b.canary.notes.join("; ")}.` : ""}`);
}

console.log(
  [
    "| Dapp | Third parties that got the address | RPC calls leaving the page directly | via anon-rpc | Coverage | Blocked | First-party requests with the address | Failed closed | anon-rpc latency p50 |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "Before → **with Canary**. Each run used a fresh synthetic address. Blocked, failed closed and latency are Canary's own counts from the with-Canary run.",
    "",
    ...notes,
    "",
    `Scanner ${[...scanners].map((s) => `\`${s}\``).join(", ")}. Not inspected: service workers' own traffic, WebRTC, encrypted or arbitrarily obfuscated payloads, flows beyond load → connect → scroll. "No leak observed" is not "no leak".`,
  ].join("\n"),
);
