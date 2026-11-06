// What the popup and the dashboard say, in one place. The service worker
// counts nine categories (shared.ts); people get four, plus what wasn't
// counted. Wording follows idea.md §4: never "private", "safe" or "leak-free".

import { compareDeclared, type Category, type DeclaredRow } from "../shared.js";
import { privacyLabel, type PrivacyLabel } from "../privacy-label.js";

declare const chrome: any;

export type Ev = {
  t: number;
  n: number;
  category: Category;
  channel: "fetch" | "xhr" | "websocket" | "beacon" | "url";
  host: string;
  firstParty: boolean;
  address?: string;
  encoding?: string;
  methods?: string[];
  ms?: number;
  note?: string;
  snippet?: string;
  sample?: string;
  via?: string;
};
export type Recipient = {
  host: string;
  firstParty: boolean;
  categories: Partial<Record<Category, number>>;
  channels: string[];
  methods: string[];
  carriedAddress: boolean;
};
export type TabState = {
  origin: string;
  since: number;
  until?: number;
  counts: Record<Category, number>;
  rpcCalls: number;
  recipients: Record<string, Recipient>;
  latencies: number[];
  notes: string[];
  noRequest: number;
  declared?: any;
  events?: Ev[];
  connectedAt?: number;
};
export type Site = { enabled: boolean; allowDirect: boolean; blockHosts: string[] };
export type Settings = { historyDays: number; theme: "system" | "light" | "dark"; connectNotice: boolean };
export type Worker = { state: "idle" | "warming" | "ready" | "failed"; bootMs?: number; error?: string; network: string };
export type SessionSummary = { key: string; live: boolean; tabId?: number; origin: string; since: number; until?: number; counts: Record<Category, number>; ens?: string };

export const send = <T = any>(msg: object): Promise<T> => chrome.runtime.sendMessage(msg);

/* --- the four outcomes -------------------------------------------------- */

export type Bucket = "protected" | "partial" | "blocked" | "exposed";
export const BUCKETS: Bucket[] = ["protected", "partial", "blocked", "exposed"];
export const BUCKET_LABEL: Record<Bucket, string> = { protected: "Protected", partial: "Partial", blocked: "Blocked", exposed: "Exposed" };
export const BUCKET_HINT: Record<Bucket, string> = {
  protected: "Answered through anon-rpc. The dapp's RPC provider never got it, and nobody saw your IP.",
  partial: "Sent to the dapp's own provider through anon-rpc. It saw the request, not your IP.",
  blocked: "Stopped before leaving your browser, or held back because anon-rpc was down.",
  exposed: "Left your browser with your address in it, or from your IP.",
};

/** Which bucket a category counts in. null: not counted (no address in it, a local node, or unreadable). */
export function bucketOf(c: Category): Bucket | null {
  switch (c) {
    case "protected":
      return "protected";
    case "protectedIpOnly":
      return "partial";
    case "blocked":
    case "failedClosed":
      return "blocked";
    case "detected":
    case "direct":
      return "exposed";
    default:
      return null;
  }
}

export type Coverage = Record<Bucket, number> & { total: number; good: number; notInspected: number; other: number };
export function coverage(counts: Record<Category, number> | undefined): Coverage {
  const c = counts ?? ({} as Record<Category, number>);
  const v = (k: Category) => c[k] ?? 0;
  const out = {
    protected: v("protected"),
    partial: v("protectedIpOnly"),
    blocked: v("blocked") + v("failedClosed"),
    exposed: v("detected") + v("direct"),
    notInspected: v("notInspected"),
    other: v("backend") + v("localNode"),
  };
  const total = out.protected + out.partial + out.blocked + out.exposed;
  return { ...out, total, good: out.protected + out.blocked };
}

/* --- one observation, in words ------------------------------------------ */

export type Filter = Bucket | "notInspected" | "other";
export function filterOf(e: Ev): Filter {
  return bucketOf(e.category) ?? (e.category === "notInspected" ? "notInspected" : "other");
}

const METHOD_WORDS: Record<string, string> = {
  eth_getBalance: "balance read",
  eth_call: "contract read",
  eth_blockNumber: "block number",
  eth_chainId: "chain check",
  net_version: "chain check",
  eth_getTransactionCount: "nonce read",
  eth_estimateGas: "gas estimate",
  eth_gasPrice: "fee data",
  eth_feeHistory: "fee data",
  eth_maxPriorityFeePerGas: "fee data",
  eth_getLogs: "event log query",
  eth_getTransactionReceipt: "receipt lookup",
  eth_getTransactionByHash: "transaction lookup",
  eth_getCode: "code lookup",
  eth_getStorageAt: "storage read",
  eth_getBlockByNumber: "block read",
  eth_getBlockByHash: "block read",
  eth_sendRawTransaction: "transaction broadcast",
};
const CHANNEL: Record<Ev["channel"], string> = { fetch: "fetch", xhr: "XHR", websocket: "WebSocket", beacon: "Beacon", url: "Image, script or frame" };

