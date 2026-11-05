// Canary MAIN-world shim. Injected at document_start into every frame, after
// the bridge and before any page script.
//
// What it does, per outgoing request the page makes:
//   JSON-RPC (fetch, XHR, WebSocket)  → answered by the extension through anon-rpc
//   carries your address, third party → blocked
//   carries your address, first party → allowed, reported "detected, unprotected"
//   anything else                     → allowed, reported as backend traffic
//   body we can't read (Blob, stream) → allowed, reported "not inspected"
//
// It also learns your address(es) from the wallet (EIP-1193 / EIP-6963).
//
// Threat model reminder: the dapp itself always sees your address and IP. The
// page can also tamper with this shim (it shares the realm); Canary protects
// you from third parties, not from the page.

import {
  findAddress, isThirdParty, needlesFor, parseJsonRpc, SUBSTITUTABLE,
  type AddressNeedles, type Observation,
} from "./shared.js";

(() => {
  const W = window as any;
  if (W.__canaryShim) return;
  Object.defineProperty(W, "__canaryShim", { value: true });

  const TAG = "__canary";
  const origFetch: typeof fetch = window.fetch.bind(window);
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  const origSetHeader = XHR.setRequestHeader;
  const origWsSend = WebSocket.prototype.send;
  const origBeacon = navigator.sendBeacon?.bind(navigator);
  const pageHost = location.hostname;

  /* --- channel to the bridge ------------------------------------------- */

  type Config = { enabled: boolean; addresses: string[] };
  let port: MessagePort | null = null;
  let config: Config | null = null;
  let needles: AddressNeedles[] = [];
  let seq = 0;
  const pending = new Map<number, (r: any) => void>();
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));
  // If the bridge never answers (extension reloaded, context invalidated) we
  // stop waiting and get out of the page's way, loudly.
  setTimeout(() => {
    if (!config) {
      console.warn("[Canary] extension not reachable on this page; requests pass through untouched");
      config = { enabled: false, addresses: [] };
      resolveReady();
    }
  }, 5000);

  function applyConfig(c: Config) {
    config = c;
    // Merge, don't replace: the wallet may have handed out an address before
    // this reply arrived, and dropping it would let that address leak.
    const known = new Set(needles.map((n) => n.address));
    needles = [...needles, ...c.addresses.map((a) => a.toLowerCase()).filter((a) => !known.has(a)).map(needlesFor)];
    resolveReady();
  }

  function offer() {
    if (port) return;
    const ch = new MessageChannel();
    ch.port1.onmessage = (ev) => {
      const m = ev.data;
      if (m?.type === "ack") port = ch.port1;
      else if (m?.type === "config") applyConfig(m.config);
      else if (m?.type === "res") {
        const f = pending.get(m.id);
        if (f) (pending.delete(m.id), f(m));
      }
    };
    window.postMessage({ [TAG]: "hello" }, location.origin === "null" ? "*" : location.origin, [ch.port2]);
  }
  window.addEventListener("message", (ev) => {
    if (ev.source === window && ev.data?.[TAG] === "bridge-ready") offer();
  });
  offer();

  function ask(msg: any): Promise<any> {
    return new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      port!.postMessage({ ...msg, id });
    });
  }
  function observe(o: Observation) {
    port?.postMessage({ type: "obs", obs: o });
  }
  function addAddresses(list: unknown, chainId?: unknown) {
    const addrs = (Array.isArray(list) ? list : [])
      .filter((a): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a))
      .map((a) => a.toLowerCase());
    const fresh = addrs.filter((a) => !needles.some((n) => n.address === a));
    if (fresh.length) needles = [...needles, ...fresh.map(needlesFor)];
    if (fresh.length || chainId !== undefined) void ready.then(() => port?.postMessage({ type: "wallet", addresses: addrs, chainId }));
  }

  /* --- learning your address from the wallet --------------------------- */

  const wrapped = new WeakSet<object>();
  function wrapProvider(p: any) {
    if (!p || typeof p.request !== "function" || wrapped.has(p)) return;
    wrapped.add(p);
    const orig = p.request.bind(p);
    try {
      p.request = async (args: any) => {
        const res = await orig(args);
        if (args?.method === "eth_accounts" || args?.method === "eth_requestAccounts") addAddresses(res);
        if (args?.method === "eth_chainId") addAddresses([], Number(res));
        return res;
      };
    } catch {
      /* frozen provider: fall back to events */
    }
    try {
      p.on?.("accountsChanged", (a: unknown) => addAddresses(a));
      p.on?.("chainChanged", (c: unknown) => addAddresses([], Number(c)));
    } catch {
      /* ignore */
    }
    // Ask once, silently: eth_accounts never prompts.
    orig({ method: "eth_accounts" }).then((a: unknown) => addAddresses(a), () => {});
    orig({ method: "eth_chainId" }).then((c: unknown) => addAddresses([], Number(c)), () => {});
  }
  window.addEventListener("eip6963:announceProvider", (ev: any) => wrapProvider(ev?.detail?.provider));
  const pollEthereum = () => W.ethereum && wrapProvider(W.ethereum);
  queueMicrotask(pollEthereum);
  document.addEventListener("DOMContentLoaded", pollEthereum);
  window.addEventListener("load", pollEthereum);
  setTimeout(() => window.dispatchEvent(new Event("eip6963:requestProvider")), 0);

  /* --- classification -------------------------------------------------- */

  type Verdict =
    | { kind: "rpc"; url: string; body: string; methods: string[] }
    | { kind: "block"; obs: Observation }
    | { kind: "pass"; obs: Observation | null };

  function host(url: string) {
    try {
      return new URL(url, location.href).hostname;
    } catch {
      return "";
    }
  }

  function classify(channel: Observation["channel"], url: string, body: string | null, rpcAllowed: boolean): Verdict {
    const h = host(url);
    const third = isThirdParty(pageHost, h);
    if (body !== null && rpcAllowed) {
      const calls = parseJsonRpc(body);
      if (calls) return { kind: "rpc", url, body, methods: calls.map((c) => c.method) };
    }
    const taint = findAddress(url + "\n" + (body ?? ""), needles);
    if (taint && third) {
      return { kind: "block", obs: { category: "blocked", channel, host: h, firstParty: false, address: taint.address, encoding: taint.encoding } };
    }
    if (taint) {
      return { kind: "pass", obs: { category: "detected", channel, host: h, firstParty: true, address: taint.address, encoding: taint.encoding } };
    }
    if (body === null) return { kind: "pass", obs: { category: "notInspected", channel, host: h, firstParty: !third, note: "unreadable body" } };
    return { kind: "pass", obs: { category: "backend", channel, host: h, firstParty: !third } };
  }

  async function bodyText(b: unknown): Promise<string | null> {
    if (b === undefined || b === null) return "";
    if (typeof b === "string") return b;
    if (b instanceof URLSearchParams) return b.toString();
    if (b instanceof Blob) return b.size < 1_000_000 ? b.text() : null;
    if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b as ArrayBuffer);
    if (b instanceof FormData) {
      const parts: string[] = [];
      b.forEach((v, k) => parts.push(`${k}=${typeof v === "string" ? v : "[file]"}`));
      return parts.join("&");
    }
    return null; // ReadableStream and friends
  }

  async function rpcViaCanary(url: string, body: string, channel: Observation["channel"]) {
    return ask({ type: "rpc", url, body, channel, pageHost });
  }

  const isStatic = (url: string) => /\.(js|mjs|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|map|wasm)(\?|$)/i.test(url);

  /* --- fetch ----------------------------------------------------------- */

  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    await ready;
    if (!config!.enabled) return origFetch(input as RequestInfo, init);
    let url: string, method: string, body: string | null;
    if (input instanceof Request) {
      url = input.url;
      method = (init?.method ?? input.method).toUpperCase();
      body = init?.body !== undefined ? await bodyText(init.body) : method === "GET" || method === "HEAD" ? "" : await input.clone().text().catch(() => null);
    } else {
      url = new URL(String(input), location.href).href;
      method = (init?.method ?? "GET").toUpperCase();
      body = await bodyText(init?.body);
    }
    if (method === "GET" && isStatic(url)) return origFetch(input as RequestInfo, init);
    const v = classify("fetch", url, body, method === "POST");
    if (v.kind === "rpc") {
      const r = await rpcViaCanary(v.url, v.body, "fetch");
      if (r.passthrough) return origFetch(input as RequestInfo, init);
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    }
    if (v.kind === "block") {
      observe(v.obs);
      throw new TypeError("Failed to fetch");
    }
    if (v.obs) observe(v.obs);
    return origFetch(input as RequestInfo, init);
  } as typeof fetch;

  /* --- XMLHttpRequest (web3.js and older stacks) ------------------------ */

  const meta = new WeakMap<XMLHttpRequest, { method: string; url: string; headers: [string, string][] }>();
  XHR.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
    meta.set(this, { method: String(method).toUpperCase(), url: new URL(String(url), location.href).href, headers: [] });
    return (origOpen as any).call(this, method, url, ...rest);
  };
  XHR.setRequestHeader = function (this: XMLHttpRequest, k: string, v: string) {
    meta.get(this)?.headers.push([k, v]);
    return origSetHeader.call(this, k, v);
  };

  function settleXhr(xhr: XMLHttpRequest, status: number, text: string, url: string) {
    const def = (k: string, v: unknown) => Object.defineProperty(xhr, k, { configurable: true, get: () => v });
    def("readyState", 4);
    def("status", status);
    def("statusText", status === 200 ? "OK" : "");
    def("responseURL", url);
    def("responseText", text);
    def("response", xhr.responseType === "json" ? (() => { try { return JSON.parse(text); } catch { return null; } })() : text);
    xhr.getResponseHeader = (n: string) => (n.toLowerCase() === "content-type" && status ? "application/json" : null);
    xhr.getAllResponseHeaders = () => (status ? "content-type: application/json\r\n" : "");
    for (const t of status ? ["readystatechange", "load", "loadend"] : ["readystatechange", "error", "loadend"]) {
      xhr.dispatchEvent(new ProgressEvent(t));
    }
  }

  XHR.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const m = meta.get(this);
    const xhr = this;
    if (!m) return origSend.call(this, body as any);
    void (async () => {
      await ready;
      if (!config!.enabled) return origSend.call(xhr, body as any);
      const text = body instanceof Document ? null : await bodyText(body);
      if (m.method === "GET" && isStatic(m.url)) return origSend.call(xhr, body as any);
      const v = classify("xhr", m.url, text, m.method === "POST");
      if (v.kind === "rpc") {
        const r = await rpcViaCanary(v.url, v.body, "xhr");
        if (r.passthrough) return origSend.call(xhr, body as any);
        return settleXhr(xhr, r.status, r.body, m.url);
      }
      if (v.kind === "block") {
        observe(v.obs);
        return settleXhr(xhr, 0, "", m.url);
      }
      if (v.obs) observe(v.obs);
      origSend.call(xhr, body as any);
    })();
  };

  /* --- WebSocket --------------------------------------------------------
     Read requests are answered through anon-rpc and delivered as a message
     event; the socket never carries them. Subscriptions and other methods
     can't be substituted over HTTP, so they go out and are reported. */

  WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    const ws = this;
    if (!config?.enabled || typeof data !== "string") {
      if (config?.enabled) observe({ category: "notInspected", channel: "websocket", host: host(ws.url), firstParty: !isThirdParty(pageHost, host(ws.url)), note: "binary frame" });
      return origWsSend.call(ws, data as any);
    }
    const calls = parseJsonRpc(data);
    if (calls && calls.every((c) => SUBSTITUTABLE.has(c.method))) {
      void rpcViaCanary(ws.url.replace(/^ws/, "http"), data, "websocket").then((r) => {
        if (r.passthrough) return origWsSend.call(ws, data);
        ws.dispatchEvent(new MessageEvent("message", { data: r.body, origin: new URL(ws.url).origin }));
      });
      return;
    }
    const h = host(ws.url);
    const third = isThirdParty(pageHost, h);
    const taint = findAddress(data, needles);
    if (taint && third && !calls) {
      observe({ category: "blocked", channel: "websocket", host: h, firstParty: false, address: taint.address, encoding: taint.encoding });
      return;
    }
    observe(calls
      ? { category: "detected", channel: "websocket", host: h, firstParty: !third, address: taint?.address, methods: calls.map((c) => c.method), note: "WebSocket RPC that can't be substituted" }
      : taint
        ? { category: "detected", channel: "websocket", host: h, firstParty: true, address: taint.address, encoding: taint.encoding }
        : { category: "backend", channel: "websocket", host: h, firstParty: !third });
    return origWsSend.call(ws, data);
  };

  /* --- sendBeacon -------------------------------------------------------
     Synchronous API, so it can't wait for config. Strings and URLSearchParams
     are checked against the addresses known so far; Blobs can't be read
     synchronously and are reported as not inspected. */

  if (origBeacon) {
    navigator.sendBeacon = function (url: string | URL, data?: BodyInit | null): boolean {
      if (config && !config.enabled) return origBeacon(url, data);
      const u = new URL(String(url), location.href).href;
      const text = data == null ? "" : typeof data === "string" ? data : data instanceof URLSearchParams ? data.toString() : null;
      const v = classify("beacon", u, text, false);
      if (v.kind === "block") {
        observe(v.obs);
        return true; // the page believes it was queued
      }
      if (v.kind === "pass" && v.obs) observe(v.obs);
      return origBeacon(url, data);
    };
  }
})();
