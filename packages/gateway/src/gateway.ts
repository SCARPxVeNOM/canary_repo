/* Canary Gateway (agent-sdk.md §3): one local process per machine.

   http://127.0.0.1:18545/<chainId>   JSON-RPC endpoint: the agent's RPC URL
   http://127.0.0.1:18080             HTTP(S) proxy: the agent's HTTPS_PROXY
   http://127.0.0.1:18545/canary/...  control API for @canary/agent:
       POST /canary/fetch   (x-canary-url: <url>)  in-process fetch, full policy with bodies visible
       POST /canary/events  {kind:"llm", requests, pseudonymized}  SDK-side counts
       GET  /canary/events  live egress decisions (server-sent events)
       GET  /canary/report  signed egress report + coarse on-chain form (?rotate=1 starts a new window)
       GET  /canary/status  backend state, chains, manifest hash, ENS state
       POST /canary/publish sign and publish the coarse report to the agent's ENS name now */

import { createServer, type Server } from "node:http";
import type { Hex } from "viem";
import { DEFAULT_MANIFEST, isAddress, needlesFor, parseManifest, type Manifest } from "@canary/core";
import { startChromiumBackend, type ChromiumOptions } from "./backend/chromium.js";
import type { AnonBackend, NetworkConfig } from "./backend/types.js";
import { headersFrom, sendHttp, startProxy, writeResponse, type HttpContext } from "./http.js";
import { Ledger } from "./ledger.js";
import { buildReport, coarseReport, GATEWAY_VERSION, policyHashOf, signReport } from "./report.js";
import { EnsBinding, ReporterCannotWrite, type EnsConfig } from "./ens.js";
import { loadOrCreateCa, Mitm, type CaFiles, type MitmConfig } from "./mitm.js";
import { handleRpc, type ChainConfig, type RpcContext } from "./rpc.js";

export type GatewayConfig = {
  /** bind address; loopback only by default */
  host?: string;
  /** JSON-RPC + control port (default 18545; 8545 clashes with anvil/Hardhat). 0 = any free port */
  port?: number;
  /** HTTP(S) proxy port (default 18080); false = no proxy */
  proxyPort?: number | false;
  /** an AnonBackend instance, or the network + Chromium options to start one */
  backend?: AnonBackend;
  network?: NetworkConfig;
  chromium?: Omit<ChromiumOptions, "network">;
  /** chainId → endpoints. Keys are decimal chain ids. */
  chains: Record<string, ChainConfig>;
  /** the agent's addresses: drives isolation keys, taint checks and pseudonymization */
  wallets?: string[];
  /** the privacy manifest (policy), given locally. Without it and with `ens`, the policy is read from the
      agent's ENS name; until it loads, every undeclared host is blocked (fail closed). */
  manifest?: Manifest | unknown;
  /** the agent's ENSv2 name: manifest source (unless `manifest` is given) and where reports are published */
  ens?: EnsConfig;
  /** random delay (0..jitterMs) before each substituted read, to blur polling schedules. Costs latency; reported in status. */
  jitterMs?: number;
  /** opt-in local CA so the proxy can inspect HTTPS and route `anon` hosts through anon-rpc (true = defaults) */
  mitm?: MitmConfig | boolean;
  /** per anon request (default 30 s; tor-js cold boot is ~13 s) */
  timeoutMs?: number;
  codeCacheMs?: number;
  /** key that signs egress reports. Never the agent's wallet key. */
  reportKey?: Hex;
};

export type Gateway = {
  url: string;
  rpcUrl(chainId: number | string): string;
  proxyUrl?: string;
  backend: AnonBackend;
  ledger: Ledger;
  readonly manifest: Manifest;
  readonly policyHash: Hex;
  ens?: EnsBinding;
  /** the CA files, when mitm is on: give `cert` (Node) or `bundle` (Python, curl) to the agent's runtime */
  ca?: CaFiles;
  addWallets(addrs: string[]): void;
  /** replace the policy (the ENS binding calls this when the on-chain manifest changes) */
  setManifest(m: Manifest | unknown): void;
  /** sign and publish the coarse report to the agent's ENS name; rotates the window */
  publishReport(): Promise<{ tx: Hex; record: unknown }>;
  report(opts?: { rotate?: boolean }): Promise<{ signed: Awaited<ReturnType<typeof signReport>>; coarse: ReturnType<typeof coarseReport> }>;
  close(): Promise<void>;
};

