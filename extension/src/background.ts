// Canary service worker: owns the anon-rpc worker and the policy.
//
//   standard read method  → SUBSTITUTE: answered by our read endpoint for the
//                           same chain, via anon-rpc. The dapp's provider never sees it.
//   other method          → FORWARD to the dapp's own URL via anon-rpc ("IP only").
//   anon path down        → FAIL CLOSED (JSON-RPC error), unless you allowed
//                           direct requests on this site.
//
// Chain of an RPC URL: well-known provider URL → one probe over the anon path
// → the wallet's chain as a labelled fallback. Never the wallet first: dapps
// read chains other than the one your wallet is on.

import { AnonRpcWorker, type PlainValue } from "@anon-rpc/browser-extension-harness";
import { readDeclared, UNIVERSAL_RESOLVER, type Declared } from "./ens.js";
import { privacyLabel } from "./privacy-label.js";
import { RpcPipeline } from "./rpc-pipeline.js";
import {
  chainHintFromUrl, findAddress, isLocalHost, isThirdParty, knownChain, needlesFor, parseJsonRpc, sampleCall, SUBSTITUTABLE,
  type Category, type Observation,
} from "./shared.js";

declare const chrome: any;

type Config = {
  network: {
    id: string;
    label: string;
    specifier: string;
    bootstrapRpc: string;
    workerConfig?: PlainValue;
    /** Dev only, set by build.mjs: a worker build pinned here instead of on chain. */
    devWorker?: { hash: string; url: string };
  };
  readEndpoints: Record<string, string>;
  /** Where dapps' ENS names live (default: Sepolia, Universal Resolver at its usual address), whose verdict record to read (privacy.verdict.<verifier>, default "canary"), and where Canary's labels are (default labels.canary.eth). */
  ens?: { chainId: number; universalResolver?: string; verifier?: string; labels?: string };
  timeoutMs: number;
  /** A tor-js fast-bootstrap snapshot packaged at build time (build.mjs --tor-bootstrap). */
  torBootstrap?: { file: string; fetchedAt: number; maxAgeHours: number };
};
declare const __CANARY_CONFIG__: Config;
const CFG = __CANARY_CONFIG__;

/* --- settings (chrome.storage.local) ------------------------------------ */

/** Per site. blockHosts: recipients you blocked here (from "Block undeclared recipients"). */
type Site = { enabled: boolean; allowDirect: boolean; blockHosts: string[] };
const DEFAULT_SITE: Site = { enabled: true, allowDirect: false, blockHosts: [] };

/** Global. Kept on this device only. connectNotice: show the site's privacy label on the page when you connect a wallet. */
type Settings = { historyDays: number; theme: "system" | "light" | "dark"; connectNotice: boolean };
const DEFAULT_SETTINGS: Settings = { historyDays: 30, theme: "system", connectNotice: true };
const getSettings = async (): Promise<Settings> => ({ ...DEFAULT_SETTINGS, ...(await local<Partial<Settings>>("settings", {})) });

async function local<T>(key: string, fallback: T): Promise<T> {
  return ((await chrome.storage.local.get(key))[key] as T) ?? fallback;
}
const getSites = () => local<Record<string, Site>>("sites", {});
async function getSite(origin: string): Promise<Site> {
  return { ...DEFAULT_SITE, ...(await getSites())[origin] };
}
async function setSite(origin: string, patch: Partial<Site>) {
  const sites = await getSites();
  sites[origin] = { ...DEFAULT_SITE, ...sites[origin], ...patch };
  await chrome.storage.local.set({ sites });
  await syncBlockRules();
}

/** Your addresses: learned from wallets on any site, plus ones you added by hand. */
async function getAddresses(): Promise<{ wallet: string[]; manual: string[]; all: string[] }> {
  const wallet = await local<string[]>("walletAddresses", []);
  const manual = await local<string[]>("manualAddresses", []);
  return { wallet, manual, all: [...new Set([...wallet, ...manual])] };
}
async function addAddresses(key: "walletAddresses" | "manualAddresses", addrs: string[]) {
  const cur = await local<string[]>(key, []);
  const next = [...new Set([...cur, ...addrs.map((a) => a.toLowerCase())])];
  if (next.length === cur.length) return;
  await chrome.storage.local.set({ [key]: next });
  await syncBlockRules();
}

/* --- network-level blocking (declarativeNetRequest) ----------------------
   The shim catches fetch, XHR, beacons and WebSocket frames. These rules
   catch everything else whose URL carries your address: images, pixels,
   scripts, iframes. Third-party only; never the extension's own requests. */

// One update at a time: two overlapping ones would both add the same rule ids, and the second would fail.
let syncing: Promise<void> = Promise.resolve();
function syncBlockRules(): Promise<void> {
  const run = syncing.then(syncBlockRulesNow, syncBlockRulesNow);
  syncing = run.catch(() => {});
  return run;
}

