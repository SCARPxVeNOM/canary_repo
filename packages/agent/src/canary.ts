/* @canary/agent: the in-process SDK (docs/agent-sdk.md §3.4).

   const canary = await createCanary({ gateway: "http://127.0.0.1:18545", wallets: [account.address] });
   const client = createPublicClient({ chain: sepolia, transport: canary.viemTransport() });
   const provider = await canary.ethersProvider(11155111);  // ethers v6, if you use it
   globalThis.fetch = canary.fetch;                      // or pass canary.fetch to SDKs that take one
   const openai = new OpenAI({ fetch: canary.llmFetch }); // or canary.wrapLLM(existingClient)
   const tools = canary.wrapTools(myTools);              // restores aliases in tool-call arguments

   Policy lives in the gateway (one place, from the manifest). The SDK hands
   it requests in the clear, which a proxy can't see: HTTPS bodies, and
   prompts, which it pseudonymizes before they leave. */

import { http } from "viem";
import { isAddress } from "@canary/core";
import { Pseudonymizer, UnknownAliasError } from "./pseudonymize.js";

export type CanaryOptions = {
  /** URL of a running gateway (default http://127.0.0.1:18545) */
  gateway?: string;
  /** or run the gateway in this process: a @canary/gateway GatewayConfig */
  embedded?: Record<string, unknown>;
  /** the agent's addresses */
  wallets?: string[];
  /** the agent's ENS name(s), pseudonymized in prompts; defaults to the manifest's agent */
  agentNames?: string[];
  /** extra addresses the pseudonymizer passes through (added to the manifest's llm.allow) */
  allow?: string[];
  /** chain for viemTransport() when the client has none */
  chainId?: number;
};

export type EgressEvent = { category: string; channel: string; host: string; at: number; methods?: string[]; ms?: number; note?: string; address?: string };

type Fetch = typeof globalThis.fetch;

export type Canary = Awaited<ReturnType<typeof createCanary>>;

