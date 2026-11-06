// Find the canary address in captured traffic, in every encoding we claim to
// detect (idea.md §3.2). Exact matching only: we generated the address, so a
// hit is never a coincidence.

import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha2";

const hex = (b) => Buffer.from(b).toString("hex");
const b64 = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "");
const b64url = (b) => Buffer.from(b).toString("base64url");

export function checksum(addr) {
  const h = addr.toLowerCase().replace(/^0x/, "");
  const k = hex(keccak_256(Buffer.from(h, "ascii")));
  return "0x" + [...h].map((c, i) => (parseInt(k[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
}

/** Every needle for one address. `lower` needles are searched case-insensitively. */
export function needles(address) {
  const h = address.toLowerCase().replace(/^0x/, "");
  const raw = Buffer.from(h, "hex");
  const cs = checksum(address);
  const asciiForms = { "0x-lower": "0x" + h, "no-0x": h, checksummed: cs };
  const list = [{ encoding: "hex", needle: h, lower: true }]; // covers lowercase, checksummed, no-0x, ABI-padded, URL-encoded
  for (const [name, s] of Object.entries(asciiForms)) {
    list.push({ encoding: `base64(${name})`, needle: b64(Buffer.from(s)), lower: false });
    list.push({ encoding: `keccak256(${name})`, needle: hex(keccak_256(Buffer.from(s))), lower: true });
    list.push({ encoding: `sha256(${name})`, needle: hex(sha256(Buffer.from(s))), lower: true });
  }
  list.push({ encoding: "base64(raw)", needle: b64(raw), lower: false });
  list.push({ encoding: "base64url(raw)", needle: b64url(raw), lower: false });
  list.push({ encoding: "keccak256(raw)", needle: hex(keccak_256(raw)), lower: true });
  list.push({ encoding: "sha256(raw)", needle: hex(sha256(raw)), lower: true });
  return { raw, list };
}

/** All encodings of the address found in a string (URL, body, or WS frame). */
export function match(text, n) {
  if (!text) return [];
  if (text.startsWith("base64:")) {
    // binary body: look for the raw 20 bytes and the ASCII forms in the bytes
    const buf = Buffer.from(text.slice(7), "base64");
    const hits = [];
    if (buf.includes(n.raw)) hits.push("raw bytes");
    hits.push(...match(buf.toString("latin1"), { ...n, raw: Buffer.alloc(0) }));
    return [...new Set(hits)];
  }
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    /* keep as is */
  }
  const lower = decoded.toLowerCase();
  const hits = [];
  for (const { encoding, needle, lower: ci } of n.list) {
    if (ci ? lower.includes(needle) : decoded.includes(needle) || text.includes(needle)) hits.push(encoding);
  }
  return hits;
}

/* --- classification ------------------------------------------------------ */

const MULTI_SUFFIX = new Set(["co.uk", "com.au", "co.in", "co.jp", "github.io", "vercel.app", "netlify.app", "pages.dev", "web.app", "eth.limo", "eth.link", "workers.dev"]);
export function site(host) {
  const h = host.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || !h.includes(".")) return h;
  const p = h.split(".");
  const last2 = p.slice(-2).join(".");
  return MULTI_SUFFIX.has(last2) && p.length >= 3 ? p.slice(-3).join(".") : last2;
}

const ANALYTICS = /(google-analytics|googletagmanager|segment\.(io|com)|mixpanel|amplitude|posthog|sentry|hotjar|datadoghq|fullstory|heap(analytics)?|plausible|clarity\.ms|intercom|walletconnect\.(org|com)\/.*(pulse|analytics)|pulse\.walletconnect|doubleclick|facebook\.net|tracker)/i;
const ANALYTICS_PATH = /\/(collect|track|event|events|analytics|pixel|p\.gif|beacon|identify|log|telemetry|v\d\/(t|e|i|identify))\b/i;

export function isJsonRpc(body) {
  if (!body || !/^\s*[[{]/.test(body)) return null;
  try {
    const v = JSON.parse(body);
    // Also JSON-RPC methods in a custom envelope, e.g. {chainId, method, params} to a dapp's own RPC proxy.
    const wrapped = (x) => /^(eth|net|web3)_\w+$/.test(x.method) && Array.isArray(x.params);
    const one = (x) => x && typeof x === "object" && typeof x.method === "string" && (x.jsonrpc === "2.0" || wrapped(x));
    if (Array.isArray(v)) return v.length && v.every(one) ? v.map((x) => x.method) : null;
    return one(v) ? [v.method] : null;
  } catch {
    return null;
  }
}

export function classify(rec, pageHost) {
  const origin = rec.headers?.origin ?? "";
  if (origin === "null") return { kind: "canary-worker", party: "canary" }; // anon-rpc worker using plain fetch (passthrough)
  if (origin.startsWith("chrome-extension://")) return { kind: "extension", party: "canary" };
  // Browser- or extension-initiated (no page involved): e.g. an offscreen document fetching a worker bundle.
  if (!origin && rec.headers?.["sec-fetch-site"] === "none" && rec.headers?.["sec-fetch-dest"] !== "document") return { kind: "extension", party: "canary" };
  const party = site(rec.host) === site(pageHost) ? "first" : "third";
  const methods = isJsonRpc(rec.body);
  if (methods) return { kind: "rpc", party, methods };
  if (ANALYTICS.test(rec.host) || ANALYTICS_PATH.test(new URL(rec.url).pathname)) return { kind: "analytics", party };
  return { kind: "backend", party };
}
