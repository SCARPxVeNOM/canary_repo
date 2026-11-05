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
import {
  findAddress, isThirdParty, knownChain, needlesFor, parseJsonRpc, SUBSTITUTABLE,
  type Category, type Observation,
} from "./shared.js";

declare const chrome: any;

type Config = {
  network: { id: string; label: string; specifier: string; bootstrapRpc: string; workerConfig?: PlainValue };
  readEndpoints: Record<string, string>;
  timeoutMs: number;
};
declare const __CANARY_CONFIG__: Config;
const CFG = __CANARY_CONFIG__;

/* --- settings (chrome.storage.local) ------------------------------------ */

type Site = { enabled: boolean; allowDirect: boolean };
const DEFAULT_SITE: Site = { enabled: true, allowDirect: false };

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

async function syncBlockRules() {
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
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.map((r: any) => r.id),
    addRules: rules,
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
  void record(req.tabId, { category: "blocked", channel: "url", host, firstParty: false });
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
  walletChain?: number;
  notes: string[];
};

const emptyCounts = (): Record<Category, number> => ({
  protected: 0, protectedIpOnly: 0, blocked: 0, detected: 0, backend: 0, notInspected: 0, failedClosed: 0, direct: 0,
});
const freshTab = (origin: string): TabState => ({
  origin, since: Date.now(), counts: emptyCounts(), rpcCalls: 0, recipients: {}, latencies: [], notes: [],
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
    chrome.action.setBadgeBackgroundColor({ tabId, color: s.counts.failedClosed ? "#b45309" : "#15803d" }).catch(() => {});
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
  persist(tabId);
}

chrome.tabs.onRemoved.addListener((tabId: number) => {
  tabs.delete(tabId);
  void chrome.storage.session.remove(`tab:${tabId}`);
});

/* --- the anon-rpc worker ------------------------------------------------- */

type WorkerStatus = { state: "idle" | "warming" | "ready" | "failed"; bootMs?: number; cold?: boolean; error?: string; network: string };
let status: WorkerStatus = { state: "idle", network: CFG.network.label };
const setStatus = (s: Partial<WorkerStatus>) => {
  status = { ...status, ...s };
  void chrome.storage.session.set({ worker: status });
};

async function bootstrapCall(method: string, params: unknown[]) {
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

function getWorker(): Promise<AnonRpcWorker> {
  if (worker) return Promise.resolve(worker);
  if (booting) return booting;
  const before = providerCalls;
  const t0 = Date.now();
  setStatus({ state: "warming", error: undefined });
  const w = new AnonRpcWorker({
    address: CFG.network.specifier,
    config: CFG.network.workerConfig,
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
  booting = w.ready.then(
    () => {
      worker = w;
      booting = undefined;
      setStatus({ state: "ready", bootMs: Date.now() - t0, cold: providerCalls > before });
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
  const t = setTimeout(() => ac.abort(), CFG.timeoutMs);
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

/* --- which chain is the dapp's endpoint on ------------------------------- */

const chainCache = new Map<string, number>();
async function chainOf(w: AnonRpcWorker, url: string, walletChain?: number): Promise<{ id: number; assumed: boolean } | undefined> {
  const cached = chainCache.get(url) ?? ((await chrome.storage.session.get("chains")).chains ?? {})[url];
  if (cached) return { id: cached, assumed: false };
  let id = knownChain(url);
  if (id === undefined) {
    try {
      const r = await anonFetch(w, url, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }));
      const j = JSON.parse(r.text);
      if (r.status === 200 && j.result) id = Number(j.result);
    } catch {
      /* fall through */
    }
  }
  if (id !== undefined) {
    chainCache.set(url, id);
    const chains = (await chrome.storage.session.get("chains")).chains ?? {};
    await chrome.storage.session.set({ chains: { ...chains, [url]: id } });
    return { id, assumed: false };
  }
  return walletChain ? { id: walletChain, assumed: true } : undefined;
}

/* --- handling one intercepted JSON-RPC request --------------------------- */

function errorBody(body: string, message: string) {
  const v = JSON.parse(body);
  const err = (c: any) => ({ jsonrpc: "2.0", id: c?.id ?? null, error: { code: -32603, message } });
  return JSON.stringify(Array.isArray(v) ? v.map(err) : err(v));
}

async function handleRpc(tabId: number, origin: string, url: string, body: string, channel: Observation["channel"]) {
  const t0 = Date.now();
  const calls = parseJsonRpc(body) ?? [];
  const methods = calls.map((c) => c.method);
  const host = new URL(url).hostname;
  const firstParty = !isThirdParty(new URL(origin).hostname, host);
  const { all } = await getAddresses();
  const taint = findAddress(body, all.map(needlesFor));
  const base = { channel, host, firstParty, methods, address: taint?.address };
  const site = await getSite(origin);
  const tab = await tabState(tabId);

  try {
    const w = await getWorker();
    let target = url;
    let category: Category = "protectedIpOnly";
    let note: string | undefined;
    if (calls.every((c) => SUBSTITUTABLE.has(c.method))) {
      const chain = await chainOf(w, url, tab?.walletChain);
      const read = chain && CFG.readEndpoints[String(chain.id)];
      if (read) {
        target = read;
        category = "protected";
        if (chain.assumed) note = `chain of ${host} assumed from the wallet (${chain.id})`;
      } else if (chain) {
        note = `no read endpoint configured for chain ${chain.id}; forwarded instead`;
      }
    }
    // Per-address isolation: calls about different addresses should not be
    // linkable to each other at the exit (honoured if the network supports it).
    const r = await anonFetch(w, target, body, taint ? `addr:${taint.address}` : undefined);
    if (r.status >= 400) throw new Error(`HTTP ${r.status} from ${new URL(target).hostname}`);
    await record(tabId, { ...base, category, ms: Date.now() - t0, note }, calls.length);
    return { status: r.status, body: r.text };
  } catch (e) {
    const why = String((e as Error)?.message ?? e);
    if (site.allowDirect) {
      await record(tabId, { ...base, category: "direct", note: `anon path failed (${why}); sent directly because you allowed it` }, calls.length);
      return { passthrough: true };
    }
    await record(tabId, { ...base, category: "failedClosed", note: `anon path failed: ${why}` }, calls.length);
    return { status: 200, body: errorBody(body, `Canary: anon path unavailable (${why}). Not sent directly.`) };
  }
}

/* --- messages ------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg: any, sender: any, respond: (r: unknown) => void) => {
  const tabId: number | undefined = sender?.tab?.id;
  const run = async () => {
    switch (msg?.type) {
      case "config": {
        // A new top-level document: start this tab's coverage over.
        if (tabId !== undefined && sender.frameId === 0) {
          tabs.set(tabId, freshTab(msg.origin));
          persist(tabId);
          void getWorker().catch(() => {});
        }
        const site = await getSite(msg.origin);
        return { enabled: site.enabled, addresses: (await getAddresses()).all };
      }
      case "rpc":
        return handleRpc(tabId ?? -1, msg.origin, msg.url, msg.body, msg.channel);
      case "obs":
        if (tabId !== undefined) await record(tabId, msg.obs);
        return null;
      case "wallet": {
        if (msg.addresses?.length) await addAddresses("walletAddresses", msg.addresses);
        if (tabId !== undefined && Number.isFinite(msg.chainId)) {
          const s = await tabState(tabId);
          if (s) (s.walletChain = msg.chainId), persist(tabId);
        }
        return null;
      }
      // popup
      case "state": {
        const s = await tabState(msg.tabId);
        return {
          worker: status,
          tab: s ?? null,
          site: s ? await getSite(s.origin) : null,
          addresses: await getAddresses(),
          readEndpoints: CFG.readEndpoints,
        };
      }
      case "setSite":
        await setSite(msg.origin, msg.patch);
        return null;
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

// Warm up as soon as the extension starts: tor-js takes ~13 s to boot.
void syncBlockRules();
void getWorker().catch(() => {});
