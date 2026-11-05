// Code shared by the shim (page MAIN world), the bridge and the service worker.
// Everything here is deterministic: Canary's classifier is exact matching, not
// heuristics or AI.

export const SUBSTITUTABLE = new Set([
  "eth_call", "eth_getBalance", "eth_blockNumber", "eth_chainId", "eth_getCode", "eth_getStorageAt",
  "eth_getTransactionCount", "eth_estimateGas", "eth_gasPrice", "eth_feeHistory", "eth_maxPriorityFeePerGas",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionReceipt", "eth_getTransactionByHash",
  "eth_getLogs", "net_version", "eth_blobBaseFee",
]);

export type RpcCall = { jsonrpc: "2.0"; id?: unknown; method: string; params?: unknown };

/** The calls in a JSON-RPC request body (single or batch), or null if it isn't one. */
export function parseJsonRpc(text: string): RpcCall[] | null {
  if (!text || (text[0] !== "{" && text[0] !== "[" && !/^\s*[[{]/.test(text))) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const one = (x: any) => !!x && typeof x === "object" && x.jsonrpc === "2.0" && typeof x.method === "string";
  if (Array.isArray(v)) return v.length > 0 && v.every(one) ? (v as RpcCall[]) : null;
  return one(v) ? [v as RpcCall] : null;
}

/* --- your address, in the encodings we check -------------------------------

   We know the exact address, so this is exact matching. A case-insensitive
   search for the 40 hex digits covers lowercase, checksummed, without 0x,
   32-byte ABI-padded and URL-encoded forms (hex digits are never escaped).
   Base64 of the raw 20 bytes and of the hex string are checked separately.
   Hashes (keccak256/sha256 of the address) are the scanner's job. */

export type Taint = { address: string; encoding: string };

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const hexToBytes = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const strip = (s: string) => s.replace(/=+$/, "");
const urlSafe = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_");

export type AddressNeedles = { address: string; hex: string; b64: string[] };

export function needlesFor(address: string): AddressNeedles {
  const hex = address.toLowerCase().replace(/^0x/, "");
  const raw = strip(b64(hexToBytes(hex)));
  const str0x = strip(btoa("0x" + hex));
  const str = strip(btoa(hex));
  // base64 of a string shifts with its offset, so these only catch the
  // address encoded on its own (the common case for analytics payloads).
  return { address: "0x" + hex, hex, b64: [...new Set([raw, urlSafe(raw), str0x, str])] };
}

export function findAddress(haystack: string, needles: AddressNeedles[]): Taint | null {
  if (!haystack || needles.length === 0) return null;
  const lower = haystack.toLowerCase();
  for (const n of needles) {
    if (lower.includes(n.hex)) return { address: n.address, encoding: "hex" };
    for (const b of n.b64) if (haystack.includes(b)) return { address: n.address, encoding: "base64" };
  }
  return null;
}

/* --- first party or third party -------------------------------------------

   Registrable domain = the last two labels, or three when the last two are a
   known multi-label public suffix. A small list, not the full PSL: enough for
   the hosting platforms dapps actually use. IPs and single-label hosts are
   their own site. Ports are ignored, as browsers do for "site". */

const MULTI_SUFFIX = new Set([
  "co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.in", "co.jp", "com.br", "co.kr", "com.sg",
  "github.io", "vercel.app", "netlify.app", "pages.dev", "web.app", "firebaseapp.com", "herokuapp.com",
  "eth.limo", "eth.link", "ipfs.io", "on-fleek.app", "workers.dev", "fly.dev", "onrender.com", "replit.app",
]);

export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":") || !h.includes(".")) return h;
  const parts = h.split(".");
  const last2 = parts.slice(-2).join(".");
  if (MULTI_SUFFIX.has(last2) && parts.length >= 3) return parts.slice(-3).join(".");
  return last2;
}

export function isThirdParty(pageHost: string, requestHost: string): boolean {
  return registrableDomain(pageHost) !== registrableDomain(requestHost);
}

/* --- which chain is an RPC URL on? ------------------------------------------

   Only for well-known providers whose URLs name the chain. A wrong guess would
   return another chain's data, so anything else is probed instead. */

const KNOWN_PROVIDER = /(alchemy\.com|infura\.io|drpc\.(org|live)|publicnode\.com|ankr\.com|llamarpc\.com|1rpc\.io|blastapi\.io|quiknode\.pro|chainstack\.com|tenderly\.co|cloudflare-eth\.com|merkle\.io|flashbots\.net)/i;
const CHAIN_PATTERNS: [RegExp, number][] = [
  [/base[-_]?sepolia/i, 84532],
  [/arb(itrum)?[-_]?sepolia/i, 421614],
  [/(op|optimism)[-_]?sepolia/i, 11155420],
  [/sepolia/i, 11155111],
  [/holesky/i, 17000],
  [/hoodi/i, 560048],
  [/base/i, 8453],
  [/arb(itrum)?/i, 42161],
  [/(optimism|opt-mainnet)/i, 10],
  [/(polygon|matic)/i, 137],
  [/(eth-mainnet|ethereum|mainnet|\/eth(\/|$)|cloudflare-eth|flashbots|merkle\.io|llamarpc)/i, 1],
];

export function knownChain(url: string): number | undefined {
  if (!KNOWN_PROVIDER.test(url)) return undefined;
  for (const [re, id] of CHAIN_PATTERNS) if (re.test(url)) return id;
  return undefined;
}

/* --- coverage categories (idea.md §4) --- */

export type Category =
  | "protected" // answered via anon-rpc from our read endpoint
  | "protectedIpOnly" // forwarded via anon-rpc to the dapp's own URL
  | "blocked" // third-party request carrying your address
  | "detected" // carries your address, left as-is (first party, or a channel we can't substitute)
  | "backend" // non-RPC API traffic, listed by destination
  | "notInspected" // a body or channel we could not read
  | "failedClosed" // anon path down: answered with an error instead of going direct
  | "direct"; // anon path down and you allowed direct requests on this site

export const CATEGORY_LABEL: Record<Category, string> = {
  protected: "Protected",
  protectedIpOnly: "Protected (IP only)",
  blocked: "Blocked",
  detected: "Detected, unprotected",
  backend: "Backend / indexer",
  notInspected: "Not inspected",
  failedClosed: "Failed closed",
  direct: "Direct (you allowed it)",
};

export type Observation = {
  category: Category;
  channel: "fetch" | "xhr" | "websocket" | "beacon" | "url";
  host: string;
  firstParty: boolean;
  /** which of your addresses it carried, if any */
  address?: string;
  encoding?: string;
  methods?: string[];
  ms?: number;
  note?: string;
};
