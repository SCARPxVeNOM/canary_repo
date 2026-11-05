// In-page half of the latency probes. No UI: driven from drive.mjs.
import { AnonRpcWorker } from "@anon-rpc/browser-harness";

const MAINNET = "https://ethereum-rpc.publicnode.com";
const TOR = "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e";
let worker: any;

const body = (m: string, p: unknown[], id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p });
const bootstrapCall = async (method: string, params: unknown[]) => {
  const r = await fetch(MAINNET, { method: "POST", headers: { "content-type": "application/json" }, body: body(method, params) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};

async function call(url: string, b: string, key?: string) {
  const t0 = performance.now();
  try {
    const r = await worker.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: b,
      signal: AbortSignal.timeout(45000),
      ...(key ? { anonOptions: { isolationKey: key } } : {}),
    });
    const text = await r.text();
    return { ok: r.status < 400, status: r.status, ms: Math.round(performance.now() - t0), bytes: text.length, text };
  } catch (e) {
    return { ok: false, status: 0, ms: Math.round(performance.now() - t0), error: String((e as Error).message).slice(0, 80) };
  }
}
const strip = (r: any) => { const { text, ...rest } = r; return rest; };

(window as any).probe = {
  async boot(config: any) {
    const t0 = performance.now();
    worker = new AnonRpcWorker({
      address: TOR,
      config,
      preExisting: { rpcProvider: { request: ({ method, params }: any) => bootstrapCall(method, params ?? []) } },
    });
    (async () => { for (;;) { const e = await worker.acceptLog(); ((window as any).logs ??= []).push([Math.round(performance.now() - t0), e.level, e.args.join(" ").slice(0, 160)]); } })().catch(() => {});
    await worker.ready;
    return Math.round(performance.now() - t0);
  },
  logs: () => (window as any).logs ?? [],
  async one(url: string, method: string, params: unknown[], key?: string) { return strip(await call(url, body(method, params), key)); },
  /** exit IP seen under a key, to confirm isolation really changes the circuit */
  async ip(key?: string) {
    const r = await worker.fetch("https://check.torproject.org/api/ip", { ...(key ? { anonOptions: { isolationKey: key } } : {}) });
    return r.json();
  },
  async parallel(url: string, n: number, addrs: string[], key?: string) {
    const t0 = performance.now();
    const rs = await Promise.all(Array.from({ length: n }, (_, i) => call(url, body("eth_getBalance", [addrs[i % addrs.length], "latest"], i), key)));
    return { totalMs: Math.round(performance.now() - t0), ok: rs.filter((r) => r.ok).length, each: rs.map((r) => r.ms).sort((a, b) => a - b) };
  },
  async sequential(url: string, n: number, addrs: string[], key?: string) {
    const t0 = performance.now(); const each: number[] = []; let ok = 0;
    for (let i = 0; i < n; i++) { const r = await call(url, body("eth_getBalance", [addrs[i % addrs.length], "latest"], i), key); each.push(r.ms); if (r.ok) ok++; }
    return { totalMs: Math.round(performance.now() - t0), ok, each };
  },
  async batch(url: string, n: number, addrs: string[], key?: string) {
    const arr = Array.from({ length: n }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "eth_getBalance", params: [addrs[i % addrs.length], "latest"] }));
    const r = await call(url, JSON.stringify(arr), key);
    let results = 0; try { results = JSON.parse(r.text!).filter((x: any) => x.result).length; } catch {}
    return { ...strip(r), results };
  },
  /** Multicall3.aggregate3 of getEthBalance(addr) x n */
  async multicall(url: string, n: number, addrs: string[], key?: string) {
    const MC = "cA11bde05977b3631167028862bE2a173976CA11".toLowerCase();
    const w = (s: string) => s.padStart(64, "0");
    const elems = Array.from({ length: n }, (_, i) => "4d2301cc" + w(addrs[i % addrs.length].slice(2).toLowerCase()));
    // aggregate3((address target,bool allowFailure,bytes callData)[])
    let head = ""; let tail = ""; const elemLen = (32 * 3 + 32 + 64);
    for (let i = 0; i < n; i++) head += w((n * 32 + i * (elemLen)).toString(16));
    for (const e of elems) tail += w(MC) + w("1") + w("60") + w((36).toString(16)) + e.padEnd(128, "0");
    const data = "0x82ad56cb" + w("20") + w(n.toString(16)) + head + tail;
    const r = await call(url, body("eth_call", [{ to: "0x" + MC, data }, "latest"]), key);
    let hex = 0; try { hex = (JSON.parse(r.text!).result ?? "").length; } catch {}
    return { ...strip(r), resultHexLen: hex };
  },
};
