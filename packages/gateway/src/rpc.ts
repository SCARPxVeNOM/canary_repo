/* The gateway's JSON-RPC endpoint (docs/agent-sdk.md §3.2).

   standard read           → SUBSTITUTE: the chain's read endpoint, via anon-rpc   (Protected)
   other method            → FORWARD: the chain's upstream, via anon-rpc           (Protected, IP only)
   eth_sendRawTransaction  → per manifest rpc.write: anon | private | direct
   eth_chainId/net_version → answered locally (the operator configured the chain)
   eth_fillTransaction     → answered locally: not supported (clients fill from the standard reads)
   node-side signing       → refused: agents sign locally
   anon path down          → FAIL CLOSED: a JSON-RPC error, never a direct retry

   Isolation: a call carrying one agent address goes out under
   isolationKey "addr:<address>". A batch is split so that calls for different
   wallets never share a request. A single call carrying two agent addresses
   can't be split; it goes under the first and is counted as "links wallets". */

import {
  BROADCAST, NODE_SIGNING, SUBSTITUTABLE, findAddresses, isolationKeyFor, isBatchBody, parseJsonRpc,
  rpcError, rpcResult, type AddressNeedles, type Category, type Manifest, type RpcCall, type RpcResponse,
} from "@canary/core";
import type { AnonBackend } from "./backend/types.js";
import type { Ledger } from "./ledger.js";

export type ChainConfig = {
  /** RPC that answers substituted reads. Must accept Tor traffic (not Tenderly). */
  read: string;
  /** RPC for non-standard methods; defaults to `read` */
  upstream?: string;
  /** where eth_sendRawTransaction goes in "anon" mode; defaults to `read` */
  broadcast?: string;
  /** private relay for rpc.write = "private" */
  privateRelay?: string;
};

export type RpcContext = {
  backend: AnonBackend;
  ledger: Ledger;
  manifest: Manifest;
  chains: Record<string, ChainConfig>;
  needles: AddressNeedles[];
  timeoutMs: number;
  codeCacheMs: number;
  codeCache: Map<string, { at: number; result: unknown }>;
  /** random 0..jitterMs delay before substituted reads (blurs polling schedules) */
  jitterMs?: number;
  /** re-send a read on a fresh circuit if the first hasn't answered in this long (default 3000; 0 = off). Never broadcasts. */
  hedgeMs?: number;
  /** isolation key (or "shared") → the key of the circuit currently used for it (see sendHedged) */
  circuitFor?: Map<string, string>;
};

type Route = { via: "anon" | "direct"; url: string; category: Category; note?: string };

/* viem's sendTransaction with a local account asks for eth_fillTransaction
   first, and falls back to eth_getTransactionCount / eth_estimateGas / fees
   when the node says "method not found" (-32601), remembering that per
   client. Forwarded, the call depended on the upstream: a load-balanced one
   (1rpc.io) answered some requests over Tor with a body that isn't JSON-RPC,
   which became -32603 here, which viem retries three times before falling
   back, on every transaction. Answered here, the client goes straight to the
   standard reads, which are substituted like any other. */
const FILL = new Set(["eth_fillTransaction"]);
type Plan = { i: number; call: RpcCall; route?: Route; local?: RpcResponse; key?: string; address?: string; linked: boolean; category?: Category; note?: string };

const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

