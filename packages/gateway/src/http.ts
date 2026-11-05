/* Non-RPC egress: the HTTP(S) proxy and the SDK's /canary/fetch route
   (agent-sdk.md §3.3).

   Per destination host, from the manifest:
     anon    → worker.fetch (Tor exit). Needs the request in the clear: the SDK
               route, plain HTTP through the proxy, or HTTPS with the MITM CA
               (not built yet). An `anon` HTTPS host through CONNECT is blocked.
     direct  → sent normally. Declared, counted.
     block   → refused.
     (none)  → manifest.undeclared: "block" (default) refuses; "report" sends
               it directly and counts it Undeclared, unless the request
               visibly carries an agent address, which is then blocked. */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { findAddress, isolationKeyFor, ruleFor, type AddressNeedles, type Category, type Channel, type Manifest } from "@canary/core";
import type { AnonBackend } from "./backend/types.js";
import type { Ledger } from "./ledger.js";

export type HttpContext = {
  backend: AnonBackend;
  ledger: Ledger;
  manifest: Manifest;
  needles: AddressNeedles[];
  timeoutMs: number;
};

export type OutboundRequest = { url: string; method: string; headers: Headers; body?: Uint8Array };

const HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"];
// fetch() decodes bodies; the relayed response must not claim the original encoding or length.
const RESPONSE_DROP = ["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"];

function refuse(decision: string, reason: string, status = 403): Response {
  return new Response(JSON.stringify({ error: reason, canary: decision }), { status, headers: { "content-type": "application/json", "x-canary-decision": decision, "x-canary-reason": reason } });
}

function relay(r: Response, decision: string): Response {
  const headers = new Headers(r.headers);
  for (const h of RESPONSE_DROP) headers.delete(h);
  headers.set("x-canary-decision", decision);
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
}

/** Decide and send one request whose URL and body Canary can see. */
export async function sendHttp(ctx: HttpContext, req: OutboundRequest, channel: Channel): Promise<Response> {
  const u = new URL(req.url);
  const host = u.host;
  const rule = ruleFor(ctx.manifest, u.hostname);
  const bodyText = req.body ? new TextDecoder().decode(req.body) : "";
  let headerText = "";
  req.headers.forEach((v, k) => (headerText += `${k}:${v}\n`));
  const taint = findAddress(`${req.url}\n${headerText}\n${bodyText}`, ctx.needles);
  const t0 = Date.now();
  const rec = (category: Category, note?: string) =>
    ctx.ledger.record({ category, channel, host, ms: Date.now() - t0, ...(taint ? { address: taint.address, encoding: taint.encoding } : {}), ...(note ? { note } : {}) });

  if (rule === "block") return rec("blocked", "declared block"), refuse("blocked", `${u.hostname} is blocked by the manifest`);
  if (rule === undefined) {
    if (ctx.manifest.undeclared === "block") return rec("blocked", "undeclared"), refuse("blocked", `${u.hostname} is not declared in the manifest`);
    if (taint) return rec("blocked", "undeclared and carries an agent address"), refuse("blocked", `${u.hostname} is not declared and the request carries an agent address`);
  }

  const headers = new Headers(req.headers);
  for (const h of HOP) headers.delete(h);
  const init: RequestInit = { method: req.method, headers, signal: AbortSignal.timeout(ctx.timeoutMs), ...(req.body && req.method !== "GET" && req.method !== "HEAD" ? { body: req.body as unknown as BodyInit } : {}) };

  if (rule === "anon") {
    try {
      const r = await ctx.backend.fetch(req.url, { ...init, ...(taint ? { anonOptions: { isolationKey: isolationKeyFor(taint.address) } } : {}) });
      rec("protected");
      return relay(r, "anon");
    } catch (e) {
      rec("failedClosed", (e as Error).message);
      return refuse("failed-closed", `anon path failed: ${(e as Error).message}`, 502);
    }
  }
  try {
    const r = await fetch(req.url, init);
    if (rule === undefined) rec("undeclared");
    else rec("direct", taint ? "carries an agent address (declared direct)" : undefined);
    return relay(r, rule === undefined ? "undeclared" : "direct");
  } catch (e) {
    rec("direct", `request failed: ${(e as Error).message}`);
    return refuse("error", (e as Error).message, 502);
  }
}

async function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined;
}

export function headersFrom(req: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
  }
  return h;
}

export async function writeResponse(res: import("node:http").ServerResponse, r: Response) {
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => (headers[k] = k === "set-cookie" ? [...((headers[k] as string[]) ?? []), v] : v));
  res.writeHead(r.status, headers);
  if (r.body) {
    try {
      for await (const c of r.body as any) if (!res.write(c)) await new Promise((ok) => res.once("drain", ok));
    } catch {
      res.destroy();
      return;
    }
  }
  res.end();
}

/** The HTTP(S) proxy agents point HTTPS_PROXY / HTTP_PROXY at. */
export function startProxy(ctx: HttpContext, port: number, hostname = "127.0.0.1"): Promise<Server> {
  const server = createServer(async (req, res) => {
    if (!req.url || !/^http:\/\//i.test(req.url)) {
      return res.writeHead(400, { "content-type": "text/plain" }).end("Canary proxy: send absolute-form http:// requests, or CONNECT for https.\n");
    }
    const r = await sendHttp(ctx, { url: req.url, method: req.method ?? "GET", headers: headersFrom(req), ...(await readBody(req).then((b) => (b ? { body: b } : {}))) }, "proxy");
    await writeResponse(res, r);
  });

  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    const [h, p] = (req.url ?? "").split(":");
    const target = req.url ?? "";
    const rule = ruleFor(ctx.manifest, h ?? "");
    const deny = (reason: string, note: string) => {
      ctx.ledger.record({ category: "blocked", channel: "connect", host: target, note });
      client.end(`HTTP/1.1 403 Forbidden\r\nx-canary-decision: blocked\r\nx-canary-reason: ${reason}\r\ncontent-length: 0\r\n\r\n`);
    };
    if (rule === "block") return deny("blocked by the manifest", "declared block");
    if (rule === "anon") return deny("anon HTTPS needs the MITM CA (not enabled); use the SDK or declare this host direct", "anon over CONNECT needs the MITM CA");
    if (rule === undefined && ctx.manifest.undeclared === "block") return deny("not declared in the manifest", "undeclared");

    const upstream = connect(Number(p || 443), h!, () => {
      client.write("HTTP/1.1 200 Connection Established\r\nx-canary-decision: " + (rule ?? "undeclared") + "\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    ctx.ledger.record({ category: rule === undefined ? "undeclared" : "direct", channel: "connect", host: target, note: "HTTPS body not inspected" });
    const kill = () => (upstream.destroy(), client.destroy());
    upstream.on("error", () => (client.writable && client.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n"), kill()));
    client.on("error", kill);
  });

  return new Promise((ok) => server.listen(port, hostname, () => ok(server)));
}
