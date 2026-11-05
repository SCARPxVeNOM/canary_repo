// Test fixtures: a stub chain holding the worker specifier, a "read endpoint",
// an "upstream" provider, plain-HTTP APIs and an LLM stand-in, all on one local
// server and told apart by host name (*.test).
//
// Chromium maps *.test to 127.0.0.1 with --host-resolver-rules; the gateway's
// Node process gets the same mapping by patching dns.lookup (see mapTestHosts).
// The worker is EF's passthrough reference bundle, hash-verified as on chain.

import { createServer } from "node:http";
import dns from "node:dns";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3";

const HERE = import.meta.dirname;
export const SPECIFIER = "0x4fd77be300f31c5fe6ab266d35d27750a3478d27";
export const CHROME = process.env.CHROME_BIN ?? (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
/** How tests launch Chromium: CHROME_BIN, /usr/bin/google-chrome, or the installed Chrome (Playwright channel "chrome"). */
export const CHROME_OPTS = CHROME ? { executablePath: CHROME } : { channel: "chrome" };
export const CHAIN_ID = 11155111;

export function mapTestHosts() {
  const orig = dns.lookup;
  dns.lookup = function (host, opts, cb) {
    if (typeof opts === "function") (cb = opts), (opts = {});
    if (/\.test$/i.test(host)) return opts?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4);
    return orig.call(this, host, opts, cb);
  };
}

const sel = (s) => "0x" + Buffer.from(keccak_256(Buffer.from(s))).toString("hex").slice(0, 8);
const word = (n) => n.toString(16).padStart(64, "0");
const strArr = (ss) => {
  let h = word(32) + word(ss.length), off = "", body = "", cur = ss.length * 32;
  for (const s of ss) {
    const b = Buffer.from(s), p = Math.ceil(b.length / 32) * 32;
    off += word(cur); body += word(b.length) + b.toString("hex").padEnd(p * 2, "0"); cur += 32 + p;
  }
  return "0x" + h + off + body;
};

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };

export const ANSWERS = {
  read: { eth_chainId: "0xaa36a7", eth_blockNumber: "0x222", eth_getBalance: "0x2", eth_call: "0x" + word(2), eth_getCode: "0x6001", eth_sendRawTransaction: "0x" + "ab".repeat(32) },
  upstream: { eth_chainId: "0xaa36a7", eth_blockNumber: "0x111", alchemy_getTokenBalances: { from: "upstream" } },
};

export async function startFixtures() {
  const bundle = await readFile(resolve(HERE, "fixtures/passthrough-worker.js"));
  const workerHash = Buffer.from(keccak_256(bundle)).toString("hex");
  const logs = { read: [], upstream: [], api: [], llm: [], chain: [], big: [] };
  const state = { readDown: false, readDelayMs: 0, chainDown: false };
  let P;
  const rpcAnswer = (answers, m) =>
    answers[m.method] === undefined
      ? { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no ${m.method}` } }
      : { jsonrpc: "2.0", id: m.id, result: answers[m.method] };

  const server = createServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    const origin = req.headers.origin ?? "(none)";
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString();
      if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
      const json = (code, v) => res.writeHead(code, { ...CORS, "content-type": "application/json" }).end(JSON.stringify(v));
      const rpc = (answers, log) => {
        const body = JSON.parse(raw || "{}");
        for (const m of Array.isArray(body) ? body : [body]) log.push({ method: m.method, params: m.params, origin, batch: Array.isArray(body), raw });
        return json(200, Array.isArray(body) ? body.map((m) => rpcAnswer(answers, m)) : rpcAnswer(answers, body));
      };
      switch (host) {
        case "chain.test": {
          logs.chain.push(raw);
          if (state.chainDown) return json(503, { error: "down" });
          if (req.url === "/worker.js") return res.writeHead(200, { ...CORS, "content-type": "text/javascript" }).end(bundle);
          const m = JSON.parse(raw || "{}");
          if (m.method === "eth_chainId") return json(200, { jsonrpc: "2.0", id: m.id, result: "0x1" });
          if (m.params?.[0]?.data === sel("workerHash()")) return json(200, { jsonrpc: "2.0", id: m.id, result: "0x" + workerHash });
          if (m.params?.[0]?.data === sel("workerResolvers()")) return json(200, { jsonrpc: "2.0", id: m.id, result: strArr([`http://chain.test:${P}/worker.js`]) });
          return json(404, {});
        }
        case "read.test":
          if (state.readDown) return json(503, { error: "down" });
          if (state.readDelayMs) await new Promise((r) => setTimeout(r, state.readDelayMs));
          return rpc(ANSWERS.read, logs.read);
        case "upstream.test":
          return rpc(ANSWERS.upstream, logs.upstream);
        case "big.test": {
          // a large body, to check streaming across the bridge
          const n = Number(new URL(req.url, "http://x").searchParams.get("mb") ?? 8);
          logs.big.push(req.url);
          const block = Buffer.alloc(1024 * 1024, 0x61);
          res.writeHead(200, { ...CORS, "content-type": "application/octet-stream", "content-length": String(n * block.length) });
          for (let i = 0; i < n; i++) res.write(block);
          return res.end();
        }
        case "api.test":
        case "anon-api.test":
        case "undeclared.test":
          logs.api.push({ host, url: req.url, method: req.method, body: raw, origin });
          return json(200, { host, ok: true });
        case "llm.test": {
          logs.llm.push({ url: req.url, body: raw });
          const reply = JSON.parse(raw || "{}").reply ?? "ok";
          return json(200, { id: "x", choices: [{ message: { role: "assistant", content: reply } }] });
        }
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  P = server.address().port;
  const url = (host, path = "/") => `http://${host}:${P}${path}`;
  return {
    port: P,
    url,
    logs,
    state,
    reset: () => Object.values(logs).forEach((l) => (l.length = 0)),
    network: { id: "passthrough", label: "passthrough (test)", specifier: SPECIFIER, bootstrapRpc: url("chain.test") },
    // --no-proxy-server: sandboxes that set HTTPS_PROXY would otherwise send the fixtures through it
    chromiumArgs: ["--host-resolver-rules=MAP *.test 127.0.0.1", "--no-proxy-server"],
    close: () => new Promise((r) => server.close(r)),
  };
}