function plan(ctx: RpcContext, chainId: string, call: RpcCall, i: number): Plan {
  const chain = ctx.chains[chainId]!;
  const addrs = findAddresses(JSON.stringify(call.params ?? []), ctx.needles);
  const base: Plan = { i, call, linked: addrs.length > 1, ...(addrs[0] ? { key: isolationKeyFor(addrs[0]), address: addrs[0] } : {}) };
  const m = call.method;
  if (m === "eth_chainId") return { ...base, local: rpcResult(call.id, "0x" + Number(chainId).toString(16)), category: "protected", note: "answered locally" };
  if (m === "net_version") return { ...base, local: rpcResult(call.id, String(Number(chainId))), category: "protected", note: "answered locally" };
  if (FILL.has(m)) return { ...base, local: rpcError(call.id, `${m} is not supported by the Canary gateway: fill the transaction from eth_getTransactionCount, eth_estimateGas and the fee reads`, -32601), category: "protected", note: "answered locally: not supported" };
  if (NODE_SIGNING.has(m)) return { ...base, local: rpcError(call.id, `Canary never signs: sign locally and send eth_sendRawTransaction (${m} refused)`, -32601), category: "blocked" };
  if (m === "eth_getCode") {
    const hit = ctx.codeCache.get(`${chainId}:${JSON.stringify(call.params)}`);
    if (hit && Date.now() - hit.at < ctx.codeCacheMs) return { ...base, local: rpcResult(call.id, hit.result), category: "protected", note: "cached" };
  }
  if (BROADCAST.has(m)) {
    const mode = ctx.manifest.rpc.write;
    if (mode === "direct") return { ...base, route: { via: "direct", url: chain.broadcast ?? chain.read, category: "direct", note: "broadcast, declared direct" } };
    if (mode === "private") {
      if (!chain.privateRelay) return { ...base, local: rpcError(call.id, "rpc.write is \"private\" but no privateRelay is configured for this chain"), category: "failedClosed" };
      return { ...base, route: { via: "anon", url: chain.privateRelay, category: "protectedIpOnly", note: "broadcast via private relay" } };
    }
    return { ...base, route: { via: "anon", url: chain.broadcast ?? chain.read, category: "protectedIpOnly", note: "broadcast" } };
  }
  if (SUBSTITUTABLE.has(m)) return { ...base, route: { via: "anon", url: chain.read, category: "protected" } };
  return { ...base, route: { via: "anon", url: chain.upstream ?? chain.read, category: "protectedIpOnly" } };
}

/* Hedged on a fresh circuit, as the extension does (extension/src/background.ts):
   if an anon read fails, or hasn't answered in hedgeMs, the same read goes out
   again under a new isolation key, so tor-js builds a new circuit, and the first
   answer wins. Measured in the extension: a circuit whose gateway or exit died
   otherwise stalls until the request timeout (15-35 s). When the hedge wins, its
   circuit is used for that key from then on. The hedge key is derived from the
   original, so a hedge for one wallet never shares a circuit with another.
   Reads only: a broadcast is never sent twice. */
let hedgeSeq = 0;
async function sendHedged(ctx: RpcContext, route: Route, key: string | undefined, body: string): Promise<{ status: number; text: string }> {
  const hedgeMs = ctx.hedgeMs ?? 3000;
  if (route.via !== "anon" || !hedgeMs) return send(ctx, route, key, body);
  const circuits = (ctx.circuitFor ??= new Map());
  const base = key ?? "shared";
  const current = circuits.get(base) ?? key;
  const first = send(ctx, route, current, body);
  let firstWon = false;
  first.then(() => (firstWon = true), () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const second = new Promise<{ status: number; text: string }>((resolve, reject) => {
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      clearTimeout(timer);
      const fresh = `${base}#hedge${++hedgeSeq}`;
      send(ctx, route, fresh, body).then((r) => {
        if (!firstWon && (circuits.get(base) ?? key) === current) circuits.set(base, fresh);
        resolve(r);
      }, reject);
    };
    timer = setTimeout(go, hedgeMs);
    first.catch(go);
  });
  try {
    return await Promise.any([first, second]);
  } catch (e) {
    throw (e as AggregateError).errors?.[1] ?? (e as AggregateError).errors?.[0] ?? e;
  } finally {
    clearTimeout(timer);
  }
}

async function send(ctx: RpcContext, route: Route, key: string | undefined, body: string): Promise<{ status: number; text: string }> {
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(ctx.timeoutMs),
  };
  const r = route.via === "anon" ? await ctx.backend.fetch(route.url, { ...init, ...(key ? { anonOptions: { isolationKey: key } } : {}) }) : await fetch(route.url, init);
  return { status: r.status, text: await r.text() };
}

