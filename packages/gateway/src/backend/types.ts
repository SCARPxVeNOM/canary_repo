/* AnonBackend: how the gateway reaches anon-rpc (agent-sdk.md §3.1).
   `chromium` works today; a `node` backend slots in when EF's node harness
   can run tor-js. The interface stays the same. */

export type AnonInit = RequestInit & { anonOptions?: { isolationKey?: string } };

export type BackendState = "starting" | "warming" | "ready" | "failed" | "closed";

/** Whether anon calls are actually getting through, judged from their outcomes since the last
    (re)launch. The worker's own ready signal isn't enough: live, tor-js reported ready at 69 s
    but built no circuits through the KPS gateway until ~229 s (test-repo.md, round 4). */
export type PathHealth = {
  /** "unknown" until the first call settles; "no" after a failure with no success since */
  serving: "unknown" | "yes" | "no";
  ok: number;
  failed: number;
  consecutiveFailures: number;
  /** ms from launch to the first successful call */
  firstOkMs?: number;
  lastOkAt?: number;
  lastError?: string;
};

export type BackendStatus = {
  backend: string;
  network: string;
  state: BackendState;
  bootMs?: number;
  error?: string;
  restarts: number;
  path: PathHealth;
};

export type WorkerLog = { level: string; args: unknown[] };

export interface AnonBackend {
  readonly name: string;
  /** Resolves when the anon-rpc worker reports ready. fetch() may be called before; calls wait.
      Ready is not serving: see status().path. */
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