async function syncBlockRulesNow() {
  const { all } = await getAddresses();
  const sites = await getSites();
  const disabled = Object.entries(sites).filter(([, s]) => !s.enabled).map(([o]) => new URL(o).hostname);
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const rules = all.map((a, i) => ({
    id: 1000 + i,
    priority: 1,
    action: { type: "block" },
    condition: {
      regexFilter: a.replace(/^0x/, ""),
      isUrlFilterCaseSensitive: false,
      domainType: "thirdParty",
      excludedTabIds: [-1],
      ...(disabled.length ? { excludedInitiatorDomains: disabled } : {}),
      resourceTypes: ["sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "media", "websocket", "other"],
    },
  }));
  // Hosts you blocked on a site: any request that site's pages start to them.
  const hostRules = Object.entries(sites)
    .filter(([, s]) => s.blockHosts?.length)
    .map(([o, s], i) => ({
      id: 5000 + i,
      priority: 2,
      action: { type: "block" },
      condition: {
        requestDomains: s.blockHosts,
        initiatorDomains: [new URL(o).hostname],
        excludedTabIds: [-1],
        resourceTypes: ["sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "media", "websocket", "other"],
      },
    }));
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.map((r: any) => r.id),
    addRules: [...rules, ...hostRules],
  });
}

chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener((info: any) => {
  const req = info.request;
  if (req.tabId < 0) return;
  let host = "";
  try {
    host = new URL(req.url).hostname;
  } catch {
    /* ignore */
  }
  void record(req.tabId, { category: "blocked", channel: "url", host, firstParty: false, note: info.rule?.ruleId >= 5000 ? "not in the site's manifest; you blocked it on this site" : "its URL carried your address" });
});

/* --- per-tab coverage (chrome.storage.session) --------------------------- */

type Recipient = {
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
  counts: Record<Category, number>;
  /** individual JSON-RPC calls seen, by outcome */
  rpcCalls: number;
  recipients: Record<string, Recipient>;
  latencies: number[];
  /** when the page first learned a wallet address (connect, or eth_accounts on load) */
  connectedAt?: number;
  notes: string[];
  /** calls answered without a request of their own: from cache, or by joining an identical one in flight */
  noRequest: number;
  /** the site's declared recipients (ENS privacy.manifest), for declared vs observed */
  declared?: Declared;
  /** the latest observations, newest last (the counts above cover all of them) */
  events: Ev[];
};
/** One observation as the Activity view shows it. n: how many JSON-RPC calls it covered. */
export type Ev = Observation & { t: number; n: number };
const MAX_EVENTS = 400;

const emptyCounts = (): Record<Category, number> => ({
  protected: 0, protectedIpOnly: 0, blocked: 0, detected: 0, backend: 0, notInspected: 0, failedClosed: 0, direct: 0, localNode: 0,
});
const freshTab = (origin: string): TabState => ({
  origin, since: Date.now(), counts: emptyCounts(), rpcCalls: 0, recipients: {}, latencies: [], notes: [], noRequest: 0, events: [],
});

const tabs = new Map<number, TabState>();
const dirty = new Set<number>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

async function tabState(tabId: number): Promise<TabState | undefined> {
  if (tabs.has(tabId)) return tabs.get(tabId);
  const s = (await chrome.storage.session.get(`tab:${tabId}`))[`tab:${tabId}`] as TabState | undefined;
  if (s) tabs.set(tabId, s);
  return s;
}
function persist(tabId: number) {
  dirty.add(tabId);
  flushTimer ??= setTimeout(async () => {
    flushTimer = undefined;
    const out: Record<string, TabState> = {};
    for (const id of dirty) {
      const s = tabs.get(id);
      if (s) out[`tab:${id}`] = s;
    }
    dirty.clear();
    await chrome.storage.session.set(out);
  }, 150);
  const s = tabs.get(tabId);
  if (s) {
    const n = s.counts.protected + s.counts.protectedIpOnly;
    chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: s.counts.failedClosed ? "#865601" : "#0a6b72" }).catch(() => {});
  }
}

async function record(tabId: number, o: Observation, calls = 1) {
  const s = await tabState(tabId);
  if (!s) return;
  s.counts[o.category] += calls;
  if (o.methods) s.rpcCalls += calls;
  const r = (s.recipients[o.host] ??= { host: o.host, firstParty: o.firstParty, categories: {}, channels: [], methods: [], carriedAddress: false });
  r.categories[o.category] = (r.categories[o.category] ?? 0) + calls;
  if (!r.channels.includes(o.channel)) r.channels.push(o.channel);
  for (const m of o.methods ?? []) if (!r.methods.includes(m) && r.methods.length < 12) r.methods.push(m);
  if (o.address) r.carriedAddress = true;
  if (o.ms !== undefined) s.latencies = [...s.latencies.slice(-199), o.ms];
  if (o.note && !s.notes.includes(o.note) && s.notes.length < 20) s.notes.push(o.note);
  (s.events ??= []).push({ ...o, t: Date.now(), n: calls });
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
  persist(tabId);
}

