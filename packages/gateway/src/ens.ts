/* The gateway's ENSv2 binding (docs/agent-sdk.md §4):
   - load the policy from the agent's `privacy.manifest` text record, and
     re-read it every `refreshMs`, so a policy change on chain applies live;
   - publish the signed coarse report to `privacy.report` with the report key,
     which should hold the one-key role for that record only;
   - notice when that role is revoked (the publish is simulated first).

   Every read and the publishing transaction go through the gateway's own
   JSON-RPC endpoint, so they travel over anon-rpc like the agent's reads. */

import { createPublicClient, createWalletClient, defineChain, http, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, sepolia } from "viem/chains";
import type { Manifest } from "@canary/core";
import { canWriteText, loadManifest, resolverOf, setTextRecord, signCoarseReport, TEXT_KEYS, type CoarseReport } from "@canary/ens";

export type EnsConfig = {
  /** the agent's ENSv2 name, e.g. trader-01.agents.canary.eth */
  name: string;
  /** chain the name lives on (must be in the gateway's `chains`) */
  chainId: number;
  /** re-read the manifest this often (default 5 min; 0 = only at start) */
  refreshMs?: number;
  /** publish the coarse report this often (default daily; 0 = only on POST /canary/publish) */
  publishEveryMs?: number;
  /** where the operator publishes full signed reports, if anywhere */
  evidenceUri?: string;
  /** for chains viem doesn't know, and tests */
  universalResolverAddress?: Address;
};

export type EnsStatus = {
  name: string;
  chainId: number;
  manifest: { source: "ens" | "local"; state: "loading" | "loaded" | "error"; loadedAt?: number; error?: string };
  reporter?: Address;
  /** granted: the report key can write privacy.report; revoked: it could before and can't now; not-granted: never could */
  reportRole: "unknown" | "granted" | "revoked" | "not-granted";
  reporterDeclared?: boolean;
  lastPublish?: { at: number; tx: Hex; reportHash: Hex };
  lastPublishError?: string;
};

export class ReporterCannotWrite extends Error {
  constructor(reason: string) {
    super(`the report key can't write ${TEXT_KEYS.report}: ${reason}`);
    this.name = "ReporterCannotWrite";
  }
}

const chainFor = (id: number): Chain =>
  id === 1 ? mainnet : id === 11155111 ? sepolia : defineChain({ id, name: `chain ${id}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });

export class EnsBinding {
  status: EnsStatus;
  private client: PublicClient;
  private timers: NodeJS.Timeout[] = [];
  private everGranted = false;
  private o: { universalResolverAddress?: Address };

  constructor(
    private cfg: EnsConfig,
    rpcUrl: string,
    private reportKey: Hex | undefined,
    localManifest: boolean,
  ) {
    const chain = chainFor(cfg.chainId);
    this.client = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
    this.o = cfg.universalResolverAddress ? { universalResolverAddress: cfg.universalResolverAddress } : {};
    this.status = {
      name: cfg.name,
      chainId: cfg.chainId,
      manifest: { source: localManifest ? "local" : "ens", state: localManifest ? "loaded" : "loading" },
      reportRole: "unknown",
      ...(reportKey ? { reporter: privateKeyToAccount(reportKey).address } : {}),
    };
    this.wallet = reportKey ? createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(reportKey) }) : undefined;
  }
  private wallet?: ReturnType<typeof createWalletClient>;

  /** Load the manifest from ENS. Throws on failure; the caller keeps the last good policy. */
  async loadManifest(): Promise<Manifest> {
    try {
      const { manifest } = await loadManifest(this.client, this.cfg.name, this.o);
      this.status.manifest = { ...this.status.manifest, state: "loaded", loadedAt: Date.now(), error: undefined };
      this.checkDeclared(manifest);
      return manifest;
    } catch (e) {
      this.status.manifest = { ...this.status.manifest, state: this.status.manifest.loadedAt ? "loaded" : "error", error: (e as Error).message };
      throw e;
    }
  }

  checkDeclared(m: Manifest) {
    if (this.status.reporter) this.status.reporterDeclared = m.reporter?.toLowerCase() === this.status.reporter.toLowerCase();
  }

  /** Can the report key write privacy.report right now? Updates reportRole. */
  async checkRole(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.status.reporter) return { ok: false, reason: "no report key configured" };
    const resolver = await resolverOf(this.client, this.cfg.name, this.o);
    if (!resolver) {
      this.status.reportRole = "not-granted";
      return { ok: false, reason: `${this.cfg.name} has no resolver` };
    }
    const r = await canWriteText(this.client, resolver, this.cfg.name, TEXT_KEYS.report, this.status.reporter);
    if (r.ok) this.everGranted = true;
    this.status.reportRole = r.ok ? "granted" : this.everGranted ? "revoked" : "not-granted";
    return r;
  }

  /** Sign and publish the coarse report. Simulates first: a revoked role fails here, without a transaction. */
  async publish(coarse: CoarseReport): Promise<{ tx: Hex; record: unknown }> {
    if (!this.reportKey || !this.wallet) throw new Error("publishing needs a reportKey (CANARY_REPORT_KEY)");
    try {
      const role = await this.checkRole();
      if (!role.ok) throw new ReporterCannotWrite(role.reason ?? this.status.reportRole);
      const record = await signCoarseReport({ ...coarse, ...(this.cfg.evidenceUri ? { evidenceUri: this.cfg.evidenceUri } : {}) }, this.reportKey);
      const resolver = (await resolverOf(this.client, this.cfg.name, this.o))!;
      const tx = await setTextRecord({ wallet: this.wallet as any, client: this.client }, resolver, this.cfg.name, TEXT_KEYS.report, JSON.stringify(record));
      this.status.lastPublish = { at: Date.now(), tx, reportHash: coarse.reportHash };
      this.status.lastPublishError = undefined;
      return { tx, record };
    } catch (e) {
      this.status.lastPublishError = (e as Error).message;
      throw e;
    }
  }

  every(ms: number, f: () => Promise<unknown>) {
    if (!ms) return;
    const t = setInterval(() => void f().catch(() => {}), ms);
    t.unref();
    this.timers.push(t);
  }

  close() {
    for (const t of this.timers) clearInterval(t);
  }
}
