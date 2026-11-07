/* The data the dashboard displays, mirrored from the packages so the screens
   take exactly what the real code returns. When the dashboard is wired up,
   these can become imports from @ayush_saklani/canary-core, @ayush_saklani/canary-gateway and @ayush_saklani/canary-ens.

   Source of each shape:
     Category, Channel, Observation, Manifest   packages/core/src/coverage.ts, policy.ts
     BackendStatus                              packages/gateway/src/backend/types.ts
     EnsStatus                                  packages/gateway/src/ens.ts
     GatewayStatus                              GET /canary/status (packages/gateway/src/gateway.ts)
     Counts, Egress                             packages/gateway/src/ledger.ts (GET /canary/events)
     Report, SignedReport                       packages/gateway/src/report.ts (GET /canary/report)
     CoarseReport, ReportRecord, RoleChange,
     AgentPrivacy                               packages/ens/src/record.ts, write.ts, read.ts */

export type Hex = `0x${string}`;

/* --- @ayush_saklani/canary-core ---------------------------------------------------------- */

export type Category =
  | "protected"
  | "protectedIpOnly"
  | "blocked"
  | "detected"
  | "backend"
  | "notInspected"
  | "failedClosed"
  | "direct"
  | "pseudonymized"
  | "undeclared"
  | "localNode";

export type Channel = "fetch" | "xhr" | "websocket" | "beacon" | "url" | "rpc" | "proxy" | "connect" | "sdk" | "llm";

export type Observation = {
  category: Category;
  channel: Channel;
  host: string;
  firstParty?: boolean;
  address?: string;
  encoding?: string;
  methods?: string[];
  ms?: number;
  note?: string;
};

export type HostRule = "anon" | "direct" | "block";

export type Manifest = {
  v: 1;
  agent?: string;
  hosts: Record<string, HostRule>;
  undeclared: "block" | "report";
  rpc: { write: "anon" | "private" | "direct" };
  reporter?: string;
  wallets?: "disclosed" | "undisclosed";
  llm?: { allow?: string[] };
};

/* --- @ayush_saklani/canary-gateway ------------------------------------------------------- */

export type BackendState = "starting" | "warming" | "ready" | "failed" | "closed";

export type BackendStatus = {
  backend: string;
  network: string;
  state: BackendState;
  bootMs?: number;
  error?: string;
  restarts: number;
};

export type EnsStatus = {
  name: string;
  chainId: number;
  manifest: { source: "ens" | "local"; state: "loading" | "loaded" | "error"; loadedAt?: number; error?: string };
  reporter?: Hex;
  reportRole: "unknown" | "granted" | "revoked" | "not-granted";
  reporterDeclared?: boolean;
  lastPublish?: { at: number; tx: Hex; reportHash: Hex };
  lastPublishError?: string;
};

export type GatewayStatus = {
  version: string;
  agent?: string;
  policyHash: Hex;
  backend: BackendStatus;
  chains: string[];
  wallets: number;
  undeclared: "block" | "report";
  llmAllow: string[];
  jitterMs: number;
  mitm: { enabled: boolean };
  ens?: EnsStatus;
};

export type Counts = {
  rpc: { total: number; protected: number; ipOnly: number; direct: number; blocked: number; failedClosed: number; linked: number };
  http: { anon: number; direct: number; blocked: number; undeclared: number; notInspected: number; failedClosed: number };
  llm: { requests: number; addressesPseudonymized: number };
};

/** One egress decision, as streamed by GET /canary/events. `at` is ms since epoch. */
export type Egress = Observation & { at: number; count?: number };

export type Report = {
  agent: string;
  policyHash: Hex;
  gatewayVersion: string;
  /** unix seconds */
  window: [number, number];
  rpc: Counts["rpc"];
  http: Counts["http"];
  llm: Counts["llm"];
  latencyMs: { p50?: number; p95?: number };
  hosts: Record<string, Partial<Record<Category, number>>>;
};

export type SignedReport = { report: Report; reportHash: Hex; signer?: Hex; signature?: Hex };

/* --- @ayush_saklani/canary-ens ----------------------------------------------------------- */

export type CoarseReport = {
  agent: string;
  policyHash: Hex;
  reportHash: Hex;
  /** unix days */
  days: [number, number];
  rpcViaAnonPct?: number;
  rpcVolume: string;
  failedClosed: string;
  blocked: string;
  undeclared: string;
  notInspected: string;
  llmAddressesPseudonymized: string;
  evidenceUri?: string;
};

export type ReportRecord = CoarseReport & { signer: Hex; signature: Hex };

export type RoleChange = {
  resource: bigint;
  oldRoleBitmap: bigint;
  newRoleBitmap: bigint;
  textRole: "granted" | "revoked" | "unchanged";
  blockNumber: bigint;
  transactionHash: Hex;
};

export type AgentPrivacy = {
  name: string;
  resolver: Hex | null;
  manifest?: Manifest;
  manifestError?: string;
  report?: ReportRecord;
  reportError?: string;
  checks: {
    reportSigned?: boolean;
    signerIsReporter?: boolean;
    policyMatches?: boolean;
    reporterCanWrite?: boolean;
    reporterRevoked?: boolean;
  };
  roleChanges?: RoleChange[];
};

/* --- dashboard-only UI states ---------------------------------------------- */

/** What the header pill shows about the local gateway. */
export type Connection = "disconnected" | "warming" | "serving" | "failed";

/** The ENS lookup screen's state. */
export type LookupState =
  | { kind: "idle" }
  | { kind: "reading"; name: string; step: "tor" | "ens" }
  | { kind: "found"; result: AgentPrivacy }
  | { kind: "notFound"; name: string }
  | { kind: "error"; name: string; message: string };
