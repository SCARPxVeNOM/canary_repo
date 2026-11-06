// In-page half of ka-bench.mjs: boots one tor-js worker build and times reads.
// A build that isn't on chain is loaded through a stand-in specifier: the
// page's RPC provider answers workerHash()/workerResolvers() for SPEC with the
// bundle's real keccak256 and a local URL, so the harness still verifies the
// bytes it runs.
import { AnonRpcWorker } from "@anon-rpc/browser-harness";
import { keccak_256 } from "@noble/hashes/sha3";

const MAINNET = "https://ethereum-rpc.publicnode.com";
const ONCHAIN = "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e"; // tor-js 0.4.4
const SPEC = "0x000000000000000000000000000000000000c0de";
let worker: any;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sel = (sig: string) => "0x" + hex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);
const word = (n: number) => n.toString(16).padStart(64, "0");
const abiStrings = (xs: string[]) => {
  const enc = xs.map((x) => new TextEncoder().encode(x));
  let head = "", tail = "", off = xs.length * 32;
  for (const e of enc) { head += word(off); const padded = hex(e).padEnd(Math.ceil(e.length / 32) * 64, "0"); tail += word(e.length) + padded; off += 32 + padded.length / 2; }
  return "0x" + word(32) + word(xs.length) + head + tail;
};
const body = (m: string, p: unknown[], id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p });

async function call(url: string, b: string, key?: string) {
  const t0 = performance.now();
  try {
    const r = await worker.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: b, signal: AbortSignal.timeout(45000), ...(key ? { anonOptions: { isolationKey: key } } : {}) });
    const text = await r.text();
    let ok = r.status < 400; try { ok &&= JSON.parse(text).result !== undefined; } catch { ok = false; }
    return { ok, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), error: String((e as Error).message).slice(0, 120) };
  }
}

(window as any).probe = {
  async boot(config: any, bundleUrl?: string) {
    const t0 = performance.now();
    const hash = bundleUrl ? "0x" + hex(keccak_256(new Uint8Array(await (await fetch(bundleUrl)).arrayBuffer()))) : undefined;
    const provider = async (method: string, params: any[]) => {
      if (bundleUrl && method === "eth_call" && params[0]?.to?.toLowerCase() === SPEC) {
        if (params[0].data === sel("workerHash()")) return hash;
        if (params[0].data === sel("workerResolvers()")) return abiStrings([new URL(bundleUrl, location.href).href]);
      }
      const j = await (await fetch(MAINNET, { method: "POST", headers: { "content-type": "application/json" }, body: body(method, params) })).json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    };
    worker = new AnonRpcWorker({ address: bundleUrl ? SPEC : ONCHAIN, config, preExisting: { rpcProvider: { request: ({ method, params }: any) => provider(method, params ?? []) } } });
    (async () => { for (;;) { const e = await worker.acceptLog(); if (e.level !== "debug" && e.level !== "trace") console.log("[worker]", e.level, e.args.join(" ").slice(0, 200)); } })().catch(() => {});
    await worker.ready;
    return { bootMs: Math.round(performance.now() - t0), hash };
  },
  read: (url: string, addr: string, key?: string) => call(url, body("eth_getBalance", [addr, "latest"]), key),
  async parallel(url: string, addrs: string[], key?: string) {
    const t0 = performance.now();
    const rs = await Promise.all(addrs.map((a, i) => call(url, body("eth_getBalance", [a, "latest"], i), key)));
    return { totalMs: Math.round(performance.now() - t0), ok: rs.filter((r) => r.ok).length };
  },
};
