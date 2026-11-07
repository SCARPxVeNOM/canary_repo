// LeakyDash demo server. One process, four "parties", told apart by hostname.
// *.localhost resolves to this machine in every modern browser, and each name
// is its own site, so the browser (and Canary) treats them as different parties:
//
//   http://leakydash.localhost:3000        the dapp (first party) + its /api/points backend + /logs
//   http://rpc.provider.localhost:3000     "the dapp's RPC provider": logs, then forwards upstream
//   http://tracker.localhost:3000          "analytics": logs whatever it is sent
//
// Every party logs what it received (source IP, Origin, which addresses were in
// it), and /logs shows the three side by side. Nothing is stored on disk.
//
//   PORT=3000 UPSTREAM_RPC=https://ethereum-sepolia-rpc.publicnode.com node server.mjs
//
// Deployed (api/index.mjs, vercel.json), the parties are three hostnames of one
// deployment, set with LEAKYDASH_DAPP_HOST, LEAKYDASH_PROVIDER_HOST and
// LEAKYDASH_TRACKER_HOST (e.g. three *.vercel.app names: vercel.app is a public
// suffix, so each is its own site). There, /logs shows each visitor only their own
// entries: the dapp tags its requests with a random per-browser id (`sid`). Not by
// IP: some networks send each destination out through a different public address.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 3000);
const UPSTREAM = process.env.UPSTREAM_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const HOSTS = {
  dapp: process.env.LEAKYDASH_DAPP_HOST ?? "leakydash.localhost",
  provider: process.env.LEAKYDASH_PROVIDER_HOST ?? "rpc.provider.localhost",
  tracker: process.env.LEAKYDASH_TRACKER_HOST ?? "tracker.localhost",
};
const LOCAL = HOSTS.dapp.endsWith(".localhost");
const ORIGIN = (host) => (LOCAL ? `http://${host}:${PORT}` : `https://${host}`);

/** The dapp bundle. It reads __PROVIDER__ and __TRACKER__, which are prepended when it's served. */
export async function bundleApp() {
  const { build } = await import("esbuild");
  const out = await build({
    entryPoints: [resolve(HERE, "src/app.ts")],
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", minify: false, logLevel: "warning",
  });
  return out.outputFiles[0].text;
}
// The pages name the parties; serve them with this deployment's names.
const page = async (name) =>
  (await readFile(resolve(HERE, "static", name), "utf8")).replaceAll("rpc.provider.localhost", HOSTS.provider).replaceAll("tracker.localhost", HOSTS.tracker);

/* --- logs --------------------------------------------------------------- */

const LOG_MAX = 300;
const logs = { provider: [], tracker: [], backend: [] };
let seq = 0;
// Deployed, each serverless instance keeps its own in-memory log, and a /api/logs
// read can land on any of them. Ids are unique across instances so the viewer can
// merge what every instance returns over successive polls (logs.html).
const INSTANCE = randomUUID().slice(0, 8);
// Contracts the dapp itself calls; not "your address".
const KNOWN_CONTRACTS = new Set([
  "0xca11bde05977b3631167028862be2a173976ca11", // Multicall3
  "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238", // USDC (Sepolia)
  "0xfff9976782d46cc05630d1f6ebab18b2324d6b14", // WETH (Sepolia)
  "0x779877a7b0d9e8603169ddbd7836e478b4624789", // LINK (Sepolia)
]);
/** Every user address any party has seen in plain form. Used to find the same
 *  address again where it's hidden, e.g. ABI-encoded inside eth_call calldata. */