export function channelLabel(e: Ev) {
  if (e.methods?.length) return e.channel === "websocket" ? "RPC over WebSocket" : "RPC";
  return CHANNEL[e.channel] ?? e.channel;
}

/** A short title: the RPC methods, or what kind of request it was. */
export function titleOf(e: Ev): { code?: string; text: string } {
  if (e.methods?.length) {
    const first = e.methods[0];
    const more = e.methods.length > 1 ? ` + ${e.methods.length - 1} more` : "";
    return { code: first, text: `${METHOD_WORDS[first] ?? "call"}${more}` };
  }
  const what = e.channel === "beacon" ? "Beacon" : e.channel === "websocket" ? "WebSocket message" : e.channel === "url" ? "Image, script or frame" : "Request";
  // A URL-rule block has no address field: the rule only matches URLs that carry it.
  if (e.address || e.note === "its URL carried your address") return { text: `${what} carrying your address` };
  if (e.category === "notInspected") return { text: `${what} Canary couldn't read` };
  return { text: `${what} to ${e.firstParty ? "the dapp" : "a third party"}` };
}

/** One plain sentence: what happened and what it means for you. */
export function sentenceOf(e: Ev): string {
  switch (e.category) {
    case "protected":
      return "Canary answered this read through anon-rpc from its own read endpoint. The dapp's RPC provider never got it, and the endpoint saw a Tor exit, not your IP.";
    case "protectedIpOnly":
      return "Sent to the dapp's own RPC provider through anon-rpc. The provider still saw the request, but not your IP.";
    case "blocked":
      return e.note?.includes("manifest")
        ? "Stopped before it left your browser: you blocked this recipient on this site because its manifest doesn't declare it."
        : "Stopped before it left your browser: it was going to a third party with your address in it.";
    case "failedClosed":
      return "Held back: anon-rpc couldn't be reached, and you haven't allowed direct requests on this site. The dapp got an error instead of your IP going out.";
    case "detected":
      return e.methods?.length
        ? "An RPC call over a WebSocket Canary can't reroute. It went out as written, from your IP."
        : "Went to the dapp's own server with your address in it. Canary leaves first-party traffic alone, because blocking it would break the dapp.";
    case "direct":
      return "Sent directly from your IP: anon-rpc was down, and you allowed direct requests on this site.";
    case "backend":
      return `Sent normally to ${e.firstParty ? "the dapp" : "a third party"}. Canary found none of your addresses in it.`;
    case "notInspected":
      return "Canary couldn't read what this sent, so it can't say whether your address was in it. Not counted as safe.";
    case "localNode":
      return "Went to a node on this machine or your network. No third party on the other end.";
  }
  return "";
}

/** One party in a receipt: what it would have got without Canary, and what it got with it. */
export type Receipt = { party: string; role: string; without: string; with: string; withTone: "good" | "bad" };

/** What each side saw for one observation. null when there's nothing to compare (no address, no RPC call). */
export function receiptsOf(e: Ev): Receipt[] | null {
  const call = e.sample ?? (e.methods?.length ? [...new Set(e.methods)].join(", ") : "the call");
  const sent = e.snippet ? `“${e.snippet}”` : e.note === "its URL carried your address" ? "your address, in the URL" : e.address ? "your address" : "the request";
  const ip = "from your IP, with the page's Origin";
  const provider = e.firstParty ? "the dapp's RPC" : "the dapp's RPC provider";
  switch (e.category) {
    case "protected":
      return [
        { party: e.host, role: provider, without: `${call}, ${ip}`, with: "Nothing: Canary answered it", withTone: "good" },
        { party: e.via ?? "Canary's read endpoint", role: "Canary's read endpoint", without: "Nothing", with: `${call}, from a Tor exit, with Origin: null`, withTone: "good" },
      ];
    case "protectedIpOnly":
      return [{ party: e.host, role: provider, without: `${call}, ${ip}`, with: `${call}, from a Tor exit, with Origin: null. The URL is unchanged: an API key in it can still name the dapp.`, withTone: "good" }];
    case "failedClosed":
      return [{ party: e.host, role: provider, without: `${call}, ${ip}`, with: "Nothing: held back, and the dapp got an error", withTone: "good" }];
    case "direct":
      return [{ party: e.host, role: provider, without: `${call}, ${ip}`, with: "The same: you allowed direct requests on this site", withTone: "bad" }];
    case "blocked":
      return [{ party: e.host, role: e.firstParty ? "the dapp" : "a third party", without: `${sent}, from your IP`, with: "Nothing: it never left your browser", withTone: "good" }];
    case "detected":
      return e.methods?.length
        ? [{ party: e.host, role: e.firstParty ? "the dapp's RPC" : "a third party", without: `${call}, ${ip}`, with: "The same: Canary can't reroute this WebSocket", withTone: "bad" }]
        : [{ party: e.host, role: "the dapp", without: `${sent}, from your IP`, with: "The same: Canary leaves the dapp's own traffic alone", withTone: "bad" }];
  }
  return null;
}