chrome.tabs.onRemoved.addListener(async (tabId: number) => {
  const s = await tabState(tabId);
  if (s) await archive(s).catch(() => {});
  tabs.delete(tabId);
  void chrome.storage.session.remove(`tab:${tabId}`);
});

/* --- history (chrome.storage.local, this device only) --------------------
   A page's coverage is archived when the tab leaves it or closes, so the
   dashboard can show earlier sessions. Pruned to the "keep history for" setting. */

export type Session = TabState & { id: string; until: number };
const MAX_SESSIONS = 60;
const ARCHIVED_EVENTS = 150;

const observed = (s: TabState) => Object.values(s.counts).some((n) => n > 0);

async function archive(s: TabState) {
  if (!observed(s) || !/^https?:/.test(s.origin)) return;
  const { historyDays } = await getSettings();
  const cutoff = Date.now() - historyDays * 86_400_000;
  const history = (await local<Session[]>("history", [])).filter((h) => h.until >= cutoff);
  const id = `${s.since.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  history.unshift({ ...s, id, until: Date.now(), latencies: s.latencies.slice(-50), events: (s.events ?? []).slice(-ARCHIVED_EVENTS) });
  await chrome.storage.local.set({ history: history.slice(0, MAX_SESSIONS) });
}

async function pruneHistory() {
  const { historyDays } = await getSettings();
  const cutoff = Date.now() - historyDays * 86_400_000;
  const history = await local<Session[]>("history", []);
  const kept = history.filter((h) => h.until >= cutoff);
  if (kept.length !== history.length) await chrome.storage.local.set({ history: kept });
}

/** Open tabs Canary has numbers for, newest first. */
async function liveTabs(): Promise<{ tabId: number; state: TabState }[]> {
  const all = await chrome.storage.session.get(null);
  const out: { tabId: number; state: TabState }[] = [];
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith("tab:")) continue;
    const tabId = Number(k.slice(4));
    out.push({ tabId, state: tabs.get(tabId) ?? (v as TabState) });
  }
  return out.filter((t) => /^https?:/.test(t.state.origin)).sort((a, b) => b.state.since - a.state.since);
}

const summary = (s: TabState) => ({ origin: s.origin, since: s.since, counts: s.counts, ens: s.declared && "ens" in s.declared ? s.declared.ens : undefined });

/* --- the anon-rpc worker ------------------------------------------------- */

type WorkerStatus = { state: "idle" | "warming" | "ready" | "failed"; bootMs?: number; cold?: boolean; error?: string; network: string };
let status: WorkerStatus = { state: "idle", network: CFG.network.label };
const setStatus = (s: Partial<WorkerStatus>) => {
  status = { ...status, ...s };
  void chrome.storage.session.set({ worker: status });
};

/** ABI encoding of a string[] return value. */
function abiStrings(xs: string[]): string {
  const word = (n: number) => n.toString(16).padStart(64, "0");
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  let head = "", tail = "", off = xs.length * 32;
  for (const x of xs) {
    const b = new TextEncoder().encode(x);
    const padded = hex(b).padEnd(Math.ceil(b.length / 32) * 64, "0");
    head += word(off);
    tail += word(b.length) + padded;
    off += 32 + padded.length / 2;
  }
  return "0x" + word(32) + word(xs.length) + head + tail;
}

async function bootstrapCall(method: string, params: unknown[]) {
  // A dev worker: answer the specifier's workerHash()/workerResolvers() with
  // the hash pinned at build time. The harness verifies the bytes against it.
  const dev = CFG.network.devWorker;
  const to = (params[0] as { to?: string; data?: string } | undefined);
  if (dev && method === "eth_call" && to?.to?.toLowerCase() === CFG.network.specifier.toLowerCase()) {
    if (to.data === "0x3898587d") return dev.hash; // workerHash()
    if (to.data === "0x1c67ff29") return abiStrings([dev.url]); // workerResolvers()
  }
  const r = await fetch(CFG.network.bootstrapRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

let worker: AnonRpcWorker | undefined;
let booting: Promise<AnonRpcWorker> | undefined;
let providerCalls = 0;

/**
 * The worker config: the network's own, plus the packaged directory snapshot
 * while it is fresh enough for Tor to accept. tor-js uses the snapshot only
 * while its storage holds no consensus, so it saves the ~1.5 MB download from
 * the gateway on a first boot (11–13 s measured) and is ignored after that.
 * The age check is made once per service-worker start, so the config (which
 * keys the harness's warm-worker cache) doesn't change under a running worker.
 */
let workerConfigP: Promise<PlainValue | undefined> | undefined;
function workerConfig(): Promise<PlainValue | undefined> {
  return (workerConfigP ??= (async () => {
    const base = CFG.network.workerConfig;
    const tb = CFG.torBootstrap;
    if (!tb || !base || typeof base !== "object" || Array.isArray(base)) return base;
    if (Date.now() - tb.fetchedAt > tb.maxAgeHours * 3600_000) return base;
    try {
      const bytes = new Uint8Array(await (await fetch(chrome.runtime.getURL(tb.file))).arrayBuffer());
      return { ...(base as Record<string, PlainValue>), bootstrap: bytes };
    } catch {
      return base;
    }
  })());
}

function getWorker(): Promise<AnonRpcWorker> {
  if (worker) return Promise.resolve(worker);
  if (booting) return booting;
  const before = providerCalls;
  const t0 = Date.now();
  setStatus({ state: "warming", error: undefined });
  booting = (async () => {
    const config = await workerConfig();
    const w = new AnonRpcWorker({
      address: CFG.network.specifier,
      config,
      preExisting: {
        rpcProvider: {
          request: ({ method, params }: any) => (providerCalls++, bootstrapCall(method, (params as unknown[]) ?? [])),
        },
      },
    });
    void (async () => {
      for (;;) {
        try {
          const e = await w.acceptLog();
          if (e.level === "warn" || e.level === "error") console.warn("[anon-rpc worker]", ...e.args);
        } catch {
          return;
        }
      }
    })();
    await w.ready;
    return w;
  })().then(
    (w) => {
      worker = w;
      booting = undefined;
      setStatus({ state: "ready", bootMs: Date.now() - t0, cold: providerCalls > before });
      void prewarmKnown();
      return w;
    },
    (e) => {
      booting = undefined;
      setStatus({ state: "failed", error: String(e?.message ?? e) });
      throw e;
    },
  );
  return booting;
}

async function anonFetch(w: AnonRpcWorker, url: string, body: string, isolationKey?: string): Promise<{ status: number; text: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error(`no answer within ${Math.round(CFG.timeoutMs / 1000)} s`)), CFG.timeoutMs);
  try {
    const r = await w.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ac.signal,
      ...(isolationKey ? { anonOptions: { isolationKey } } : {}),
    } as RequestInit);
    return { status: r.status, text: await r.text() };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Every read goes through here: cache, dedupe, batch (rpc-pipeline.ts).
 *
 * Hedged on a fresh circuit: if the anon path fails, or hasn't answered in
 * HEDGE_MS (warm reads are ~0.9 s p50, 1.3 s p90), the same read goes out
 * again under a new isolation key, which makes tor-js build a new circuit,
 * and the first answer wins. A circuit whose gateway died otherwise stalls
 * until the request timeout (measured: 15–35 s gaps when a gateway was killed).
 * When the hedge wins, its circuit becomes the one used for that key: tor-js
 * keeps handing out a key's circuit after its gateway died, so without this
 * every later read paid HEDGE_MS first (measured: ~4.2 s per read through
 * the surviving gateway instead of ~1.2 s).
 * The hedge key is derived from the original, so a hedge for one address
 * still never shares a circuit with another address. Reads only: background
 * never sends a write through the pipeline.
 */
const HEDGE_MS = 3000;
let retrySeq = 0;
/** isolation key (or "shared") → the key of the circuit currently used for it */
const circuitFor = new Map<string, string>();
const pipeline = new RpcPipeline(async (target, body, key) => {
  const w = await getWorker();
  const base = key ?? "shared";
  const current = circuitFor.get(base) ?? key;
  const first = anonFetch(w, target, body, current);
  let firstWon = false;
  first.then(() => (firstWon = true), () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const second = new Promise<{ status: number; text: string }>((resolve, reject) => {
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      clearTimeout(timer);
      const fresh = `${base}#retry${++retrySeq}`;
      anonFetch(w, target, body, fresh).then((r) => {
        if (!firstWon && (circuitFor.get(base) ?? key) === current) circuitFor.set(base, fresh);
        resolve(r);
      }, reject);
    };
    timer = setTimeout(go, HEDGE_MS);
    first.catch(go);
  });
  try {
    return await Promise.any([first, second]);
  } catch (e) {
    throw (e as AggregateError).errors?.[1] ?? e;
  } finally {
    clearTimeout(timer);
  }
});