const seenUsers = new Set();
function findAddresses(text) {
  const lower = text.toLowerCase();
  const plain = [...lower.matchAll(/0x[0-9a-f]{40}(?![0-9a-f])/g)].map((m) => m[0]).filter((a) => !KNOWN_CONTRACTS.has(a));
  for (const a of plain) seenUsers.add(a);
  const b64 = (a) => Buffer.from(a.slice(2), "hex").toString("base64").replace(/=+$/, "");
  const hidden = [...seenUsers].filter((a) => !plain.includes(a) && (lower.includes(a.slice(2)) || text.includes(b64(a))));
  return [...new Set([...plain, ...hidden])];
}
const clientIp = (req) => (req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").toString().split(",")[0].trim().replace(/^::ffff:/, "");
/** The visitor's id from LeakyDash's own requests: ?sid= or a JSON body's "sid". */
function sidOf(req, body) {
  const q = new URL(req.url ?? "/", "http://x").searchParams.get("sid");
  if (q) return q;
  try {
    const b = JSON.parse(body || "null");
    return typeof b?.sid === "string" ? b.sid : undefined;
  } catch {
    return undefined;
  }
}
function log(party, req, extra) {
  const text = `${decodeURIComponent(req.url ?? "")} ${extra.body ?? ""}`;
  const addresses = findAddresses(text);
  const entry = {
    id: `${INSTANCE}-${++seq}`,
    at: Date.now(),
    sid: sidOf(req, extra.body),
    ip: clientIp(req),
    origin: req.headers.origin ?? "(none)",
    ua: (req.headers["user-agent"] ?? "").toString().slice(0, 80),
    path: req.url,
    ...extra,
    body: undefined,
    addresses,
  };
  logs[party].push(entry);
  if (logs[party].length > LOG_MAX) logs[party].shift();
  const who = addresses.length ? ` addr=${addresses.map((a) => a.slice(0, 8) + "…").join(",")}` : "";
  console.log(`[${party}] ${entry.ip} origin=${entry.origin} ${extra.methods?.join(",") ?? entry.path}${who}`);
}

/* --- server ------------------------------------------------------------- */

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** The request handler for all parties; `appJs` is bundleApp()'s output. */
export const createHandler = (appJs) => (req, res) => {
  const host = (req.headers["x-forwarded-host"] ?? req.headers.host ?? "").toString().split(":")[0].toLowerCase();
  // Deployed, the log viewer is public: each visitor sees only entries with their own id.
  const viewer = new URL(req.url ?? "/", "http://x").searchParams.get("sid");
  const mine = (e) => LOCAL || (!!viewer && e.sid === viewer);
  let raw = "";
  req.on("data", (d) => {
    if (raw.length < 1_000_000) raw += d;
  });
  req.on("end", async () => {
    try {
      if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
      const json = (code, v, h = {}) => res.writeHead(code, { ...CORS, "content-type": "application/json", ...h }).end(JSON.stringify(v));

      if (host === HOSTS.provider) {
        // "The dapp's RPC provider": record, then answer from a real node.
        let methods = [];
        try {
          const b = JSON.parse(raw || "{}");
          methods = (Array.isArray(b) ? b : [b]).map((m) => m.method);
        } catch {
          /* not JSON-RPC */
        }
        log("provider", req, { methods, body: raw });
        const up = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: raw || "{}" });
        return res.writeHead(up.status, { ...CORS, "content-type": "application/json" }).end(await up.text());
      }

      if (host === HOSTS.tracker) {
        // "Analytics": records whatever it is sent.
        log("tracker", req, { body: raw, kind: req.url.startsWith("/p.gif") ? "pixel" : req.method === "POST" ? "event" : "get" });
        if (req.url.startsWith("/p.gif")) return res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" }).end(PIXEL);
        return res.writeHead(204, CORS).end();
      }

      if (host === HOSTS.dapp || (LOCAL && host === "localhost")) {
        const url = new URL(req.url, "http://x");
        switch (url.pathname) {
          case "/":
            return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(await page("index.html"));
          case "/logs":
            return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(await page("logs.html"));
          case "/style.css":
            return res.writeHead(200, { "content-type": "text/css" }).end(await page("style.css"));
          case "/app.js":
            return res
              .writeHead(200, { "content-type": "text/javascript" })
              .end(`const __PROVIDER__ = ${JSON.stringify(ORIGIN(HOSTS.provider) + "/")}, __TRACKER__ = ${JSON.stringify(ORIGIN(HOSTS.tracker))};\n${appJs}`);
          case "/api/points": {
            // First-party backend: sees your address by design.
            log("backend", req, {});
            const a = url.searchParams.get("address") ?? "";
            const pts = a ? parseInt(a.slice(-4), 16) % 1000 : 0;
            return json(200, { address: a, points: pts });
          }
          case "/api/logs": {
            const shown = Object.fromEntries(Object.entries(logs).map(([k, v]) => [k, v.filter(mine).map(({ sid, ...e }) => e)]));
            return json(200, { since: Number(url.searchParams.get("since") ?? 0), logs: shown, instance: INSTANCE, upstream: UPSTREAM, port: PORT }, { "cache-control": "no-store" });
          }
          case "/api/logs/clear":
            for (const k of Object.keys(logs)) logs[k] = logs[k].filter((e) => !mine(e));
            return json(200, { ok: true });
          case "/.well-known/canary.json":
            // Origin → ENS binding (docs/design-notes.md §3.3): leakydash.eth on ENSv2 Sepolia, whose url record points back here.
            return json(200, { ens: process.env.LEAKYDASH_ENS ?? "leakydash.eth" });
        }
      }
      // Deployed, any other name (e.g. the deployment's own URL) goes to the dapp.
      if (!LOCAL) return res.writeHead(308, { location: `${ORIGIN(HOSTS.dapp)}${req.url}` }).end();
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(502, CORS).end(String(e?.message ?? e));
    }
  });
};

// `node server.mjs`: bundle the dapp and serve every party on PORT.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer(createHandler(await bundleApp())).listen(PORT, () => {
    console.log(`LeakyDash   ${ORIGIN(HOSTS.dapp)}/`);
    console.log(`Logs        ${ORIGIN(HOSTS.dapp)}/logs`);
    console.log(`Provider    ${ORIGIN(HOSTS.provider)}/  → ${UPSTREAM}`);
    console.log(`Tracker     ${ORIGIN(HOSTS.tracker)}/`);
  });
}