export async function createCanary(opts: CanaryOptions = {}) {
  const realFetch: Fetch = globalThis.fetch.bind(globalThis);
  let embedded: { url: string; close(): Promise<void> } | undefined;
  if (opts.embedded) {
    let mod: any;
    try {
      mod = await import("@canary/gateway");
    } catch {
      throw new Error('embedded mode needs "@canary/gateway" installed');
    }
    embedded = await mod.createGateway({ proxyPort: false, ...opts.embedded, wallets: [...((opts.embedded.wallets as string[]) ?? []), ...(opts.wallets ?? [])] });
  }
  const gateway = (embedded?.url ?? opts.gateway ?? "http://127.0.0.1:18545").replace(/\/$/, "");

  const statusRes = await realFetch(`${gateway}/canary/status`).catch((e) => {
    throw new Error(`no Canary gateway at ${gateway}: ${(e as Error).message}`);
  });
  const status = (await statusRes.json()) as { agent: string; policyHash: string; chains: string[]; llmAllow: string[] };

  for (const w of opts.wallets ?? []) if (!isAddress(w)) throw new TypeError(`not an address: ${w}`);
  if (opts.wallets?.length) await post({ kind: "wallets", wallets: opts.wallets });

  const p = new Pseudonymizer({
    wallets: opts.wallets ?? [],
    agentNames: opts.agentNames ?? (status.agent && status.agent !== "unnamed-agent" ? [status.agent] : []),
    allow: [...(status.llmAllow ?? []), ...(opts.allow ?? [])],
  });

  async function post(body: unknown) {
    try {
      await realFetch(`${gateway}/canary/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      /* counts are best effort; enforcement is in the gateway */
    }
  }

  const urlOf = (input: RequestInfo | URL) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

  /** fetch, with the gateway's policy applied. Requests to the gateway itself pass straight through. */
  const canaryFetch: Fetch = async (input, init) => {
    const url = urlOf(input);
    if (url.startsWith(gateway + "/") || url === gateway) return realFetch(input, init);
    if (!/^https?:/i.test(url)) return realFetch(input, init);
    const req = new Request(input, init);
    const headers = new Headers(req.headers);
    headers.set("x-canary-url", url);
    headers.delete("origin");
    const body = req.body ? await req.arrayBuffer() : undefined;
    return realFetch(`${gateway}/canary/fetch`, { method: req.method, headers, ...(body && body.byteLength ? { body } : {}), signal: req.signal, redirect: "manual" });
  };

  /** fetch for LLM clients: pseudonymizes the request, restores non-streamed responses. */
  const llmFetch: Fetch = async (input, init) => {
    const url = urlOf(input);
    const req = new Request(input, init);
    let body: string | undefined = req.body ? await req.text() : undefined;
    let count = 0;
    if (body) ({ text: body, count } = p.redact(body));
    const headers = new Headers(req.headers);
    headers.delete("content-length");
    const res = await canaryFetch(url, { method: req.method, headers, ...(body !== undefined ? { body } : {}), signal: req.signal });
    void post({ kind: "llm", host: new URL(url).host, requests: 1, pseudonymized: count });
    const type = res.headers.get("content-type") ?? "";
    // Streams can't be restored in place (an alias can be split across events): see wrapTools/restore.
    if (!res.body || type.includes("text/event-stream") || !/json|text/.test(type)) return res;
    const restored = p.restore(await res.text()).text;
    const h = new Headers(res.headers);
    h.delete("content-length");
    return new Response(restored, { status: res.status, statusText: res.statusText, headers: h });
  };

  return {
    gateway,
    policyHash: status.policyHash,
    pseudonymizer: p,
    fetch: canaryFetch,
    llmFetch,

    rpcUrl: (chainId: number | string) => `${gateway}/${chainId}`,

    /** A viem transport: every JSON-RPC call goes to the gateway, per chain. */
    viemTransport(config: { batch?: boolean | { batchSize?: number; wait?: number }; retryCount?: number } = {}) {
      return function canaryTransport(params: any) {
        const chainId = params.chain?.id ?? opts.chainId;
        if (chainId === undefined) throw new Error("canary.viemTransport(): the client has no chain; pass createCanary({ chainId })");
        // Don't batch across wallets: the gateway splits batches per wallet anyway.
        return http(`${gateway}/${chainId}`, { fetchFn: realFetch, ...config })(params);
      } as ReturnType<typeof http>;
    },

    /** An ethers v6 provider whose every call goes to the gateway (ethers is an optional peer dependency). */
    async ethersProvider(chainId?: number): Promise<import("ethers").JsonRpcProvider> {
      const id = chainId ?? opts.chainId;
      if (id === undefined) throw new Error("canary.ethersProvider(): pass a chainId (or createCanary({ chainId }))");
      let ethers: typeof import("ethers");
      try {
        ethers = await import("ethers");
      } catch {
        throw new Error('canary.ethersProvider() needs "ethers" v6 installed');
      }
      return new ethers.JsonRpcProvider(`${gateway}/${id}`, ethers.Network.from(id), { staticNetwork: true });
    },

    /** Point an existing OpenAI/Anthropic-style client's fetch at llmFetch. */
    wrapLLM<T extends object>(client: T): T {
      if (!("fetch" in client)) throw new TypeError("wrapLLM: this client has no fetch to replace; construct it with { fetch: canary.llmFetch } instead");
      (client as any).fetch = llmFetch;
      return client;
    },

    /** Restore aliases in tool-call arguments before each tool runs. Unknown aliases fail the call. */
    wrapTools<T extends Record<string, any>>(tools: T): T {
      const out: Record<string, any> = {};
      for (const [name, tool] of Object.entries(tools)) {
        if (typeof tool === "function") out[name] = (...args: unknown[]) => tool(...p.restoreDeep(args, { strict: true }));
        else if (tool && typeof tool.execute === "function") out[name] = { ...tool, execute: (args: unknown, ...rest: unknown[]) => tool.execute(p.restoreDeep(args, { strict: true }), ...rest) };
        else out[name] = tool;
      }
      return out as T;
    },

    restore: (text: string) => p.restore(text).text,
    restoreTextStream: () => p.restoreTextStream(),

    /** Live egress decisions from the gateway. Returns a function that stops listening. */
    on(event: "egress", listener: (e: EgressEvent) => void): () => void {
      if (event !== "egress") throw new TypeError(`unknown event ${event}`);
      const ac = new AbortController();
      void (async () => {
        try {
          const r = await realFetch(`${gateway}/canary/events`, { signal: ac.signal });
          const dec = new TextDecoder();
          let buf = "";
          for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const line = buf.slice(0, i);
              buf = buf.slice(i + 2);
              if (line.startsWith("data: ")) listener(JSON.parse(line.slice(6)));
            }
          }
        } catch {
          /* stopped */
        }
      })();
      return () => ac.abort();
    },

    /** Coverage + signed egress report from the gateway. */
    async report(o: { rotate?: boolean } = {}) {
      return (await realFetch(`${gateway}/canary/report${o.rotate ? "?rotate=1" : ""}`)).json();
    },

    async close() {
      await embedded?.close();
    },
  };
}

export { UnknownAliasError };