/* --- circuit pre-warming --------------------------------------------------
   With per-address isolation, the first read about an address builds a new
   circuit: ~2.0 s instead of ~1.15 s (test-repo.md §14). Building it as soon
   as Canary learns the address takes that off the dapp's first read. The
   warm-up is one eth_blockNumber to a read endpoint, under the address's key:
   the endpoint learns nothing it wouldn't from the real read. Arti stops
   putting new streams on a circuit ~10 min after first use, so a warm-up
   older than that is redone on the next page load. */

const WARM_FOR_MS = 9 * 60_000;
const warmedAt = new Map<string, number>();
const keyFor = (address: string) => `addr:${address.toLowerCase()}`;

async function prewarm(key: string | undefined, chainId?: number) {
  const k = key ?? "";
  if (Date.now() - (warmedAt.get(k) ?? 0) < WARM_FOR_MS) return;
  const target = (chainId && CFG.readEndpoints[String(chainId)]) || CFG.readEndpoints["1"] || Object.values(CFG.readEndpoints)[0];
  if (!target || isLocalHost(new URL(target).hostname)) return;
  warmedAt.set(k, Date.now());
  try {
    await anonFetch(await getWorker(), target, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), circuitFor.get(key ?? "shared") ?? key);
  } catch {
    warmedAt.delete(k); // try again next time
  }
}

