/* A verifier's signed verdict on a dapp (docs/design-notes.md §3.3): the
   `privacy.verdict.<verifier>` text record on the dapp's ENSv2 name.

   The dapp delegates exactly that one key to the verifier (grantTextKey), so
   the verifier can publish bad news without the dapp's help, and can't touch
   anything else. The owner keeps admin roles and could re-grant itself the
   key, so the record is also signed: readers recover the signer and compare it
   with the verifier name's `addr`. Silencing the verifier means revoking the
   role, which readers see (canWriteText turns false, EACRolesChanged).

   Built from a scanner baseline report (scanner/scan.mjs JSON). */

import { keccak256, recoverTypedDataAddress, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJson } from "@ayush_saklani/canary-core";

export const verdictKey = (verifier = "canary") => `privacy.verdict.${verifier}`;

export type Verdict = {
  /** the dapp's ENS name */
  name: string;
  /** the site that was scanned */
  origin: string;
  /** the verifier's ENS name; its addr record is the signing key */
  verifier: string;
  /** scanner's fingerprint of the first-party HTML/JS it was served */
  buildHash: string;
  scannerHash: string;
  /** flow steps scanned (load → connect → scroll …) */
  flows: string[];
  /** matches: no undeclared recipients observed · undeclared: some · incomplete: no manifest to check against */
  result: "matches" | "undeclared" | "incomplete";
  undeclaredHosts: string[];
  /** third parties the scan saw receive your address, and what each is (all a label can say about a site with no manifest) */
  addressRecipients?: { host: string; kind: string }[];
  notInspected: string[];
  /** unix seconds */
  issuedAt: number;
  expiresAt: number;
  evidenceURI?: string;
};

export type VerdictRecord = Verdict & { signer: Hex; signature: Hex };

const DOMAIN = { name: "Canary Verdict", version: "1" } as const;
const TYPES = {
  Verdict: [
    { name: "name", type: "string" },
    { name: "origin", type: "string" },
    { name: "verifier", type: "string" },
    { name: "result", type: "string" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    // the rest, committed to by hash
    { name: "verdictHash", type: "bytes32" },
  ],
} as const;

const message = (v: Verdict) => ({
  name: v.name,
  origin: v.origin,
  verifier: v.verifier,
  result: v.result,
  issuedAt: BigInt(v.issuedAt),
  expiresAt: BigInt(v.expiresAt),
  verdictHash: keccak256(toBytes(canonicalJson(v))),
});

const RESULTS = new Set(["matches", "undeclared", "incomplete"]);

/** The verdict a scanner baseline report supports. */
export function verdictFromScan(
  report: any,
  o: { name: string; verifier: string; ttlDays?: number; now?: number; evidenceURI?: string },
): Verdict {
  if (report?.withCanary) throw new TypeError("verdicts are made from a baseline scan (without Canary): it shows what the dapp itself sends");
  if (!report?.build?.fingerprint || !Array.isArray(report.recipients)) throw new TypeError("not a scanner report");
  const unchecked = report.recipients.some((r: any) => r.party === "third" && r.carriedAddress && r.declared === null);
  const undeclaredHosts: string[] = [...(report.undeclared ?? [])].sort();
  const addressRecipients = report.recipients
    .filter((r: any) => r.party === "third" && r.carriedAddress)
    .map((r: any) => ({ host: String(r.host), kind: String(r.kind ?? "unknown") }))
    .sort((a: { host: string }, b: { host: string }) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  const scannedAt = Date.parse(report.scannedAt);
  const issuedAt = Math.floor((o.now ?? (Number.isFinite(scannedAt) ? scannedAt : Date.now())) / 1000);
  return {
    name: o.name,
    origin: new URL(report.url).origin,
    verifier: o.verifier,
    buildHash: report.build.fingerprint,
    scannerHash: report.scanner?.hash ?? "",
    flows: report.flows ?? [],
    result: unchecked ? "incomplete" : undeclaredHosts.length ? "undeclared" : "matches",
    undeclaredHosts,
    addressRecipients,
    notInspected: report.notInspected ?? [],
    issuedAt,
    expiresAt: issuedAt + Math.round((o.ttlDays ?? 30) * 86400),
    ...(o.evidenceURI ? { evidenceURI: o.evidenceURI } : {}),
  };
}

export async function signVerdict(v: Verdict, verifierKey: Hex): Promise<VerdictRecord> {
  const account = privateKeyToAccount(verifierKey);
  const signature = await account.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: "Verdict", message: message(v) });
  return { ...v, signer: account.address, signature };
}

/** The address that signed this record (throws if it was altered after signing). */
export async function verifyVerdictRecord(r: VerdictRecord): Promise<Hex> {
  const { signer, signature, ...v } = r;
  const recovered = await recoverTypedDataAddress({ domain: DOMAIN, types: TYPES, primaryType: "Verdict", message: message(v), signature });
  if (recovered.toLowerCase() !== signer.toLowerCase()) throw new Error(`verdict signed by ${recovered}, but claims ${signer}`);
  return recovered;
}

export function parseVerdictRecord(text: string): VerdictRecord {
  const r = JSON.parse(text);
  for (const k of ["name", "origin", "verifier", "buildHash", "result", "signer", "signature"]) if (typeof r[k] !== "string") throw new TypeError(`verdict: missing ${k}`);
  if (!RESULTS.has(r.result)) throw new TypeError("verdict.result: expected matches | undeclared | incomplete");
  for (const k of ["issuedAt", "expiresAt"]) if (!Number.isSafeInteger(r[k])) throw new TypeError(`verdict.${k}: expected unix seconds`);
  for (const k of ["flows", "undeclaredHosts", "notInspected"]) if (!Array.isArray(r[k])) throw new TypeError(`verdict.${k}: expected an array`);
  if (r.addressRecipients !== undefined && !(Array.isArray(r.addressRecipients) && r.addressRecipients.every((x: any) => typeof x?.host === "string" && typeof x?.kind === "string")))
    throw new TypeError("verdict.addressRecipients: expected [{host, kind}]");
  return r as VerdictRecord;
}
