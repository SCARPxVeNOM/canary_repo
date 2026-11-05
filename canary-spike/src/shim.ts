// Canary MAIN-world shim. Runs at document_start in every frame, before the
// dapp's own scripts, and wraps window.fetch.
//
// A POST whose body is JSON-RPC (an object, or a batch array, with `jsonrpc`
// and `method`) is NOT sent to the dapp's provider. It is handed to the
// extension, which answers it through the anon-rpc worker. Everything else
// passes through untouched and is counted as "not inspected" by the scanner,
// not here.
//
// Spike scope: fetch only. XHR, WebSocket and sendBeacon are not wrapped yet.

type Pending = { resolve: (r: Response) => void; reject: (e: unknown) => void };

(() => {
  const TAG = "__canary";
  const origFetch = window.fetch.bind(window);
  const pending = new Map<string, Pending>();
  let seq = 0;

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[TAG] !== "res") return;
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.error) {
      p.reject(new TypeError(`Canary: ${d.error}`));
      return;
    }
    p.resolve(
      new Response(d.body, {
        status: d.status,
        headers: { "content-type": "application/json", "x-canary": d.label },
      }),
    );
  });

  function isJsonRpc(text: string): boolean {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      return false;
    }
    const one = (x: any) => x && typeof x === "object" && x.jsonrpc === "2.0" && typeof x.method === "string";
    return Array.isArray(v) ? v.length > 0 && v.every(one) : one(v);
  }

  async function classify(input: RequestInfo | URL, init?: RequestInit): Promise<{ url: string; body: string } | null> {
    if (input instanceof Request) {
      if (input.method !== "POST") return null;
      const body = await input.clone().text();
      return isJsonRpc(body) ? { url: input.url, body } : null;
    }
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "POST" || typeof init?.body !== "string") return null;
    return isJsonRpc(init.body) ? { url: new URL(String(input), location.href).href, body: init.body } : null;
  }

  function viaCanary(req: { url: string; body: string }): Promise<Response> {
    const id = `${Date.now()}-${++seq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.postMessage({ [TAG]: "req", id, url: req.url, body: req.body }, "*");
    });
  }

  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let req: { url: string; body: string } | null = null;
    try {
      req = await classify(input, init);
    } catch {
      req = null;
    }
    if (req) return viaCanary(req);
    return origFetch(input as RequestInfo, init);
  } as typeof fetch;
})();
