/* Reading an agent's privacy records (docs/agent-sdk.md §4).

   Reads go through the client you pass. Inside the gateway that client's
   transport is the gateway's own RPC endpoint, so Canary's ENS lookups travel
   over anon-rpc like every other read (docs/design-notes.md §3.1). */

import { type Address, type Hex, type PublicClient } from "viem";
import { normalize } from "viem/ens";
import { parseManifest, type Manifest } from "@ayush_saklani/canary-core";
import { TEXT_KEYS } from "./abi.js";
import { parseReportRecord, verifyReportRecord, type ReportRecord } from "./record.js";
import { canWriteText, roleHistory, type RoleChange } from "./write.js";

export type EnsOptions = {
  /** override for chains viem doesn't know, and for tests */
  universalResolverAddress?: Address;
};

export class ManifestNotFound extends Error {
  constructor(readonly ensName: string) {
    super(`${ensName} has no ${TEXT_KEYS.manifest} text record`);
    this.name = "ManifestNotFound";
  }
}

export async function readText(client: PublicClient, name: string, key: string, o: EnsOptions = {}): Promise<string | null> {
  return client.getEnsText({ name: normalize(name), key, ...(o.universalResolverAddress ? { universalResolverAddress: o.universalResolverAddress } : {}) });
}

export async function resolverOf(client: PublicClient, name: string, o: EnsOptions = {}): Promise<Address | null> {
  const r = await client.getEnsResolver({ name: normalize(name), ...(o.universalResolverAddress ? { universalResolverAddress: o.universalResolverAddress } : {}) });
  return r && /^0x0{40}$/i.test(r) ? null : r;
}

/** The agent's privacy.manifest, parsed and validated. */
export async function loadManifest(client: PublicClient, name: string, o: EnsOptions = {}): Promise<{ manifest: Manifest; raw: string }> {
  const raw = await readText(client, name, TEXT_KEYS.manifest, o);
  if (!raw) throw new ManifestNotFound(name);
  const manifest = parseManifest(raw);
  if (manifest.agent && normalize(manifest.agent) !== normalize(name)) throw new TypeError(`manifest.agent is ${manifest.agent}, but it is published on ${name}`);
  return { manifest, raw };
}

export type AgentPrivacy = {
  name: string;
  resolver: Address | null;
  manifest?: Manifest;
  manifestError?: string;
  report?: ReportRecord;
  reportError?: string;
  /** checks a reader can make without trusting the operator */
  checks: {
    /** the report record's signature recovers to its signer */
    reportSigned?: boolean;
    /** ...and that signer is the manifest's declared reporter */
    signerIsReporter?: boolean;
    /** the report's policyHash matches the manifest published now */
    policyMatches?: boolean;
    /** the declared reporter can still write privacy.report (simulated setText) */
    reporterCanWrite?: boolean;
    /** the reporter's text role was revoked at some point (EACRolesChanged) */
    reporterRevoked?: boolean;
  };
  roleChanges?: RoleChange[];
};

/** Everything a verifier needs about one agent name: manifest, report, and whether reporting still works. */
export async function readAgentPrivacy(
  client: PublicClient,
  name: string,
  o: EnsOptions & { policyHashOf?: (m: Manifest) => Hex; fromBlock?: bigint } = {},
): Promise<AgentPrivacy> {
  const out: AgentPrivacy = { name, resolver: await resolverOf(client, name, o), checks: {} };
  try {
    out.manifest = (await loadManifest(client, name, o)).manifest;
  } catch (e) {
    out.manifestError = (e as Error).message;
  }
  try {
    const raw = await readText(client, name, TEXT_KEYS.report, o);
    if (raw) out.report = parseReportRecord(raw);
  } catch (e) {
    out.reportError = (e as Error).message;
  }
  if (out.report) {
    try {
      const signer = await verifyReportRecord(out.report);
      out.checks.reportSigned = true;
      if (out.manifest?.reporter) out.checks.signerIsReporter = signer.toLowerCase() === out.manifest.reporter.toLowerCase();
    } catch {
      out.checks.reportSigned = false;
    }
    if (out.manifest && o.policyHashOf) out.checks.policyMatches = o.policyHashOf(out.manifest) === out.report.policyHash;
  }
  if (out.resolver && out.manifest?.reporter) {
    const reporter = out.manifest.reporter as Address;
    out.checks.reporterCanWrite = (await canWriteText(client, out.resolver, name, TEXT_KEYS.report, reporter)).ok;
    try {
      out.roleChanges = await roleHistory(client, out.resolver, reporter, o.fromBlock);
      out.checks.reporterRevoked = out.roleChanges.some((c) => c.textRole === "revoked");
    } catch {
      /* some RPCs limit getLogs ranges; the simulated write above is the authoritative check */
    }
  }
  return out;
}