export function ipVisible(e: Ev): string {
  switch (e.category) {
    case "protected":
    case "protectedIpOnly":
      return "No (sent over Tor)";
    case "blocked":
    case "failedClosed":
      return "No (not sent)";
    case "localNode":
      return "Local network only";
    default:
      return "Yes";
  }
}

export const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
export const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export function clock(t: number) {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
export function ago(t: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });
}
export function day(t: number) {
  const d = new Date(t);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? `today, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : d.toLocaleDateString([], { day: "numeric", month: "short" });
}

/* --- the manifest -------------------------------------------------------- */

export type ManifestView =
  | { kind: "pending" | "none"; ens?: string; text: string; label?: PrivacyLabel }
  | { kind: "notFound" | "unbound" | "invalid" | "error"; ens?: string; text: string; verdict?: any; label?: PrivacyLabel }
  | { kind: "ok"; ens: string; chainId: number; rows: DeclaredRow[]; undeclared: number; seen: number; verdict?: any };

export function manifestOf(tab: TabState | null | undefined): ManifestView {
  const d = tab?.declared ?? { state: "pending" };
  switch (d.state) {
    case "pending":
      return { kind: "pending", text: "Looking for this site's ENS manifest…" };
    case "none":
      return { kind: "none", text: "This site doesn't name an ENS manifest, so there's no promise to compare with.", ...(d.label ? { label: privacyLabel(d) } : {}) };
    case "notFound":
      return { kind: "notFound", ens: d.ens, text: `${d.ens} has no privacy.manifest record.`, verdict: d.verdict };
    case "unbound":
      return { kind: "unbound", ens: d.ens, text: `${d.ens} points at ${d.url ?? "no site"}, not this one, so its manifest isn't used here.` };
    case "invalid":
      return { kind: "invalid", ens: d.ens, text: `${d.ens} has a manifest Canary can't read: ${d.error}`, verdict: d.verdict };
    case "error":
      return { kind: "error", ens: d.ens, text: `Couldn't read the manifest${d.ens ? ` of ${d.ens}` : ""}: ${d.error}`, ...(d.label ? { label: privacyLabel(d) } : {}) };
  }
  const recipients = Object.values(tab!.recipients) as Recipient[];
  const { rows: compared, undeclared } = compareDeclared(d.manifest, recipients as any);
  // compareDeclared counts a host only if it was sent your address or RPC calls. A declared
  // host the page talked to without either (an indexer, a CDN) was still seen, not "not observed".
  const contacted = (p: string) => recipients.some((r) => !r.firstParty && (p.startsWith("*.") ? r.host.endsWith(p.slice(1)) : r.host === p));
  const order = { undeclared: 0, declared: 1, notSeen: 2 };
  const rows = compared
    .map((r) => (r.status === "notSeen" && contacted(r.host) ? { ...r, status: "declared" as const } : r))
    .sort((a, b) => order[a.status] - order[b.status] || a.host.localeCompare(b.host));
  return { kind: "ok", ens: d.ens, chainId: d.chainId, rows, undeclared, seen: rows.filter((r) => r.status !== "notSeen").length, verdict: d.verdict };
}

/** "3 recipients": how many the manifest lists. */
export function declaredCount(m: ManifestView & { kind: "ok" }) {
  const n = m.rows.filter((r) => r.status !== "undeclared").length;
  return `${n} ${n === 1 ? "recipient" : "recipients"}`;
}

/** The badge next to the site's name. */
export function manifestBadge(m: ManifestView): { label: string; tone: "good" | "bad" | "warn" | "muted" } {
  if (m.kind === "ok") return m.undeclared ? { label: `${m.undeclared} undeclared`, tone: "bad" } : { label: "Matches manifest", tone: "good" };
  if (m.kind === "pending") return { label: "Checking", tone: "muted" };
  if ((m.kind === "none" || m.kind === "error") && m.label?.source === "canary") return { label: labelBadge(m.label), tone: m.label.tone };
  if (m.kind === "none" || m.kind === "notFound") return { label: "No manifest", tone: "muted" };
  return { label: "Unverified", tone: "warn" };
}

