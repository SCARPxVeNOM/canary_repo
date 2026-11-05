// Canary service worker: owns the AnonRpcWorker and decides, per intercepted
// JSON-RPC request, whether to SUBSTITUTE (answer from our read endpoint via
// anon-rpc, so the dapp's provider never sees it) or FORWARD (send to the
// dapp's original URL via anon-rpc: IP hidden, dapp still learned).

import { AnonRpcWorker, type PlainValue } from "@anon-rpc/browser-extension-harness";

declare const chrome: any;

type Config = {
  specifier: string;
  bootstrapRpc: string;
  workerConfig?: PlainValue;
  /** chainId (decimal string) -> read endpoint we answer substituted reads from */
  readEndpoints: Record<string, string>;
};
declare const __CANARY_CONFIG__: Config;
const CFG = __CANARY_CONFIG__;

const SUBSTITUTABLE = new Set([
  "eth_call", "eth_getBalance", "eth_blockNumber", "eth_chainId", "eth_getCode", "eth_getStorageAt",
  "eth_getTransactionCount", "eth_estimateGas", "eth_gasPrice", "eth_feeHistory", "eth_maxPriorityFeePerGas",
  "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getLogs", "net_version",
]);

type Label = "protected" | "protected-ip-only" | "failed-closed";
type Stats = { protected: number; ipOnly: number; failedClosed: number; methods: Record<string, Label>; latencies: number[]; boot?: { ms: number; cold: boolean } };
const stats: Stats = { protected: 0, ipOnly: 0, failedClosed: 0, methods: {}, latencies: [] };
const persist = () => chrome.storage.session.set({ stats });

async function bootstrapCall(method: string, params: unknown[]) {
  const r = await fetch(CFG.bootstrapRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

let worker: AnonRpcWorker | undefined;
let providerCalls = 0;
async function getWorker(): Promise<AnonRpcWorker> {
  if (worker) return worker;
  const before = providerCalls;
  const t0 = Date.now();
  const w = new AnonRpcWorker({
    address: CFG.specifier,
    config: CFG.workerConfig,
    preExisting: { rpcProvider: { request: ({ method, params }: any) => (providerCalls++, bootstrapCall(method, params ?? [])) } },
  });
  void (async () => { for (;;) { try { const e = await w.acceptLog(); console.log("[worker]", e.level, ...e.args); } catch { return; } } })();
  await w.ready;
  worker = w;
  stats.boot = { ms: Date.now() - t0, cold: providerCalls > before };
  void persist();
  return w;
}

const post = (w: AnonRpcWorker, url: string, body: string) =>
  w.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });

// Which chain is the dapp's endpoint on? Asked once per URL, over the anon path,
// so the provider learns "someone uses this dapp", not who.
const chainOf = new Map<string, Promise<string>>();
function learnChain(w: AnonRpcWorker, url: string): Promise<string> {
  let p = chainOf.get(url);
  if (!p) {
    p = post(w, url, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }))
      .then((r) => r.json())
      .then((j) => String(Number(j.result)));
    p.catch(() => chainOf.delete(url));
    chainOf.set(url, p);
  }
  return p;
}

async function handle(url: string, body: string): Promise<{ status: number; body: string; label: Label }> {
  const t0 = Date.now();
  const parsed = JSON.parse(body);
  const calls: { method: string; id?: unknown }[] = Array.isArray(parsed) ? parsed : [parsed];
  const allSub = calls.every((c) => SUBSTITUTABLE.has(c.method));
  try {
    const w = await getWorker();
    let label: Label = "protected-ip-only";
    let target = url;
    if (allSub) {
      const chain = await learnChain(w, url);
      const read = CFG.readEndpoints[chain];
      if (read) { target = read; label = "protected"; }
    }
    const r = await post(w, target, body);
    const text = await r.text();
    for (const c of calls) stats.methods[c.method] = label;
    if (label === "protected") stats.protected += calls.length; else stats.ipOnly += calls.length;
    stats.latencies.push(Date.now() - t0);
    void persist();
    return { status: r.status, body: text, label };
  } catch (e) {
    // Fail closed: never fall back to a direct request from the user's IP.
    stats.failedClosed += calls.length;
    void persist();
    const err = (c: any) => ({ jsonrpc: "2.0", id: c.id ?? null, error: { code: -32603, message: `Canary: anon path unavailable (${(e as Error).message})` } });
    return { status: 200, body: JSON.stringify(Array.isArray(parsed) ? calls.map(err) : err(calls[0])), label: "failed-closed" };
  }
}

chrome.runtime.onMessage.addListener((msg: any, _sender: unknown, respond: (r: unknown) => void) => {
  if (msg?.type === "canary.rpc") {
    handle(msg.url, msg.body).then(respond);
    return true;
  }
  if (msg?.type === "canary.warm") {
    getWorker().then(() => respond({ ok: true, boot: stats.boot }), (e) => respond({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === "canary.stats") {
    respond(stats);
    return false;
  }
});

// Warm the worker as soon as the extension starts (tor-js cold boot is ~13 s).
void getWorker().catch((e) => console.warn("Canary: warm-up failed", e));