const LOOPBACK_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export async function createGateway(cfg: GatewayConfig): Promise<Gateway> {
  let manifest = parseManifest(cfg.manifest ?? DEFAULT_MANIFEST);
  let policyHash = policyHashOf(manifest);
  const wallets = new Set<string>();
  const needles: ReturnType<typeof needlesFor>[] = [];
  const addWallets = (addrs: string[]) => {
    for (const a of addrs) {
      if (!isAddress(a)) throw new TypeError(`not an address: ${a}`);
      if (wallets.has(a.toLowerCase())) continue;
      wallets.add(a.toLowerCase());
      needles.push(needlesFor(a));
    }
  };
  addWallets(cfg.wallets ?? []);
  for (const [id, c] of Object.entries(cfg.chains)) {
    if (!/^\d+$/.test(id)) throw new TypeError(`chains: key "${id}" is not a decimal chain id`);
    if (!c.read) throw new TypeError(`chains.${id}.read is required`);
  }

  if (cfg.ens && !cfg.chains[String(cfg.ens.chainId)]) throw new TypeError(`ens.chainId ${cfg.ens.chainId} is not in chains`);

  let backend = cfg.backend;
  if (!backend) {
    if (!cfg.network) throw new TypeError("config: give either `backend` or `network` (+ `chromium` options)");
    backend = await startChromiumBackend({ ...cfg.chromium, network: cfg.network });
  }
  const ledger = new Ledger();
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  const rpcCtx: RpcContext = { backend, ledger, manifest, chains: cfg.chains, needles, timeoutMs, codeCacheMs: cfg.codeCacheMs ?? 60_000, codeCache: new Map(), jitterMs: cfg.jitterMs ?? 0 };
  const httpCtx: HttpContext = { backend, ledger, manifest, needles, timeoutMs };
  const agentName = () => manifest.agent ?? cfg.ens?.name ?? "unnamed-agent";

  const setManifest = (m: Manifest | unknown) => {
    const next = parseManifest(m);
    const hash = policyHashOf(next);
    if (hash === policyHash) return;
    manifest = next;
    policyHash = hash;
    rpcCtx.manifest = next;
    httpCtx.manifest = next;
    ens?.checkDeclared(next);
    ledger.emit("policy", { policyHash: hash, agent: next.agent, at: Date.now() });
  };

  const report = async (opts: { rotate?: boolean } = {}) => {
    const signed = await signReport(buildReport(ledger, agentName(), policyHash), cfg.reportKey);
    if (opts.rotate) ledger.rotate();
    return { signed, coarse: coarseReport(signed, cfg.ens?.evidenceUri) };
  };

  // Declared before the server starts listening: handlers may run while the rest is still being set up.
  let mitm: Mitm | undefined;
  let ca: CaFiles | undefined;
  let ens: EnsBinding | undefined;

  const json = (res: import("node:http").ServerResponse, code: number, v: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(v, null, 2));

  const server: Server = createServer(async (req, res) => {
    // Refuse DNS-rebinding: a web page on this machine must not be able to drive the gateway.
    if (!LOOPBACK_HOSTS.test(req.headers.host ?? "") || req.headers.origin) return json(res, 403, { error: "loopback clients only" });
    const u = new URL(req.url ?? "/", "http://gateway");
    try {
      if (u.pathname === "/canary/status" && req.method === "GET") {
        return json(res, 200, {
          version: GATEWAY_VERSION,
          agent: agentName(),
          policyHash,
          backend: backend!.status(),
          chains: Object.keys(cfg.chains),
          wallets: wallets.size,
          undeclared: manifest.undeclared,
          llmAllow: manifest.llm?.allow ?? [],
          jitterMs: rpcCtx.jitterMs,
          mitm: ca ? { enabled: true, caCert: ca.cert, bundle: ca.bundle, passthrough: [...(mitm?.passthrough ?? [])] } : { enabled: false },
          ...(ens ? { ens: ens.status } : {}),
        });
      }
      if (u.pathname === "/canary/publish" && req.method === "POST") {
        try {
          return json(res, 200, await publishReport());
        } catch (e) {
          return json(res, e instanceof ReporterCannotWrite ? 409 : 502, { error: (e as Error).message, ...(ens ? { ens: ens.status } : {}) });
        }
      }
      if (u.pathname === "/canary/report" && req.method === "GET") return json(res, 200, await report({ rotate: u.searchParams.get("rotate") === "1" }));
      if (u.pathname === "/canary/events" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        const on = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        ledger.on("egress", on);
        req.on("close", () => ledger.off("egress", on));
        return;
      }
      if (u.pathname === "/canary/events" && req.method === "POST") {
        let raw = "";
        for await (const c of req) raw += c;
        const e = JSON.parse(raw || "{}");
        if (e.kind === "llm") {
          if (e.requests) ledger.record({ category: "direct", channel: "llm", host: String(e.host ?? "llm"), count: Number(e.requests) });
          if (e.pseudonymized) ledger.record({ category: "pseudonymized", channel: "llm", host: String(e.host ?? "llm"), count: Number(e.pseudonymized) });
        }
        if (Array.isArray(e.wallets)) addWallets(e.wallets);
        return json(res, 200, { ok: true });
      }
      if (u.pathname === "/canary/fetch") {
        const target = req.headers["x-canary-url"];
        if (typeof target !== "string") return json(res, 400, { error: "missing x-canary-url" });
        const headers = headersFrom(req);
        for (const k of [...headers.keys()]) if (k.startsWith("x-canary-")) headers.delete(k);
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const r = await sendHttp(httpCtx, { url: target, method: req.method ?? "GET", headers, ...(chunks.length ? { body: new Uint8Array(Buffer.concat(chunks)) } : {}) }, "sdk");
        return writeResponse(res, r);
      }
      const m = u.pathname.match(/^\/(\d+)?\/?$/);
      if (m && req.method === "POST") {
        const ids = Object.keys(cfg.chains);
        const chainId = m[1] ?? (ids.length === 1 ? ids[0]! : undefined);
        if (!chainId) return json(res, 404, { error: `several chains configured: POST to /<chainId> (${ids.join(", ")})` });
        let raw = "";
        for await (const c of req) raw += c;
        const r = await handleRpc(rpcCtx, chainId, raw);
        return res.writeHead(r.status, { "content-type": "application/json" }).end(r.body);
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: (e as Error).message });
      else res.destroy();
    }
  });

  const hostname = cfg.host ?? "127.0.0.1";
  await new Promise<void>((ok, fail) => (server.once("error", fail), server.listen(cfg.port ?? 18545, hostname, () => ok())));
  const port = (server.address() as any).port as number;
  const url = `http://${hostname}:${port}`;
  if (cfg.mitm && cfg.proxyPort !== false) {
    const o = cfg.mitm === true ? {} : cfg.mitm;
    const loaded = await loadOrCreateCa(o.dir);
    ca = loaded.files;
    mitm = new Mitm(loaded.certPem, loaded.keyPem, o.passthrough);
  }
  const proxy = cfg.proxyPort === false ? undefined : await startProxy(httpCtx, cfg.proxyPort ?? 18080, hostname, mitm);
  const proxyUrl = proxy ? `http://${hostname}:${(proxy.address() as any).port}` : undefined;

  // ENS: reads and the publish transaction go through our own endpoint, i.e. over anon-rpc.
  if (cfg.ens) {
    ens = new EnsBinding(cfg.ens, `${url}/${cfg.ens.chainId}`, cfg.reportKey, cfg.manifest !== undefined);
    if (cfg.manifest !== undefined) ens.checkDeclared(manifest);
    else {
      const load = () => ens!.loadManifest().then(setManifest);
      void load().catch(() => {}); // fail closed until it loads: status shows the error
      ens.every(cfg.ens.refreshMs ?? 300_000, load);
    }
    if (cfg.reportKey) void backend.ready.then(() => ens!.checkRole()).catch(() => {});
    ens.every(cfg.ens.publishEveryMs ?? 86_400_000, () => publishReport());
  }

  async function publishReport() {
    if (!ens) throw new Error("no ens configured");
    const { signed, coarse } = await report();
    const r = await ens.publish(coarse);
    ledger.rotate();
    return { ...r, reportHash: signed.reportHash };
  }

  return {
    url,
    rpcUrl: (chainId) => `${url}/${chainId}`,
    ...(proxyUrl ? { proxyUrl } : {}),
    backend,
    ledger,
    get manifest() {
      return manifest;
    },
    get policyHash() {
      return policyHash;
    },
    ...(ens ? { ens } : {}),
    ...(ca ? { ca } : {}),
    addWallets,
    setManifest,
    publishReport,
    report,
    async close() {
      ens?.close();
      server.closeAllConnections?.();
      proxy?.closeAllConnections?.();
      await Promise.all([new Promise((r) => server.close(r)), proxy ? new Promise((r) => proxy.close(r)) : null]);
      if (!cfg.backend) await backend!.close();
    },
  };
}
