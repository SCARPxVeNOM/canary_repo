/* The `privacy.report` record: the coarse egress report (agent-sdk.md §3.5)
   plus the report key's EIP-712 signature over it. Readers recover the signer
   and compare it with the manifest's declared `reporter`. */

import { keccak256, recoverTypedDataAddress, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJson } from "@canary/core";

export type CoarseReport = {
  agent: string;
  policyHash: Hex;
  reportHash: Hex;
  days: [number, number];
  rpcViaAnonPct?: number;
  rpcVolume: string;
  failedClosed: string;
  blocked: string;
  undeclared: string;
  notInspected: string;
  llmAddressesPseudonymized: string;
  /** where the operator publishes the full signed report, if anywhere */
  evidenceUri?: string;
};

export type ReportRecord = CoarseReport & { signer: Hex; signature: Hex };

const DOMAIN = { name: "Canary Egress Report", version: "1" } as const;
const TYPES = {
  CoarseReport: [
    { name: "agent", type: "string" },
    { name: "policyHash", type: "bytes32" },
    { name: "reportHash", type: "bytes32" },
    { name: "coarseHash", type: "bytes32" },
  ],
} as const;

const coarseHash = (c: CoarseReport) => keccak256(toBytes(canonicalJson(c)));

/** keccak256 of the manifest's canonical JSON: the policyHash in reports. */
export const policyHashOf = (manifest: unknown): Hex => keccak256(toBytes(canonicalJson(manifest)));

export async function signCoarseReport(coarse: CoarseReport, reportKey: Hex): Promise<ReportRecord> {
  const account = privateKeyToAccount(reportKey);
  const signature = await account.signTypedData({
    domain: DOMAIN,
    types: TYPES,
    primaryType: "CoarseReport",
    message: { agent: coarse.agent, policyHash: coarse.policyHash, reportHash: coarse.reportHash, coarseHash: coarseHash(coarse) },
  });
  return { ...coarse, signer: account.address, signature };
}

/** The address that signed this record (throws if it was altered after signing). */
export async function verifyReportRecord(r: ReportRecord): Promise<Hex> {
  const { signer, signature, ...coarse } = r;
  const recovered = await recoverTypedDataAddress({
    domain: DOMAIN,
    types: TYPES,
    primaryType: "CoarseReport",
    message: { agent: coarse.agent, policyHash: coarse.policyHash, reportHash: coarse.reportHash, coarseHash: coarseHash(coarse as CoarseReport) },
    signature,
  });
  if (recovered.toLowerCase() !== signer.toLowerCase()) throw new Error(`record signed by ${recovered}, but claims ${signer}`);
  return recovered;
}

export function parseReportRecord(text: string): ReportRecord {
  const r = JSON.parse(text);
  for (const k of ["agent", "policyHash", "reportHash", "signer", "signature"]) if (typeof r[k] !== "string") throw new TypeError(`privacy.report: missing ${k}`);
  return r as ReportRecord;
}