/** "Label: 3 third parties": the badge for Canary's label on a site with no manifest. */
export const labelBadge = (l: PrivacyLabel) => (l.rows.length ? `Label: ${l.rows.length} third ${l.rows.length === 1 ? "party" : "parties"}` : "Label: no third parties");

/** What Canary could check about a verifier's signed verdict, in words. null: there is none. */
export function verdictOf(v: any): { tone: "good" | "bad" | "warn"; title: string; text: string } | null {
  if (!v) return null;
  if (v.state === "invalid") return { tone: "warn", title: "Verdict ignored", text: `The verdict record is malformed (${v.error}).` };
  const r = v.verdict;
  if (!v.signed) return { tone: "warn", title: "Verdict ignored", text: "Its signature doesn't verify." };
  if (!v.signerIsVerifier) return { tone: "warn", title: "Verdict ignored", text: `It claims to be from ${r.verifier} but isn't signed by that name's address.` };
  if (!v.matchesSite) return { tone: "warn", title: "Verdict ignored", text: `It's about ${r.name} at ${r.origin}, not this site.` };
  const found =
    r.result === "matches" ? "no undeclared recipients" : r.result === "undeclared" ? `undeclared recipients: ${r.undeclaredHosts.join(", ")}` : "nothing declared to check against";
  const extra = [
    v.expired ? `Expired ${new Date(r.expiresAt * 1000).toISOString().slice(0, 10)}.` : "",
    v.delegated === false ? `${r.verifier} can no longer write this record: its role was revoked.` : v.delegated === null ? `Whether ${r.verifier} still holds its role can't be checked on this resolver.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    tone: v.expired || v.delegated === false ? "warn" : r.result === "undeclared" ? "bad" : "good",
    title: `Signed verdict by ${r.verifier}`,
    text: `Found ${found}, in ${r.flows.length} flow steps on build ${String(r.buildHash).slice(0, 12)}…, ${new Date(r.issuedAt * 1000).toISOString().slice(0, 10)}. ${extra}`.trim(),
  };
}

export const CHAIN_NAME: Record<number, string> = {
  1: "Ethereum mainnet", 10: "OP Mainnet", 14: "Flare", 25: "Cronos", 56: "BNB Smart Chain", 97: "BNB Testnet", 100: "Gnosis", 122: "Fuse",
  130: "Unichain", 137: "Polygon", 143: "Monad", 146: "Sonic", 169: "Manta Pacific", 196: "X Layer", 204: "opBNB", 250: "Fantom", 252: "Fraxtal",
  300: "zkSync Sepolia", 324: "zkSync Era", 360: "Shape", 369: "PulseChain", 480: "World Chain", 919: "Mode Sepolia", 999: "HyperEVM",
  1088: "Metis", 1101: "Polygon zkEVM", 1116: "Core", 1135: "Lisk", 1301: "Unichain Sepolia", 1329: "Sei", 1868: "Soneium", 1946: "Soneium Minato",
  2020: "Ronin", 2222: "Kava", 2741: "Abstract", 2818: "Morph", 5000: "Mantle", 5003: "Mantle Sepolia", 8453: "Base", 9745: "Plasma",
  10143: "Monad Testnet", 10200: "Gnosis Chiado", 33139: "ApeChain", 34443: "Mode", 42161: "Arbitrum One", 42170: "Arbitrum Nova", 42220: "Celo",
  42793: "Etherlink", 43113: "Avalanche Fuji", 43114: "Avalanche", 57073: "Ink", 59141: "Linea Sepolia", 59144: "Linea", 80002: "Polygon Amoy",
  80094: "Berachain", 84532: "Base Sepolia", 88888: "Chiliz", 167000: "Taiko", 421614: "Arbitrum Sepolia", 534352: "Scroll", 560048: "Hoodi",
  747474: "Katana", 763373: "Ink Sepolia", 7777777: "Zora", 11155111: "Sepolia", 11155420: "OP Sepolia", 728126428: "Tron EVM",
  999999999: "Zora Sepolia", 1313161554: "Aurora",
};
export const chainName = (id: number) => CHAIN_NAME[id] ?? `chain ${id}`;

/** The page Canary's numbers are about: the popup's ?tabId= or the active tab. */
export async function activeTabId(): Promise<number | undefined> {
  const q = new URLSearchParams(location.search).get("tabId");
  if (q) return Number(q);
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t?.id;
}

/** Whether the theme setting shows dark: "system" follows the OS. */
export const isDark = (theme: Settings["theme"] | undefined) =>
  theme === "dark" || ((theme ?? "system") === "system" && matchMedia("(prefers-color-scheme: dark)").matches);

/** Apply the theme setting to <html>. */
export function applyTheme(theme: Settings["theme"] | undefined) {
  const dark = isDark(theme);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