/** The shared (unkeyed) circuit, plus one per known address: the most recent few. */
async function prewarmKnown(chainId?: number) {
  const { all } = await getAddresses();
  await Promise.all([prewarm(undefined, chainId), ...all.slice(-4).map((a) => prewarm(keyFor(a), chainId))]);
}

/* --- which chain is the dapp's endpoint on ------------------------------- */

/* Never a guess from the wallet: dapps read chains the wallet isn't on (1inch
   reads mainnet with the wallet on Sepolia), and a read answered with another
   chain's data is worse than one held back. */

const chainCache = new Map<string, number>();
const chainInflight = new Map<string, Promise<number | undefined>>();
// Endpoints whose anon-rpc probe failed (most of them refuse Tor): later reads don't wait on another one.
const probeFailed = new Map<string, number>();
const PROBE_RETRY_MS = 10 * 60_000;

/** The chain a well-known provider's URL names, or the endpoint's own eth_chainId. One probe per URL at a time: concurrent first reads share it. */
function probedChain(w: AnonRpcWorker | undefined, url: string) {
  let p = chainInflight.get(url);
  if (!p) {
    p = probedChainUncached(w, url).finally(() => chainInflight.delete(url));
    chainInflight.set(url, p);
  }
  return p;
}
async function probedChainUncached(w: AnonRpcWorker | undefined, url: string): Promise<number | undefined> {
  const cached = chainCache.get(url) ?? ((await chrome.storage.session.get("chains")).chains ?? {})[url];
  if (cached) return cached;
  const known = knownChain(url);
  if (known !== undefined) return rememberChain(url, known);
  if (Date.now() - (probeFailed.get(url) ?? 0) < PROBE_RETRY_MS) return undefined;
  try {
    // A node on this machine can't be reached through Tor, and asking it
    // directly tells no third party anything.
    const probe = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
    const r = isLocalHost(new URL(url).hostname)
      ? await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: probe }).then(async (x) => ({ status: x.status, text: await x.text() }))
      : await anonFetch(w!, url, probe);
    const id = Number(JSON.parse(r.text).result);
    if (r.status === 200 && Number.isSafeInteger(id) && id > 0) return rememberChain(url, id);
  } catch {
    /* below */
  }
  probeFailed.set(url, Date.now());
  return undefined;
}
async function rememberChain(url: string, id: number) {
  chainCache.set(url, id);
  const chains = (await chrome.storage.session.get("chains")).chains ?? {};
  await chrome.storage.session.set({ chains: { ...chains, [url]: id } });
  return id;
}

/* --- handling one intercepted JSON-RPC request --------------------------- */

function errorBody(body: string, message: string) {
  const v = JSON.parse(body);
  const err = (c: any) => ({ jsonrpc: "2.0", id: c?.id ?? null, error: { code: -32603, message } });
  return JSON.stringify(Array.isArray(v) ? v.map(err) : err(v));
}

/** What the shim can do about an endpoint's chain: ask it from the page (fetch and XHR, not WebSocket), and what that got
    (null: no answer). */
type ChainAsk = { canAsk?: boolean; pageChain?: number | null };

/* A remote node holds no keys: to eth_accounts it always answers []. Canary
   gives that answer without a request (1inch polls its own proxy, which refuses
   Tor, with batches of them). A local node can hold accounts: passed through. */
const NODE_ANSWERS = new Map<string, unknown>([["eth_accounts", []]]);
const isRead = (c: { method: string }) => SUBSTITUTABLE.has(c.method) || NODE_ANSWERS.has(c.method);