/** Handle one HTTP body sent to /<chainId>. Returns the HTTP status and response body. */
export async function handleRpc(ctx: RpcContext, chainId: string, text: string): Promise<{ status: number; body: string }> {
  const calls = parseJsonRpc(text);
  if (!calls) return { status: 400, body: JSON.stringify(rpcError(null, "Parse error: not a JSON-RPC request", -32700)) };
  if (!ctx.chains[chainId]) {
    const err = (c: RpcCall) => rpcError(c.id, `chain ${chainId} is not configured on this gateway`, -32602);
    return { status: 200, body: JSON.stringify(isBatchBody(text) ? calls.map(err) : err(calls[0]!)) };
  }
  const plans = calls.map((c, i) => plan(ctx, chainId, c, i));
  const out: RpcResponse[] = new Array(calls.length);

  for (const p of plans) {
    if (!p.local) continue;
    out[p.i] = p.local;
    ctx.ledger.record({ category: p.category!, channel: "rpc", host: "gateway", methods: [p.call.method], ...(p.note ? { note: p.note } : {}) });
  }

  // Group the rest by destination and isolation key: one request per group.
  const groups = new Map<string, Plan[]>();
  for (const p of plans) {
    if (p.local || !p.route) continue;
    const g = `${p.route.via}|${p.route.url}|${p.key ?? ""}`;
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }

  await Promise.all(
    [...groups.values()].map(async (group) => {
      const route = group[0]!.route!;
      // Our own ids, so answers map back even if the agent reused ids across groups.
      const wire = group.map((p, j) => ({ ...p.call, jsonrpc: "2.0" as const, id: j + 1 }));
      if (ctx.jitterMs && route.category === "protected") await new Promise((r) => setTimeout(r, Math.random() * ctx.jitterMs!));
      const t0 = Date.now();
      let answers: RpcResponse[] | undefined;
      let failure: string | undefined;
      try {
        const isBroadcast = group.some((p) => BROADCAST.has(p.call.method));
        const payload = JSON.stringify(wire.length === 1 ? wire[0] : wire);
        const r = isBroadcast ? await send(ctx, route, group[0]!.key, payload) : await sendHedged(ctx, route, group[0]!.key, payload);
        try {
          const v = JSON.parse(r.text);
          answers = Array.isArray(v) ? v : [v];
        } catch {
          failure = `upstream answered HTTP ${r.status} without JSON-RPC`;
        }
      } catch (e) {
        failure = route.via === "anon" ? `anon path failed: ${(e as Error).message}` : `request failed: ${(e as Error).message}`;
      }
      const ms = Date.now() - t0;
      const byId = new Map(answers?.map((a) => [a.id, a]));
      group.forEach((p, j) => {
        const a = byId.get(j + 1);
        const ok = !failure && a;
        out[p.i] = ok ? { ...a, id: p.call.id ?? null } : rpcError(p.call.id, failure ?? "no answer for this call in the upstream response");
        const notes = [route.note, p.linked ? "links wallets (one call carries several agent addresses)" : undefined].filter(Boolean).join("; ");
        ctx.ledger.record({
          category: ok ? route.category : route.via === "anon" ? "failedClosed" : "direct",
          channel: "rpc",
          host: host(route.url),
          methods: [p.call.method],
          ms,
          ...(p.address ? { address: p.address } : {}),
          ...(notes || !ok ? { note: [notes, ok ? undefined : (failure ?? "no answer for this call")].filter(Boolean).join("; ") } : {}),
        });
        if (ok && p.call.method === "eth_getCode" && a.result !== undefined) ctx.codeCache.set(`${chainId}:${JSON.stringify(p.call.params)}`, { at: Date.now(), result: a.result });
      });
    }),
  );

  return { status: 200, body: JSON.stringify(isBatchBody(text) ? out : out[0]) };
}
