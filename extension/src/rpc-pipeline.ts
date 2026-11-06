// The path from "a JSON-RPC call Canary decided to send" to the anon-rpc
// worker. Each worker.fetch over tor-js costs ~1 s (a new Tor stream, TCP and
// TLS through three relays: tor-js sends `Connection: close`), so the cost is
// in the number of requests, not their size. Measured over tor-js
// (test-repo.md §14): 20 reads sent one by one took 43–55 s; as one JSON-RPC
// batch, 1.6–2.1 s.
//
//   cache     eth_chainId / net_version: per endpoint, for good.
//             eth_getCode: non-empty code, per endpoint + address + block.
//             eth_blockNumber: 2 s (blocks are 2–12 s apart).
//   dedupe    an identical call already in flight shares its answer.
//   batch     calls for the same endpoint AND isolation key that arrive within
//             `windowMs` leave as one JSON-RPC batch. Never across keys: that
//             would put two addresses' reads on one circuit.
//   split     an endpoint that refuses a batch for its size (HTTP 400/413) gets
//             it again in halves, and batches no larger from then on.
//
// Read methods only: background.ts forwards everything else untouched, so a
// write is never batched, shared, cached or retried.
//
// No chrome.* here, so the unit test can drive it in Node.

export type Call = { jsonrpc?: "2.0"; id?: unknown; method: string; params?: unknown };
/** A JSON-RPC response without its id: `{ result }` or `{ error }`. */
export type Answer = { result?: unknown; error?: { code: number; message: string; data?: unknown } };
export type Source = "cache" | "shared" | "network";
export type Outcome = { answer: Answer; source: Source };
export type Send = (target: string, body: string, isolationKey?: string) => Promise<{ status: number; text: string }>;

export type PipelineOptions = { windowMs: number; maxBatch: number; blockTtlMs: number; now: () => number };
export const DEFAULTS: PipelineOptions = { windowMs: 15, maxBatch: 20, blockTtlMs: 2000, now: () => Date.now() };

export type PipelineStats = {
  calls: number; // calls handed to the pipeline
  cacheHits: number; // answered from cache, no request
  shared: number; // joined an identical call already in flight
  requests: number; // worker.fetch calls actually made
  batchedCalls: number; // calls that left inside a batch of 2+
};

type Pending = { call: Call; resolve: (a: Answer) => void; reject: (e: unknown) => void };
type Queue = { target: string; key?: string; items: Pending[]; timer?: ReturnType<typeof setTimeout> };

const LATEST = new Set(["latest", "pending", "safe", "finalized", undefined]);

export class TransportError extends Error {}

export class RpcPipeline {
  readonly stats: PipelineStats = { calls: 0, cacheHits: 0, shared: 0, requests: 0, batchedCalls: 0 };
  private readonly opts: PipelineOptions;
  private readonly cache = new Map<string, { answer: Answer; until: number }>();
  private readonly inflight = new Map<string, Promise<Answer>>();
  private readonly queues = new Map<string, Queue>();
  // Endpoints that refused a larger batch: the size they get from then on.
  private readonly caps = new Map<string, number>();
  private readonly send: Send;