async function handleRpc(tabId: number, origin: string, url: string, body: string, channel: Observation["channel"], ask: ChainAsk = {}) {
  const t0 = Date.now();
  const calls = parseJsonRpc(body) ?? [];
  const methods = calls.map((c) => c.method);
  const host = new URL(url).hostname;
  const firstParty = !isThirdParty(new URL(origin).hostname, host);
  const { all } = await getAddresses();
  const taint = findAddress(body, all.map(needlesFor));
  const base = { channel, host, firstParty, methods, address: taint?.address, sample: sampleCall(calls[0]) };
  const site = await getSite(origin);
  const tab = await tabState(tabId);

  // A local node (anvil, hardhat, a devnet) that we have no public read
  // endpoint for: no third party on the other end, and Tor couldn't reach it.
  if (isLocalHost(host)) {
    const chain = calls.every((c) => SUBSTITUTABLE.has(c.method)) ? await probedChain(undefined, url).catch(() => undefined) : undefined;
    if (!(chain && CFG.readEndpoints[String(chain)])) {
      await record(tabId, { ...base, category: "localNode" }, calls.length);
      return { passthrough: true };
    }
  }

  if (calls.length && calls.every((c) => NODE_ANSWERS.has(c.method))) {
    if (tab) tab.noRequest = (tab.noRequest ?? 0) + calls.length;
    await record(tabId, { ...base, category: "protected" }, calls.length);
    const answers = calls.map((c) => ({ jsonrpc: "2.0", id: c.id ?? null, result: NODE_ANSWERS.get(c.method) }));
    return { status: 200, body: JSON.stringify(/^\s*\[/.test(body) ? answers : answers[0]) };
  }

  // Why reads went to the dapp's own endpoint as written: for the note, if that fails too.
  let asWritten: string | undefined;
  try {
    const w = await getWorker();
    let target = url;
    let category: Category = "protectedIpOnly";
    let note: string | undefined;
    let via: string | undefined;
    if (calls.every(isRead)) {
      let chain = await probedChain(w, url);
      if (chain === undefined && typeof ask.pageChain === "number") {
        chain = await rememberChain(url, ask.pageChain);
        note = `chain of ${host} (${chain}) asked of the dapp's own server by the page, as anon-rpc couldn't; the question carries no address`;
      } else if (chain === undefined && firstParty && ask.canAsk && ask.pageChain === undefined) {
        // The dapp's own server (1inch's proxy refuses Tor): the page can ask it, with its own headers and cookies.
        return { askChain: true };
      }
      if (chain === undefined) {
        const hint = chainHintFromUrl(url);
        if (hint !== undefined && CFG.readEndpoints[String(hint)]) (chain = hint), (note = `chain of ${host} read from its URL (${hint})`);
      }
      const read = chain !== undefined && CFG.readEndpoints[String(chain)];
      if (read) {
        target = read;
        category = "protected";
        via = new URL(read).hostname;
        // The read endpoint's chain is known, so these never need a request.
        pipeline.seed(read, "eth_chainId", [], "0x" + chain!.toString(16));
        pipeline.seed(read, "net_version", [], String(chain));
      } else {
        asWritten = chain !== undefined ? `no read endpoint configured for chain ${chain}` : `couldn't tell which chain ${host} serves`;
        note = `${asWritten}; sent to ${host} as written, over anon-rpc`;
      }
    }
    // Per-address isolation: tor-js puts calls under different keys on
    // different circuits, so the exit can't link two of your addresses. The
    // pipeline batches only within one key.
    const key = taint ? keyFor(taint.address) : undefined;
    // Only read methods go through the pipeline. Anything else (sends, custom
    // methods) is forwarded exactly as the dapp wrote it: never batched with
    // other calls, deduped, cached or retried, so a write can't be sent twice.
    if (!calls.every(isRead)) {
      const r = await anonFetch(w, target, body, key);
      if (r.status >= 400) throw new Error(`HTTP ${r.status} from ${new URL(target).hostname}`);
      await record(tabId, { ...base, category, ms: Date.now() - t0, note, via }, calls.length);
      return { status: r.status, body: r.text };
    }
    const outs = await Promise.all(calls.map((c) => (NODE_ANSWERS.has(c.method) ? Promise.resolve({ answer: { result: NODE_ANSWERS.get(c.method) }, source: "cache" as const }) : pipeline.call(target, c, key))));
    const answers = calls.map((c, i) => ({ jsonrpc: "2.0", id: c.id ?? null, ...outs[i].answer }));
    const noRequest = outs.filter((o) => o.source !== "network").length;
    if (noRequest && tab) tab.noRequest = (tab.noRequest ?? 0) + noRequest;
    // A call answered from cache took no anon-rpc round trip: don't let it pull the latency figures down.
    const ms = outs.some((o) => o.source === "network") ? Date.now() - t0 : undefined;
    await record(tabId, { ...base, category, ms, note, via }, calls.length);
    return { status: 200, body: JSON.stringify(/^\s*\[/.test(body) ? answers : answers[0]) };
  } catch (e) {
    const why = String((e as Error)?.message ?? e);
    if (site.allowDirect) {
      await record(tabId, { ...base, category: "direct", note: `anon path failed (${why}); sent directly because you allowed it` }, calls.length);
      return { passthrough: true };
    }
    const note = asWritten ? `${asWritten}, and the anon path to ${host} failed (${why}): not sent` : `anon path failed: ${why}`;
    await record(tabId, { ...base, category: "failedClosed", note }, calls.length);
    return { status: 200, body: errorBody(body, `Canary: anon path unavailable (${why}). Not sent directly.`) };
  }
}

/* --- declared recipients (ENS) ------------------------------------------- */

const ENS = { chainId: CFG.ens?.chainId ?? 11155111, universalResolver: CFG.ens?.universalResolver ?? UNIVERSAL_RESOLVER, verifier: CFG.ens?.verifier ?? "canary", labels: CFG.ens?.labels };
const DECLARED_TTL_MS = 10 * 60_000;
const DECLARED_RETRY_MS = 30_000;
const declaredCache = new Map<string, { at: number; ttl: number; value: Promise<Declared> }>();

/** The site's manifest, read once per origin every 10 min (30 s after a failure). */
function declaredFor(origin: string): Promise<Declared> {
  const hit = declaredCache.get(origin);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const read = CFG.readEndpoints[String(ENS.chainId)];
  const entry = { at: Date.now(), ttl: DECLARED_TTL_MS, value: Promise.resolve<Declared>({ state: "error", error: `no read endpoint for chain ${ENS.chainId}` }) };
  if (read) {
    // Its own circuit: ENS lookups never share one with reads about your addresses.
    const call = (to: string, data: string, from?: string) =>
      pipeline.call(read, { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ ...(from ? { from } : {}), to, data }, "latest"] }, "canary:ens").then((o) => o.answer as { result?: string; error?: { message: string } });
    entry.value = readDeclared(origin, call, ENS).catch((e) => ({ state: "error", error: String(e?.message ?? e) }) as Declared);
  }
  void entry.value.then((d) => { if (d.state === "error" || ("label" in d && d.label && "error" in d.label)) entry.ttl = DECLARED_RETRY_MS; });
  declaredCache.set(origin, entry);
  return entry.value;
}

