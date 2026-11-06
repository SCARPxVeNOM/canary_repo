// Offline stub: a fake Sepolia node that also answers the anon-rpc specifier read
// for the passthrough test worker and serves its bundle. Lets you run LeakyDash +
// Canary + the scanner with no network:
//   node scanner/test/stub-chain.mjs &
//   (cd leakydash && UPSTREAM_RPC=http://127.0.0.1:8546 npm start) &
//   (cd extension && node build.mjs --config ../scanner/canary-offline.config.json --out ../scanner/canary-offline-dist)
//   (cd scanner && node scan.mjs http://leakydash.localhost:3000/ --compare --canary canary-offline-dist --chain 0xaa36a7 --manifest ../leakydash/privacy.manifest.json)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3";
const bundle = readFileSync(new URL("../../extension/test/fixtures/passthrough-worker.js", import.meta.url));
const H = Buffer.from(keccak_256(bundle)).toString("hex");
const sel = (s) => "0x" + Buffer.from(keccak_256(Buffer.from(s))).toString("hex").slice(0, 8);
const word = (n) => n.toString(16).padStart(64, "0");
const strArr = (ss) => { let h = word(32) + word(ss.length), off = "", body = "", cur = ss.length * 32; for (const s of ss) { const b = Buffer.from(s), p = Math.ceil(b.length / 32) * 32; off += word(cur); body += word(b.length) + b.toString("hex").padEnd(p * 2, "0"); cur += 32 + p; } return "0x" + h + off + body; };
const PORT = Number(process.env.STUB_PORT ?? 8546);
const A = { eth_chainId: "0xaa36a7", eth_blockNumber: "0x7a1200", eth_gasPrice: "0x3b9aca00", eth_getBalance: "0xde0b6b3a7640000", net_version: "11155111" };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
const s = createServer((q, r) => { let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => {
  if (q.method === "OPTIONS") return r.writeHead(204, CORS).end();
  if (q.url === "/worker.js") return r.writeHead(200, { ...CORS, "content-type": "text/javascript" }).end(bundle);
  const body = JSON.parse(b || "{}");
  const one = (m) => {
    const data = m.params?.[0]?.data;
    if (m.method === "eth_call" && data === sel("workerHash()")) return { jsonrpc: "2.0", id: m.id, result: "0x" + H };
    if (m.method === "eth_call" && data === sel("workerResolvers()")) return { jsonrpc: "2.0", id: m.id, result: strArr([`http://127.0.0.1:${PORT}/worker.js`]) };
    return A[m.method] !== undefined ? { jsonrpc: "2.0", id: m.id, result: A[m.method] } : { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "stub: " + m.method } };
  };
  r.writeHead(200, { "content-type": "application/json", ...CORS }); r.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body))); }); });
s.listen(PORT, "127.0.0.1", () => console.log("stub on", s.address().port));