  constructor(send: Send, opts: Partial<PipelineOptions> = {}) {
    this.send = send;
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Answer one call to `target`, under `isolationKey` if it carries one of your addresses. */
  call(target: string, call: Call, isolationKey?: string): Promise<Outcome> {
    this.stats.calls++;
    const ck = cacheKey(target, call);
    if (ck) {
      const hit = this.cache.get(ck);
      if (hit && hit.until > this.opts.now()) {
        this.stats.cacheHits++;
        return Promise.resolve({ answer: hit.answer, source: "cache" });
      }
    }
    // Identical calls share one request whatever their key: the answer is the
    // same, and only one copy goes on the wire.
    const dk = target + "\n" + call.method + "\n" + JSON.stringify(call.params ?? []);
    const running = this.inflight.get(dk);
    if (running) {
      this.stats.shared++;
      return running.then((answer) => ({ answer, source: "shared" as const }));
    }
    const p = this.enqueue(target, call, isolationKey)
      .then((answer) => {
        if (ck && !answer.error) {
          const ttl = ttlFor(call, answer, this.opts.blockTtlMs);
          if (ttl > 0) this.cache.set(ck, { answer, until: this.opts.now() + ttl });
        }
        return answer;
      })
      .finally(() => this.inflight.delete(dk));
    this.inflight.set(dk, p);
    return p.then((answer) => ({ answer, source: "network" as const }));
  }

  /** Store an answer Canary already knows (e.g. the chain id of a read endpoint). */
  seed(target: string, method: string, params: unknown[], result: unknown) {
    const ck = cacheKey(target, { method, params });
    if (ck) this.cache.set(ck, { answer: { result }, until: Infinity });
  }

  private enqueue(target: string, call: Call, key?: string): Promise<Answer> {
    const qk = target + "\n" + (key ?? "");
    let q = this.queues.get(qk);
    if (!q) this.queues.set(qk, (q = { target, key, items: [] }));
    return new Promise<Answer>((resolve, reject) => {
      q!.items.push({ call, resolve, reject });
      if (q!.items.length >= Math.min(this.opts.maxBatch, this.caps.get(target) ?? Infinity)) this.flush(qk);
      else q!.timer ??= setTimeout(() => this.flush(qk), this.opts.windowMs);
    });
  }

  private flush(qk: string) {
    const q = this.queues.get(qk);
    if (!q) return;
    this.queues.delete(qk);
    if (q.timer) clearTimeout(q.timer);
    void this.dispatch(q.target, q.key, q.items);
  }

  private async dispatch(target: string, key: string | undefined, items: Pending[]) {
    const one = items.length === 1;
    const wire = items.map((it, i) => ({ jsonrpc: "2.0", id: i, method: it.call.method, params: it.call.params ?? [] }));
    this.stats.requests++;
    if (!one) this.stats.batchedCalls += items.length;
    let parsed: unknown;
    try {
      const r = await this.send(target, JSON.stringify(one ? wire[0] : wire), key);
      // Some endpoints refuse a batch past a size outright (dRPC's free plan: HTTP 400 past 3 calls). Reads are
      // safe to resend: halve the batch, and keep later ones to this endpoint that small.
      if (!one && (r.status === 400 || r.status === 413)) {
        const size = Math.ceil(items.length / 2);
        this.caps.set(target, Math.min(this.caps.get(target) ?? Infinity, size));
        for (let i = 0; i < items.length; i += size) void this.dispatch(target, key, items.slice(i, i + size));
        return;
      }
      if (r.status >= 400) throw new TransportError(`HTTP ${r.status} from ${hostOf(target)}`);
      parsed = JSON.parse(r.text);
    } catch (e) {
      for (const it of items) it.reject(e);
      return;
    }
    if (one) {
      const v = parsed as any;
      return items[0].resolve(v && typeof v === "object" && !Array.isArray(v) ? strip(v) : malformed());
    }
    // A batch answer is an array in any order. Some endpoints answer a batch
    // they don't accept with one error object: retry those calls one by one.
    if (!Array.isArray(parsed)) {
      for (const it of items) void this.dispatch(target, key, [it]);
      return;
    }
    const byId = new Map<number, any>();
    for (const v of parsed) if (v && typeof v === "object" && typeof v.id === "number") byId.set(v.id, v);
    items.forEach((it, i) => {
      const v = byId.get(i);
      if (v) it.resolve(strip(v));
      else void this.dispatch(target, key, [it]);
    });
  }
}

function cacheKey(target: string, call: Pick<Call, "method" | "params">): string | undefined {
  const p = (call.params ?? []) as unknown[];
  switch (call.method) {
    case "eth_chainId":
    case "net_version":
    case "eth_blockNumber":
      return `${target}\n${call.method}`;
    case "eth_getCode": {
      const tag = p[1];
      const block = LATEST.has(tag as string) ? "latest" : JSON.stringify(tag);
      return `${target}\n${call.method}\n${String(p[0]).toLowerCase()}\n${block}`;
    }
  }
  return undefined;
}

function ttlFor(call: Call, answer: Answer, blockTtlMs: number): number {
  switch (call.method) {
    case "eth_chainId":
    case "net_version":
      return Infinity;
    case "eth_blockNumber":
      return blockTtlMs;
    case "eth_getCode":
      // Contract code can appear later but doesn't change once deployed
      // (EIP-6780). Not so for an EIP-7702 delegation (0xef0100 + address):
      // the account can re-delegate or revoke at any time, so never cache it.
      return typeof answer.result === "string" && answer.result !== "0x" && !answer.result.toLowerCase().startsWith("0xef0100") ? Infinity : 0;
  }
  return 0;
}

const strip = (v: any): Answer => ("error" in v ? { error: v.error } : { result: v.result });
const malformed = (): Answer => ({ error: { code: -32603, message: "Canary: malformed response from the read endpoint" } });
const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };
