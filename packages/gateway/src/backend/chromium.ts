/* The `chromium` AnonBackend: a headless Chromium the gateway manages, running
   @anon-rpc/browser-harness in a local page. It's what works today (the
   browser harness is tested; the Node harness can't run tor-js yet).

   One browser per gateway; many agents per gateway. If Chromium dies, every
   pending call fails (fail closed) and the backend relaunches it. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { AnonBackend, AnonInit, BackendStatus, NetworkConfig, WorkerLog } from "./types.js";

export type ChromiumOptions = {
  network: NetworkConfig;
  /** path to a Chrome/Chromium binary; or use `channel` ("chrome") or Playwright's own Chromium */
  executablePath?: string;
  channel?: string;
  headless?: boolean;
  /** extra Chromium flags. `--disable-web-security` only ever for the passthrough worker in development. */
  args?: string[];
  /** body chunks the page may send ahead of the consumer (backpressure window) */
  window?: number;
  /** relaunch Chromium after a crash (default true) */
  restart?: boolean;
};

type Pending = {
  resolveHead: (r: Response) => void;
  reject: (e: Error) => void;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  headDone: boolean;
  enqueued: number;
};

const PAGE_JS = resolve(import.meta.dirname, "page.js");
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

export class ChromiumBackend implements AnonBackend {
  readonly name = "chromium";
  ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: Error) => void;
  private st: BackendStatus;
  private server?: Server;
  private wss?: WebSocketServer;
  private sock?: WebSocket;
  private sockWaiters: ((s: WebSocket) => void)[] = [];
  private browser?: any;
  private token = randomBytes(16).toString("hex");
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private logListeners: ((l: WorkerLog) => void)[] = [];
  private closed = false;
  private failures = 0;

  constructor(private opts: ChromiumOptions) {
    this.st = { backend: "chromium", network: opts.network.label ?? opts.network.id, state: "starting", restarts: 0 };
    this.ready = this.newReady();
  }

  private newReady() {
    const p = new Promise<void>((res, rej) => ((this.resolveReady = res), (this.rejectReady = rej)));
    p.catch(() => {}); // observed through status() and fetch()
    return p;
  }

  status(): BackendStatus {
    return { ...this.st };
  }

  onLog(listener: (l: WorkerLog) => void) {
    this.logListeners.push(listener);
  }

  /** Start the local page server and launch Chromium. Resolves once the page is loaded (not once the worker is ready). */
  async start(): Promise<this> {
    const pageJs = await readFile(PAGE_JS, "utf8").catch(() => {
      throw new Error(`missing ${PAGE_JS}: run "npm run build" in packages/gateway`);
    });
    this.server = createServer((req, res) => void this.handle(req, res, pageJs));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    this.server.on("upgrade", (req, socket, head) => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname !== "/bridge" || u.searchParams.get("t") !== this.token) return socket.destroy();
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.attach(ws));
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    await this.launch();
    return this;
  }

  private async handle(req: IncomingMessage, res: ServerResponse, pageJs: string) {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.searchParams.get("t") !== this.token) return res.writeHead(403).end();
    if (req.method === "GET" && u.pathname === "/") {
      const cfg = { token: this.token, specifier: this.opts.network.specifier, workerConfig: this.opts.network.workerConfig, window: this.opts.window ?? 8 };
      const json = JSON.stringify(cfg).replace(/</g, "\\u003c");
      return res
        .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        .end(`<!doctype html><meta charset="utf-8"><title>canary anon backend</title><script id="canary-cfg" type="application/json">${json}</script><script type="module" src="/page.js?t=${this.token}"></script>`);
    }
    if (req.method === "GET" && u.pathname === "/page.js") {
      return res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(pageJs);
    }
    if (req.method === "POST" && u.pathname === "/bootstrap") {
      // Only the specifier read goes here; it leaves from the gateway's own IP (as in the extension).
      let body = "";
      for await (const c of req) body += c;
      try {
        const r = await fetch(this.opts.network.bootstrapRpc, { method: "POST", headers: { "content-type": "application/json" }, body });
        return res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text());
      } catch (e) {
        return res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: `bootstrap RPC unreachable: ${(e as Error).message}` } }));
      }
    }
    res.writeHead(404).end();
  }

  private async launch() {
    let chromium: any;
    try {
      ({ chromium } = await import("playwright-core"));
    } catch {
      throw new Error('the chromium backend needs "playwright-core" (npm i playwright-core)');
    }
    this.setState("starting");
    const t0 = Date.now();
    const browser = await chromium.launch({
      headless: this.opts.headless ?? true,
      ...(this.opts.executablePath ? { executablePath: this.opts.executablePath } : {}),
      ...(this.opts.channel ? { channel: this.opts.channel } : {}),
      args: this.opts.args ?? [],
    });
    this.browser = browser;
    // Only the current browser counts: closing an old one after a crash must not trigger another restart.
    browser.on("disconnected", () => this.browser === browser && this.crashed("Chromium exited"));
    const page = await browser.newPage();
    page.on("crash", () => this.browser === browser && this.crashed("Chromium page crashed"));
    page.on("pageerror", (e: Error) => this.emitLog({ level: "error", args: ["[page]", e.message] }));
    const port = (this.server!.address() as any).port;
    await page.goto(`http://127.0.0.1:${port}/?t=${this.token}`);
    this.st.bootMs = undefined;
    this.bootStart = t0;
  }
  private bootStart = 0;

  private attach(ws: WebSocket) {
    this.sock?.close();
    this.sock = ws;
    for (const w of this.sockWaiters.splice(0)) w(ws);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return this.onChunk(data as Buffer);
      const m = JSON.parse(String(data));
      switch (m.t) {
        case "status":
          if (m.state === "ready") {
            this.setState("ready", { bootMs: Date.now() - this.bootStart });
            this.failures = 0;
            this.resolveReady();
          } else if (m.state === "failed") {
            // e.g. bootstrap RPC or gateway briefly unreachable: fail closed now, retry with backoff.
            this.crashed(`anon-rpc worker failed to boot: ${m.error}`);
          } else this.setState(m.state);
          return;
        case "log":
          return this.emitLog({ level: m.level, args: m.args });
        case "head":
          return this.onHead(m);
        case "end": {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          return p?.controller?.close();
        }
        case "err": {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          const e = new Error(`anon path: ${m.message}`);
          if (p && !p.headDone) p.reject(e);
          else p?.controller?.error(e);
          return;
        }
      }
    });
    ws.on("close", () => {
      if (this.sock === ws) this.sock = undefined;
    });
  }

  private onHead(m: any) {
    const p = this.pending.get(m.id);
    if (!p) return;
    p.headDone = true;
    const id = m.id as number;
    let acked = 0;
    const body = NULL_BODY.has(m.status)
      ? null
      : new ReadableStream<Uint8Array>(
          {
            start: (c) => void (p.controller = c),
            // Return one credit to the page for every chunk the consumer has taken.
            pull: (c) => {
              const consumed = p.enqueued - Math.max(0, -(c.desiredSize ?? 0));
              if (consumed > acked) this.sock?.send(JSON.stringify({ t: "ack", id, n: consumed - acked }));
              acked = Math.max(acked, consumed);
            },
            cancel: () => {
              this.pending.delete(id);
              this.sock?.send(JSON.stringify({ t: "abort", id }));
            },
          },
          { highWaterMark: 0 },
        );
    if (!body) this.pending.delete(id);
    p.resolveHead(new Response(body, { status: m.status, statusText: m.statusText, headers: m.headers }));
  }

  private onChunk(buf: Buffer) {
    const id = buf.readUInt32BE(0);
    const p = this.pending.get(id);
    if (!p?.controller) return;
    p.enqueued++;
    p.controller.enqueue(new Uint8Array(buf.subarray(4)));
  }

  private emitLog(l: WorkerLog) {
    for (const f of this.logListeners) f(l);
  }

  private setState(state: BackendStatus["state"], extra: Partial<BackendStatus> = {}) {
    this.st = { ...this.st, state, ...extra, ...(state === "ready" ? { error: undefined } : {}) };
  }

  private crashed(reason: string) {
    if (this.closed) return;
    const err = new Error(`anon path down: ${reason}`);
    for (const [, p] of this.pending) (p.headDone ? p.controller?.error(err) : p.reject(err));
    this.pending.clear();
    this.sock = undefined;
    this.setState("failed", { error: reason });
    this.rejectReady(err);
    if (this.opts.restart === false) return;
    const browser = this.browser;
    this.browser = undefined;
    void browser?.close().catch(() => {});
    this.st.restarts++;
    this.ready = this.newReady();
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.failures++, 6));
    setTimeout(() => {
      if (this.closed) return;
      void this.launch().catch((e) => this.crashed(`relaunch failed: ${(e as Error).message}`));
    }, delay).unref();
  }

  private socket(): Promise<WebSocket> {
    return this.sock ? Promise.resolve(this.sock) : new Promise((r) => this.sockWaiters.push(r));
  }

  async fetch(url: string, init: AnonInit = {}): Promise<Response> {
    if (this.closed) throw new Error("anon backend closed");
    if (this.st.state === "failed") throw new Error(`anon path down: ${this.st.error ?? "worker failed"}`);
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
    const id = this.nextId++;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    let body: string | undefined;
    if (init.body != null) body = Buffer.from(await new Response(init.body as BodyInit).arrayBuffer()).toString("base64");
    const ws = await this.socket();
    return new Promise<Response>((resolveHead, reject) => {
      this.pending.set(id, { resolveHead, reject, headDone: false, enqueued: 0 });
      signal?.addEventListener(
        "abort",
        () => {
          const p = this.pending.get(id);
          this.pending.delete(id);
          ws.send(JSON.stringify({ t: "abort", id }));
          const e = signal.reason ?? new DOMException("aborted", "AbortError");
          if (p && !p.headDone) p.reject(e);
          else p?.controller?.error(e);
        },
        { once: true },
      );
      ws.send(JSON.stringify({ t: "req", id, url, method: init.method ?? "GET", headers, ...(body !== undefined ? { body } : {}), ...(init.anonOptions ? { anonOptions: init.anonOptions } : {}) }));
    });
  }

  async close() {
    this.closed = true;
    this.setState("closed");
    for (const [, p] of this.pending) (p.headDone ? p.controller?.error(new Error("closed")) : p.reject(new Error("anon backend closed")));
    this.pending.clear();
    await this.browser?.close().catch(() => {});
    this.wss?.close();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

export async function startChromiumBackend(opts: ChromiumOptions): Promise<ChromiumBackend> {
  return new ChromiumBackend(opts).start();
}