/**
 * The page has your address now: note when, and show the site's privacy label
 * on the page (bridge.ts), once per site per browser session, with protection on.
 */
async function noticeConnect(tabId: number, origin: string) {
  const s = await tabState(tabId);
  if (!s || s.origin !== origin || s.connectedAt) return;
  s.connectedAt = Date.now();
  persist(tabId);
  const key = `notice:${origin}`;
  if (!(await getSettings()).connectNotice || !(await getSite(origin)).enabled || (await chrome.storage.session.get(key))[key]) return;
  await chrome.storage.session.set({ [key]: true });
  const label = privacyLabel(await declaredFor(origin));
  if ((await tabState(tabId))?.origin !== origin) return;
  chrome.tabs.sendMessage(tabId, { type: "notice", label }, { frameId: 0 }).catch(() => {});
}

async function lookUpDeclared(tabId: number, origin: string) {
  if (!/^https?:/.test(origin)) return;
  const s = await tabState(tabId);
  if (s) (s.declared = { state: "pending" }), persist(tabId);
  const d = await declaredFor(origin);
  const now = await tabState(tabId);
  if (now && now.origin === origin) (now.declared = d), persist(tabId);
}

/* --- messages ------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg: any, sender: any, respond: (r: unknown) => void) => {
  const tabId: number | undefined = sender?.tab?.id;
  const run = async () => {
    switch (msg?.type) {
      case "config": {
        // A new top-level document: start this tab's coverage over.
        if (tabId !== undefined && sender.frameId === 0) {
          // Archived in the background: the page waits for this reply, and history must never break it.
          const prev = await tabState(tabId);
          if (prev) void archive(prev).catch(() => {});
          tabs.set(tabId, freshTab(msg.origin));
          persist(tabId);
          void lookUpDeclared(tabId, msg.origin);
          // Rebuilds any circuit that has aged out (no-op when ready() hasn't happened yet).
          void getWorker().then(() => prewarmKnown(), () => {});
        }
        const site = await getSite(msg.origin);
        // A frame inherits the blocks set on the page it's in.
        const top = tabId !== undefined && sender.frameId !== 0 ? (await tabState(tabId))?.origin : undefined;
        const blockHosts = [...new Set([...site.blockHosts, ...(top && top !== msg.origin ? (await getSite(top)).blockHosts : [])])];
        await syncing; // the page treats these addresses as already blocked in URLs
        return { enabled: site.enabled, addresses: (await getAddresses()).all, blockHosts };
      }
      case "rpc": {
        const pageChain = msg.pageChain === null || (Number.isSafeInteger(msg.pageChain) && msg.pageChain > 0) ? msg.pageChain : undefined;
        return handleRpc(tabId ?? -1, msg.origin, msg.url, msg.body, msg.channel, { canAsk: msg.canAsk === true, pageChain });
      }
      case "obs":
        if (tabId !== undefined) await record(tabId, msg.obs);
        return null;
      case "wallet": {
        if (msg.addresses?.length) await addAddresses("walletAddresses", msg.addresses);
        if (msg.addresses?.length && tabId !== undefined && sender.frameId === 0) void noticeConnect(tabId, msg.origin);
        // Build each address's circuit now, before the dapp's first read about it.
        for (const a of msg.addresses ?? []) if (/^0x[0-9a-fA-F]{40}$/.test(a)) void prewarm(keyFor(a), Number.isFinite(msg.chainId) ? msg.chainId : undefined);
        return null;
      }
      // popup
      case "state": {
        const s = await tabState(msg.tabId);
        return {
          settings: await getSettings(),
          worker: status,
          tab: s ?? null,
          site: s ? await getSite(s.origin) : null,
          addresses: await getAddresses(),
          readEndpoints: CFG.readEndpoints,
          pipeline: pipeline.stats,
        };
      }
      case "setSite":
        await setSite(msg.origin, msg.patch);
        return null;
      // dashboard
      case "overview": {
        const settings = await getSettings();
        return {
          worker: status,
          live: (await liveTabs()).map((t) => ({ key: `tab:${t.tabId}`, tabId: t.tabId, live: true, ...summary(t.state) })),
          history: (await local<Session[]>("history", [])).map((h) => ({ key: `h:${h.id}`, live: false, until: h.until, ...summary(h) })),
          settings,
          sites: await getSites(),
          addresses: await getAddresses(),
          readEndpoints: CFG.readEndpoints,
          network: CFG.network.label,
          pipeline: pipeline.stats,
        };
      }
      case "session": {
        const key: string = msg.key;
        if (key.startsWith("tab:")) {
          const s = await tabState(Number(key.slice(4)));
          return s ? { key, live: true, tabId: Number(key.slice(4)), state: s, site: await getSite(s.origin) } : null;
        }
        const h = (await local<Session[]>("history", [])).find((x) => `h:${x.id}` === key);
        return h ? { key, live: false, state: h, site: await getSite(h.origin) } : null;
      }
      case "blockHosts": {
        const site = await getSite(msg.origin);
        await setSite(msg.origin, { blockHosts: [...new Set([...site.blockHosts, ...msg.hosts])] });
        return null;
      }
      case "unblockHost": {
        const site = await getSite(msg.origin);
        await setSite(msg.origin, { blockHosts: site.blockHosts.filter((h: string) => h !== msg.host) });
        return null;
      }
      case "setSettings": {
        await chrome.storage.local.set({ settings: { ...(await getSettings()), ...msg.patch } });
        await pruneHistory();
        return null;
      }
      case "clearHistory":
        await chrome.storage.local.set({ history: [] });
        return null;
      case "removeAddress": {
        for (const k of ["walletAddresses", "manualAddresses"] as const) {
          const cur = await local<string[]>(k, []);
          await chrome.storage.local.set({ [k]: cur.filter((a) => a !== msg.address) });
        }
        await syncBlockRules();
        return null;
      }
      case "addAddress":
        if (/^0x[0-9a-fA-F]{40}$/.test(msg.address)) await addAddresses("manualAddresses", [msg.address]);
        return null;
      case "clearAddresses":
        await chrome.storage.local.set({ walletAddresses: [], manualAddresses: [] });
        await syncBlockRules();
        return null;
      case "warm":
        await getWorker().catch(() => {});
        return status;
    }
    return null;
  };
  run().then(respond, (e) => respond({ error: String(e?.message ?? e) }));
  return true;
});

// Boot Tor when the browser starts or Canary is installed/updated, not when the
// first dapp request happens to wake the service worker: registering these
// listeners is what makes Chrome start the worker at launch. The booted Tor
// client lives in the offscreen document, so later service-worker restarts
// reattach to it (~1 ms) instead of booting again.
chrome.runtime.onStartup.addListener(() => void getWorker().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => void getWorker().catch(() => {}));
void syncBlockRules();
void getWorker().catch(() => {});
