import { createRequire } from "node:module";
const require = createRequire((process.env.ANON_RPC_IMPL ?? "../../../anon-rpc/impl/") + "package.json");
const { keccak_256 } = require("@noble/hashes/sha3");
const hex = (b) => Buffer.from(b).toString("hex");
const sel = (s) => "0x" + hex(keccak_256(new TextEncoder().encode(s))).slice(0, 8);
const RPC = "https://ethereum-rpc.publicnode.com", TO = "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e";
const call = async (data) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: TO, data }, "latest"] }) })).json()).result;
const hash = await call(sel("workerHash()"));
const raw = Buffer.from((await call(sel("workerResolvers()"))).slice(2), "hex");
const n = Number(raw.readBigUInt64BE(56)); const urls = [];
for (let i = 0; i < n; i++) { const off = 64 + Number(raw.readBigUInt64BE(64 + i * 32 + 24)); const len = Number(raw.readBigUInt64BE(off + 24)); urls.push(raw.slice(off + 32, off + 32 + len).toString()); }
console.log("workerHash", hash); console.log("resolvers", urls);
const u = urls.find((x) => x.startsWith("https:"));
let t = performance.now(); const r = await fetch(u); const bytes = new Uint8Array(await r.arrayBuffer()); const dl = performance.now() - t;
t = performance.now(); const h = "0x" + hex(keccak_256(bytes)); const kms = performance.now() - t;
const text = new TextDecoder().decode(bytes);
let b64 = null; { const m = text.indexOf("AGFzbQ"); if (m >= 0) { let e = m; while (e < text.length && /[A-Za-z0-9+/=]/.test(text[e])) e++; b64 = [text.slice(m, e)]; } }
let wasm = null, cms = 0;
if (b64) { wasm = Buffer.from(b64[0], "base64"); t = performance.now(); await WebAssembly.compile(wasm); cms = performance.now() - t; }
console.log(JSON.stringify({ bundleBytes: bytes.length, encoding: r.headers.get("content-encoding"), downloadMs: Math.round(dl), keccakMs: Math.round(kms), hashMatches: h === hash, embeddedWasmBytes: wasm?.length, wasmMagic: wasm ? hex(wasm.slice(0, 4)) : null, wasmCompileMs: Math.round(cms) }));
