/* Runs inside the headless Chromium page the gateway launches. Boots
   @anon-rpc/browser-harness and serves worker.fetch to the gateway over a
   loopback WebSocket (agent-sdk.md §3.1, "Gateway ↔ Chromium bridge").

   Frames, gateway → page (text JSON):
     {t:"req", id, url, method, headers, body?: base64, anonOptions?}
     {t:"ack", id}            one more body chunk may be sent (credit)
     {t:"abort", id}
   Frames, page → gateway:
     {t:"status", state, bootMs?, error?}     text
     {t:"log", level, args}                    text
     {t:"head", id, status, statusText, headers}  text
     {t:"end", id} | {t:"err", id, message}    text
     binary: [u32 id, big-endian][chunk bytes]  one body chunk */

import { AnonRpcWorker } from "@anon-rpc/browser-harness";

type Cfg = { token: string; specifier: string; workerConfig?: unknown; window: number };
const cfg: Cfg = JSON.parse(document.getElementById("canary-cfg")!.textContent!);

const ws = new WebSocket(`ws://${location.host}/bridge?t=${encodeURIComponent(cfg.token)}`);
ws.binaryType = "arraybuffer";
const send = (v: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(v));
const opened = new Promise<void>((r) => ws.addEventListener("open", () => r(), { once: true }));

const t0 = performance.now();
const worker = new AnonRpcWorker({
  address: cfg.specifier as `0x${string}`,
  ...(cfg.workerConfig === undefined ? {} : { config: cfg.workerConfig as any }),
  preExisting: {
    rpcProvider: {
      // The specifier is read by the gateway's Node process, same origin, no CORS.
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        const r = await fetch(`/bootstrap?t=${encodeURIComponent(cfg.token)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
        });
        const j = await r.json();
        if (j.error) throw new Error(j.error.message ?? "bootstrap RPC error");
        return j.result;
      },
    },
  } as any,
});

void opened.then(() => send({ t: "status", state: "warming" }));
worker.ready.then(
  async () => (await opened, send({ t: "status", state: "ready", bootMs: Math.round(performance.now() - t0) })),
  async (e: unknown) => (await opened, send({ t: "status", state: "failed", error: String((e as Error)?.message ?? e) })),
);
void (async () => {
  await opened;
  for (;;) {
    try {
      const e = await worker.acceptLog();
      send({ t: "log", level: e.level, args: e.args.map((a: unknown) => (typeof a === "string" ? a : safe(a))) });
    } catch {
      return;
    }
  }
})();

function safe(v: unknown) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

type Call = { ac: AbortController; credit: number; wake?: () => void };
const calls = new Map<number, Call>();

const FRAME = 256 * 1024;
const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function sendChunk(id: number, bytes: Uint8Array) {
  const buf = new Uint8Array(4 + bytes.byteLength);
  new DataView(buf.buffer).setUint32(0, id);
  buf.set(bytes, 4);
  ws.send(buf);
}

async function serve(m: any) {
  const call: Call = { ac: new AbortController(), credit: cfg.window };
  calls.set(m.id, call);
  try {
    const init: any = {
      method: m.method,
      headers: m.headers,
      signal: call.ac.signal,
      ...(m.body !== undefined ? { body: b64ToBytes(m.body) } : {}),
      ...(m.anonOptions ? { anonOptions: m.anonOptions } : {}),
    };
    const res = await worker.fetch(m.url, init);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    send({ t: "head", id: m.id, status: res.status, statusText: res.statusText, headers });
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Workers may hand over a whole body at once (the passthrough worker
        // does); send it in frames of at most FRAME bytes, one credit each.
        for (let off = 0; off < value.byteLength; off += FRAME) {
          while (call.credit <= 0) await new Promise<void>((r) => (call.wake = r));
          call.credit--;
          sendChunk(m.id, value.subarray(off, off + FRAME));
        }
      }
    }
    send({ t: "end", id: m.id });
  } catch (e) {
    send({ t: "err", id: m.id, message: String((e as Error)?.name === "AbortError" ? "aborted" : ((e as Error)?.message ?? e)) });
  } finally {
    calls.delete(m.id);
  }
}

ws.addEventListener("message", (ev) => {
  if (typeof ev.data !== "string") return;
  const m = JSON.parse(ev.data);
  if (m.t === "req") void serve(m);
  else if (m.t === "ack") {
    const c = calls.get(m.id);
    if (c) {
      c.credit += typeof m.n === "number" ? m.n : 1;
      c.wake?.();
      c.wake = undefined;
    }
  } else if (m.t === "abort") calls.get(m.id)?.ac.abort();
});
