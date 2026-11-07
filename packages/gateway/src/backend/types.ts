/* AnonBackend: how the gateway reaches anon-rpc (docs/agent-sdk.md §3.1).
   `chromium` works today; a `node` backend slots in when EF's node harness
   can run tor-js. The interface stays the same. */

export type AnonInit = RequestInit & { anonOptions?: { isolationKey?: string } };

export type BackendState = "starting" | "warming" | "ready" | "failed" | "closed";

export type BackendStatus = {
  backend: string;
  network: string;
  state: BackendState;
  bootMs?: number;
  error?: string;
  restarts: number;
};

export type WorkerLog = { level: string; args: unknown[] };

export interface AnonBackend {
  readonly name: string;
  /** Resolves when the anon-rpc worker reports ready. fetch() may be called before; calls wait. */
  readonly ready: Promise<void>;
  /** An anonymized fetch. Rejects (never falls back to a direct request) if the anon path fails. */
  fetch(url: string, init?: AnonInit): Promise<Response>;
  status(): BackendStatus;
  onLog?(listener: (log: WorkerLog) => void): void;
  close(): Promise<void>;
}

/** Which anon-rpc network to boot: same shape as the extension's config/live.json `network`. */
export type NetworkConfig = {
  id: string;
  label?: string;
  /** IWorkerSpecifier contract address */
  specifier: string;
  /** RPC used only to read the specifier (and only from the gateway's Node process) */
  bootstrapRpc: string;
  /** opaque, network-defined, e.g. tor-js gateways */
  workerConfig?: unknown;
};
