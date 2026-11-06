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
  findAddress, isThirdParty, needlesFor, parseJsonRpc, sampleCall, snippetAround, SUBSTITUTABLE,
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

  type Config = { enabled: boolean; addresses: string[]; blockHosts?: string[] };
  let port: MessagePort | null = null;
  let config: Config | null = null;
  let needles: AddressNeedles[] = [];
  let seq = 0;
  const pending = new Map<number, (r: any) => void>();
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));
  // Your addresses the service worker has confirmed are blocked in URLs, and confirmations on their way.
  const ruled = new Set<string>();
  const ruling = new Map<string, Promise<void>>();
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
    for (const a of c.addresses) ruled.add(a.toLowerCase()); // the service worker's rules cover these already
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
  /** Learns addresses. Returns a promise while the rules that block URLs carrying any of them aren't confirmed yet:
      the page gets the address only after it. Each address waits once, 1.5 s at most: a dapp must not hang on Canary. */
  function addAddresses(list: unknown, chainId?: unknown): Promise<void> | undefined {
    const addrs = (Array.isArray(list) ? list : [])
      .filter((a): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a))
      .map((a) => a.toLowerCase());
    const fresh = addrs.filter((a) => !needles.some((n) => n.address === a));
    if (fresh.length) needles = [...needles, ...fresh.map(needlesFor)];
    const unasked = addrs.filter((a) => !ruled.has(a) && !ruling.has(a));
    if (unasked.length || chainId !== undefined) {
      const told = ready.then(() => port && ask({ type: "wallet", addresses: addrs, chainId }));
      const settled = Promise.race([told, new Promise((r) => setTimeout(r, 1500))]);
      for (const a of unasked) ruling.set(a, settled.then(() => void (ruled.add(a), ruling.delete(a))));
    }
    const waits = addrs.filter((a) => !ruled.has(a)).map((a) => ruling.get(a));
    return waits.length ? Promise.all(waits).then(() => {}) : undefined;
  }

  /* --- learning your address from the wallet --------------------------- */

  const wrapped = new WeakSet<object>();
  function wrapProvider(p: any) {
    if (!p || typeof p.request !== "function" || wrapped.has(p)) return;
    wrapped.add(p);
    const orig = p.request.bind(p);
    // A new address reaches the page only once it's blocked in URLs: a pixel fired the
    // moment the dapp learns it would otherwise go out before the rule exists.
    override(p, "request", (request) => async function (this: unknown, args: any) {
      const res = await request.call(this ?? p, args);
      if (args?.method === "eth_accounts" || args?.method === "eth_requestAccounts") await addAddresses(res);
      if (args?.method === "eth_chainId") addAddresses([], Number(res));
      return res;
    });
    try {
      p.on?.("accountsChanged", (a: unknown) => addAddresses(a));
      p.on?.("chainChanged", (c: unknown) => addAddresses([], Number(c)));
    } catch {
      /* ignore */
    }
    holdAccountsChanged(p);
    // Ask once, silently: eth_accounts never prompts.
    orig({ method: "eth_accounts" }).then((a: unknown) => addAddresses(a), () => {});
    orig({ method: "eth_chainId" }).then((c: unknown) => addAddresses([], Number(c)), () => {});
  }

  /** Puts wrap(p[name]) in place of p[name]: on p itself, or, when p can't be changed (frozen,
      locked), on the class p gets the method from, for p alone. False when neither works. */
  function override(p: any, name: string, wrap: (orig: Function) => Function): boolean {
    const orig = p[name];
    if (typeof orig !== "function") return false;
    const mine = wrap(orig);
    try {
      p[name] = mine;
      if (p[name] === mine) return true;
    } catch {
      /* frozen or locked: try its class */
    }
    for (let o = Object.getPrototypeOf(p); o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, name);
      if (!d) continue;
      if (d.value !== orig) return false;
      try {
        Object.defineProperty(o, name, { ...d, value: function (this: unknown, ...a: unknown[]) { return (this === p ? mine : orig).apply(this, a); } });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** Deliveries held for a new address, run in the order they came: while one waits, later ones queue behind it. */
  function inOrder() {
    let tail: Promise<void> | undefined;
    return {
      busy: () => tail !== undefined,
      later(wait: Promise<void> | undefined, deliver: () => unknown) {
        const t: Promise<void> = (tail ?? Promise.resolve())
          .then(() => wait)
          .then(() => void deliver())
          .catch((e) => void setTimeout(() => { throw e; })); // a listener's error, reported as if it threw directly
        tail = t;
        void t.then(() => tail === t && (tail = undefined));
      },
    };
  }

  /* Switching to an account Canary hasn't seen fires the same pixels as connecting: the page hears
     of it only once the address is blocked in URLs. Held where the wallet sends it (its emit), so
     listeners the page added before Canary got to the wallet wait too; for wallets that call their
     listeners some other way, each listener added from here on is held. */
  function holdAccountsChanged(p: any) {
    const emits = inOrder();
    override(p, "emit", (emit) => function (this: unknown, event: unknown, ...args: unknown[]) {
      const wait = event === "accountsChanged" ? addAddresses(args[0]) : undefined;
      if (!wait && !emits.busy()) return emit.call(this, event, ...args);
      emits.later(wait, () => emit.call(this, event, ...args)); // later events too, so none overtakes a held one
      return true;
    });

    const calls = inOrder();
    const held = new WeakMap<Function, Function>();
    const heldFor = (f: Function) => {
      let g = held.get(f) as (Function & { listener?: unknown }) | undefined;
      if (!g) {
        g = function (this: unknown, ...args: unknown[]) {
          const wait = addAddresses(args[0]);
          if (!wait && !calls.busy()) return f.apply(this, args);
          calls.later(wait, () => f.apply(this, args));
        };
        // EventEmitter finds a listener added with once() by this, to remove it by the function the page passed.
        if ("listener" in f) g.listener = (f as any).listener;
        held.set(f, g);
      }
      return g;
    };
    const subscribe = (on: Function) => function (this: unknown, event: unknown, f: unknown, ...rest: unknown[]) {
      return on.call(this, event, event === "accountsChanged" && typeof f === "function" ? heldFor(f) : f, ...rest);
    };
    const unsubscribe = (off: Function) => function (this: unknown, event: unknown, f: unknown, ...rest: unknown[]) {
      return off.call(this, event, event === "accountsChanged" && typeof f === "function" ? (held.get(f) ?? f) : f, ...rest);
    };
    for (const name of ["on", "addListener", "once", "prependListener", "prependOnceListener"]) override(p, name, subscribe);
    for (const name of ["removeListener", "off"]) override(p, name, unsubscribe);
  }

  window.addEventListener("eip6963:announceProvider", (ev: any) => wrapProvider(ev?.detail?.provider));
  const pollEthereum = () => W.ethereum && wrapProvider(W.ethereum);
  queueMicrotask(pollEthereum);
  // The parser runs queued microtasks before each of the page's scripts: a wallet that puts itself at
  // window.ethereum after Canary is hooked before the page's own code can add listeners to it.
  const early = new MutationObserver(pollEthereum);
  early.observe(document, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", () => early.disconnect());
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
    const sent = url + "\n" + (body ?? "");
    const taint = findAddress(sent, needles);
    const snippet = taint ? snippetAround(sent, needles) : undefined;
    // A recipient you chose to block on this site (not in its ENS manifest).
    if (third && config?.blockHosts?.includes(h)) {
      return { kind: "block", obs: { category: "blocked", channel, host: h, firstParty: false, address: taint?.address, encoding: taint?.encoding, snippet, note: "not in the site's manifest; you blocked it on this site" } };
    }
    if (taint && third) {
      return { kind: "block", obs: { category: "blocked", channel, host: h, firstParty: false, address: taint.address, encoding: taint.encoding, snippet } };
    }
    if (taint) {
      return { kind: "pass", obs: { category: "detected", channel, host: h, firstParty: true, address: taint.address, encoding: taint.encoding, snippet } };
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
    const snippet = taint ? snippetAround(data, needles) : undefined;
    if (taint && third && !calls) {
      observe({ category: "blocked", channel: "websocket", host: h, firstParty: false, address: taint.address, encoding: taint.encoding, snippet });
      return;
    }
    observe(calls
      ? { category: "detected", channel: "websocket", host: h, firstParty: !third, address: taint?.address, methods: calls.map((c) => c.method), sample: sampleCall(calls[0]), note: "WebSocket RPC that can't be substituted" }
      : taint
        ? { category: "detected", channel: "websocket", host: h, firstParty: true, address: taint.address, encoding: taint.encoding, snippet }
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
