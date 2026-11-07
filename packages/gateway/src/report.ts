/* Egress reports (docs/agent-sdk.md §3.5).

   The full report is EIP-712-signed by a report key the gateway holds (never
   the agent's wallet key) and stays with the operator. What goes on chain is
   the coarse form: whole-day window, bucketed counts, and the full report's
   hash, because hourly counts and timing would reveal when and how much the
   agent works. */

import { keccak256, recoverTypedDataAddress, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJson } from "@ayush_saklani/canary-core";
import type { CoarseReport } from "@ayush_saklani/canary-ens";
import type { Ledger } from "./ledger.js";

export const GATEWAY_VERSION = "0.1.0";

export type Report = {
  agent: string;
  policyHash: Hex;
  gatewayVersion: string;
  window: [number, number];
  rpc: Ledger["counts"]["rpc"];
  http: Ledger["counts"]["http"];
  llm: Ledger["counts"]["llm"];
  latencyMs: { p50?: number; p95?: number };
  hosts: Record<string, Record<string, number>>;
};

export type SignedReport = { report: Report; reportHash: Hex; signer?: Hex; signature?: Hex };

const DOMAIN = { name: "Canary Egress Report", version: "1" } as const;
const TYPES = {
  EgressReport: [
    { name: "agent", type: "string" },
    { name: "policyHash", type: "bytes32" },
    { name: "reportHash", type: "bytes32" },
    { name: "windowStart", type: "uint64" },
    { name: "windowEnd", type: "uint64" },
  ],
} as const;

export { policyHashOf } from "@ayush_saklani/canary-ens";

export function buildReport(ledger: Ledger, agent: string, policyHash: Hex): Report {
  return {
    agent,
    policyHash,
    gatewayVersion: GATEWAY_VERSION,
    window: [ledger.windowStart, Math.floor(Date.now() / 1000)],
    rpc: { ...ledger.counts.rpc },
    http: { ...ledger.counts.http },
    llm: { ...ledger.counts.llm },
    latencyMs: { p50: ledger.percentile(50), p95: ledger.percentile(95) },
    hosts: Object.fromEntries([...ledger.hosts].map(([h, c]) => [h, c as Record<string, number>])),
  };
}

export async function signReport(report: Report, reportKey?: Hex): Promise<SignedReport> {
  const reportHash = keccak256(toBytes(canonicalJson(report)));
  if (!reportKey) return { report, reportHash };
  const account = privateKeyToAccount(reportKey);
  const signature = await account.signTypedData({
    domain: DOMAIN,
    types: TYPES,
    primaryType: "EgressReport",
    message: { agent: report.agent, policyHash: report.policyHash, reportHash, windowStart: BigInt(report.window[0]), windowEnd: BigInt(report.window[1]) },
  });
  return { report, reportHash, signer: account.address, signature };
}

/** The address that signed this report, or throws if the hash doesn't match its content. */
export async function verifyReport(s: SignedReport): Promise<Hex> {
  const reportHash = keccak256(toBytes(canonicalJson(s.report)));
  if (reportHash !== s.reportHash) throw new Error("reportHash does not match the report");
  if (!s.signature) throw new Error("report is unsigned");
  return recoverTypedDataAddress({
    domain: DOMAIN,
    types: TYPES,
    primaryType: "EgressReport",
    message: { agent: s.report.agent, policyHash: s.report.policyHash, reportHash, windowStart: BigInt(s.report.window[0]), windowEnd: BigInt(s.report.window[1]) },
    signature: s.signature,
  });
}

const bucket = (n: number) => (n === 0 ? "0" : n < 100 ? "1-99" : n < 1000 ? "100-999" : n < 10000 ? "1k-10k" : "10k+");
const pct5 = (num: number, den: number) => (den === 0 ? undefined : Math.floor((100 * num) / den / 5) * 5);
const DAY = 86400;

/** The form that goes in the agent's ENS `privacy.report` record (signed separately, see @ayush_saklani/canary-ens). */
export function coarseReport(s: SignedReport, evidenceUri?: string): CoarseReport {
  const r = s.report;
  const rpcAnon = r.rpc.protected + r.rpc.ipOnly;
  return {
    agent: r.agent,
    policyHash: r.policyHash,
    reportHash: s.reportHash,
    days: [Math.floor(r.window[0] / DAY) * DAY, Math.ceil(r.window[1] / DAY) * DAY] as [number, number],
    rpcViaAnonPct: pct5(rpcAnon, r.rpc.total),
    rpcVolume: bucket(r.rpc.total),
    failedClosed: bucket(r.rpc.failedClosed + r.http.failedClosed),
    blocked: bucket(r.rpc.blocked + r.http.blocked),
    undeclared: bucket(r.http.undeclared),
    notInspected: bucket(r.http.notInspected),
    llmAddressesPseudonymized: bucket(r.llm.addressesPseudonymized),
    ...(evidenceUri ? { evidenceUri } : {}),
  };
}
