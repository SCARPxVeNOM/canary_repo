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

/* Network names well-known providers put in their URLs, exactly as they spell
   them (underscores read as hyphens). Anything not listed is undefined and gets
   probed with eth_chainId: a wrong guess would answer a dapp's reads with
   another chain's data (linea-mainnet is not Ethereum mainnet). */
const NETWORK: Record<string, number> = {
  // Ethereum
  "mainnet": 1, "eth": 1, "ethereum": 1, "eth-mainnet": 1, "ethereum-mainnet": 1,
  "sepolia": 11155111, "eth-sepolia": 11155111, "ethereum-sepolia": 11155111,
  "holesky": 17000, "eth-holesky": 17000, "ethereum-holesky": 17000,
  "hoodi": 560048, "eth-hoodi": 560048, "ethereum-hoodi": 560048,
  // OP Stack and other L2s
  "optimism": 10, "op": 10, "opt-mainnet": 10, "optimism-mainnet": 10,
  "optimism-sepolia": 11155420, "opt-sepolia": 11155420, "op-sepolia": 11155420,
  "base": 8453, "base-mainnet": 8453, "base-sepolia": 84532,
  "arbitrum": 42161, "arb": 42161, "arb-mainnet": 42161, "arbitrum-mainnet": 42161, "arbitrum-one": 42161,
  "arbitrum-sepolia": 421614, "arb-sepolia": 421614,
  "arbitrum-nova": 42170, "arbnova-mainnet": 42170, "arbitrumnova": 42170,
  "zksync": 324, "zksync-era": 324, "zksync-mainnet": 324, "zksync2-era": 324, "zksync-sepolia": 300,
  "linea": 59144, "linea-mainnet": 59144, "linea-sepolia": 59141,
  "scroll": 534352, "scroll-mainnet": 534352, "scroll-sepolia": 534351,
  "blast": 81457, "blast-mainnet": 81457,
  "mantle": 5000, "mantle-mainnet": 5000,
  "zora": 7777777, "zora-mainnet": 7777777,
  "unichain": 130, "unichain-mainnet": 130, "unichain-sepolia": 1301,
  "worldchain": 480, "worldchain-mainnet": 480,
  "soneium": 1868, "soneium-mainnet": 1868, "ink": 57073, "ink-mainnet": 57073,
  "polygon-zkevm": 1101, "polygonzkevm-mainnet": 1101, "taiko": 167000,
  "fraxtal": 252, "frax-mainnet": 252, "mode": 34443, "lisk": 1135, "abstract": 2741, "abstract-mainnet": 2741,
  // other EVM chains
  "polygon": 137, "matic": 137, "polygon-mainnet": 137, "polygon-bor": 137,
  "polygon-amoy": 80002, "amoy": 80002, "polygon-amoy-bor": 80002,
  "bsc": 56, "bnb": 56, "bsc-mainnet": 56, "bnb-mainnet": 56, "binance": 56,
  "bsc-testnet": 97, "bnb-testnet": 97, "bsc-testnet-chapel": 97,
  "opbnb": 204, "opbnb-mainnet": 204,
  "avalanche": 43114, "avax": 43114, "avalanche-mainnet": 43114, "avax-mainnet": 43114, "avalanche-c-chain": 43114,
  "avalanche-fuji": 43113, "avax-fuji": 43113, "avalanche-fuji-c-chain": 43113,
  "gnosis": 100, "gnosis-mainnet": 100, "xdai": 100, "gnosis-chiado": 10200,
  "celo": 42220, "celo-mainnet": 42220,
  "fantom": 250, "sonic": 146, "sonic-mainnet": 146,
  "berachain": 80094, "berachain-mainnet": 80094, "cronos-evm": 25, "sei-evm": 1329, "kava-evm": 2222,
  "flare": 14, "hyperliquid": 999, "pulsechain": 369, "apechain": 33139, "apechain-mainnet": 33139, "metis-mainnet": 1088,
};
const net = (name: string | undefined) => (name ? NETWORK[name.toLowerCase().replace(/_/g, "-")] : undefined);

/** Where each provider spells the network: the first host label, or the first path segment. */
function providerNetwork(u: URL): number | undefined {
  const h = u.hostname.toLowerCase();
  const first = h.split(".")[0];
  const seg = u.pathname.split("/").filter(Boolean)[0];
  if (/\.g\.alchemy\.com$|\.alchemyapi\.io$/.test(h)) return net(first);
  if (/\.infura\.io$/.test(h)) return net(first);
  if (/\.publicnode\.com$/.test(h)) return net(first.replace(/-rpc$/, ""));
  if (/^lb\.drpc\.(org|live)$/.test(h)) return net(u.searchParams.get("network") ?? seg);
  if (/\.drpc\.org$/.test(h)) return net(first);
  if (h === "rpc.ankr.com" || h === "1rpc.io") return net(seg);
  if (/\.llamarpc\.com$|\.gateway\.tenderly\.co$/.test(h)) return net(first);
  if (/\.blastapi\.io$/.test(h)) return net(first);
  if (/^(cloudflare-eth\.com|rpc\.flashbots\.net|eth\.merkle\.io)$/.test(h)) return 1;
  return undefined;
}

/** Chain named by a well-known provider URL; undefined for anything else. */
export function knownChain(url: string): number | undefined {
  const proxied = proxyChain(url);
  if (proxied !== undefined) return proxied;
  try {
    return providerNetwork(new URL(url));
  } catch {
    return undefined;
  }
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
