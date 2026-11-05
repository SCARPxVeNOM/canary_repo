/* First party or third party, and which chain a provider URL names.
   Used by the browser extension; the agent gateway uses per-host manifest
   rules instead (an agent has no "page"). */

const MULTI_SUFFIX = new Set([
  "co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.in", "co.jp", "com.br", "co.kr", "com.sg",
  "github.io", "vercel.app", "netlify.app", "pages.dev", "web.app", "firebaseapp.com", "herokuapp.com",
  "eth.limo", "eth.link", "ipfs.io", "on-fleek.app", "workers.dev", "fly.dev", "onrender.com", "replit.app",
]);

/** Last two labels, or three for a known multi-label suffix. Not the full PSL. */
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

/** This machine or its private network: no third party can be on the other end. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "::1" ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

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

/** Chain named by a well-known provider URL; undefined for anything else. */
export function knownChain(url: string): number | undefined {
  const proxied = proxyChain(url);
  if (proxied !== undefined) return proxied;
  if (!KNOWN_PROVIDER.test(url)) return undefined;
  for (const [re, id] of CHAIN_PATTERNS) if (re.test(url)) return id;
  return undefined;
}

/* Dapps' own RPC proxies whose path names the chain. Curated, because these
   proxies often can't be probed over Tor: Uniswap's answers 401 to anything
   without its Cloudflare cookies, including its own first request. */
const PROXY_CHAIN: [host: RegExp, path: RegExp][] = [
  [/^entry-gateway\.backend-prod\.api\.uniswap\.org$/i, /^\/rpc\/(\d+)\/?$/],
];
function proxyChain(url: string): number | undefined {
  try {
    const u = new URL(url);
    for (const [host, path] of PROXY_CHAIN) {
      const m = host.test(u.hostname) && u.pathname.match(path);
      if (m) return Number(m[1]);
    }
  } catch {
    /* not a URL */
  }
  return undefined;
}

/** A chain id the URL seems to name (`/rpc/8453`, `?chainId=10`): a hint, used only after a probe failed. */
export function chainHintFromUrl(url: string): number | undefined {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(?:rpc|chains?|networks?|evm)\/(\d{1,10})(?:\/|$)/i) ?? u.search.match(/[?&]chain(?:_?id)?=(\d{1,10})(?:&|$)/i);
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}
