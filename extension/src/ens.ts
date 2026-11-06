// A dapp's declared recipients and its verifier's verdict, read from ENS
// (idea.md §3.3).
//
//   https://<site>/.well-known/canary.json  → {"ens": "leakydash.eth"}
//   <name> url record                       → must point back at <site>
//   <name> privacy.manifest record          → the declared recipients
//   <name> privacy.verdict.canary record    → a verifier's signed verdict
//
// A site with no well-known file can still have Canary's label (the
// verifier's verdict under labels.canary.eth, packages/ens/src/label.ts):
//
//   <host>.labels.canary.eth url            → must point at <site>
//   <host>.labels.canary.eth privacy.verdict.canary
//
// The ENS reads are eth_calls to the Universal Resolver's resolve(name, data),
// which follows ENSv2 names to their resolver; a name that needs an offchain
// (CCIP-read) lookup reverts there and reads as having no records. They go
// through the same anon path as the page's reads (the caller passes it in), so
// the lookup doesn't tell an RPC provider which dapp you're on. The well-known
// file comes straight from the site, which already sees your IP.

import { decodeFunctionResult, encodeFunctionData, namehash, toHex, type Hex } from "viem";
import { LABELS_PARENT, labelName } from "../../packages/ens/src/label.js";
import { parseVerdictRecord, verdictKey, verifyVerdictRecord, type VerdictRecord } from "../../packages/ens/src/verdict.js";
import { parseDappManifest, sameOrigin, type DappManifest } from "./shared.js";

export const UNIVERSAL_RESOLVER = "0xeeeeeeee14d718c2b47d9923deab1335e144eeee";

const universalAbi = [
  {
    type: "function", name: "resolve", stateMutability: "view",
    inputs: [{ name: "name", type: "bytes" }, { name: "data", type: "bytes" }],
    outputs: [{ name: "", type: "bytes" }, { name: "resolver", type: "address" }],
  },
  {
    type: "function", name: "findResolver", stateMutability: "view",
    inputs: [{ name: "name", type: "bytes" }],
    outputs: [{ name: "resolver", type: "address" }, { name: "node", type: "bytes32" }, { name: "offset", type: "uint256" }],
  },
] as const;
const resolverAbi = [
  { type: "function", name: "text", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }, { name: "key", type: "string" }], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "addr", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ name: "", type: "address" }] },
  // ENSv2 Permissioned Resolver: setters take DNS-encoded names; EAC role bitmaps
  { type: "function", name: "setText", stateMutability: "nonpayable", inputs: [{ name: "name", type: "bytes" }, { name: "key", type: "string" }, { name: "value", type: "string" }], outputs: [] },
  { type: "function", name: "roles", stateMutability: "view", inputs: [{ name: "resource", type: "uint256" }, { name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

/** What Canary could check about a verdict record. */
export type VerdictCheck =
  | { state: "invalid"; error: string }
  | {
      state: "read";
      verdict: Omit<VerdictRecord, "signature">;
      /** the signature recovers to the record's signer */
      signed: boolean;
      /** ...who is the verifier name's addr */
      signerIsVerifier: boolean;
      /** the signer can still write this record on the name's resolver: true, false (revoked), or null (not a Permissioned Resolver, can't tell) */
      delegated: boolean | null;
      /** the verdict is about this site and this name */
      matchesSite: boolean;
      expired: boolean;
    };

/** Canary's label for a site that names no ENS name of its own; `error` when it couldn't be read. */
export type Label = { ens: string; verdict: VerdictCheck } | { ens: string; error: string };

export type Declared =
  | { state: "pending" }
  | { state: "none"; label?: Label } // the site names no ENS name
  | { state: "notFound"; ens: string; verdict?: VerdictCheck } // the name has no manifest
  | { state: "unbound"; ens: string; url: string | null } // the name doesn't point back at the site
  | { state: "invalid"; ens: string; error: string; verdict?: VerdictCheck }
  | { state: "error"; ens?: string; error: string; label?: Label }
  | { state: "ok"; ens: string; chainId: number; manifest: DappManifest; verdict?: VerdictCheck };

/** Names we can hash without ENSIP-15 normalization: lowercase ASCII labels. Anything else is refused, not guessed at. */
export function checkName(name: unknown): string {
  if (typeof name !== "string" || !/^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/.test(name)) throw new Error(`unsupported ENS name ${JSON.stringify(name)}`);
  return name;
}

/** DNS wire format, as the Universal Resolver and Permissioned Resolver setters take names. */
export function dnsEncode(name: string): Hex {
  const bytes: number[] = [];
  for (const label of name.split(".")) bytes.push(label.length, ...new TextEncoder().encode(label));
  return toHex(new Uint8Array([...bytes, 0]));
}

/** Calldata for `resolve(name, text(node, key))`. */
export function textCallData(name: string, key: string): Hex {
  const inner = encodeFunctionData({ abi: resolverAbi, functionName: "text", args: [namehash(name), key] });
  return encodeFunctionData({ abi: universalAbi, functionName: "resolve", args: [dnsEncode(name), inner] });
}

/** The record, or null when it's empty. */
export function decodeTextResult(result: Hex): string | null {
  const [inner] = decodeFunctionResult({ abi: universalAbi, functionName: "resolve", data: result });
  if (inner === "0x") return null;
  const s = decodeFunctionResult({ abi: resolverAbi, functionName: "text", data: inner });
  return s === "" ? null : s;
}

export type EthCall = (to: string, data: Hex, from?: string) => Promise<{ result?: string; error?: { message: string } }>;

const reverted = (a: { error?: { message: string } }) => !!a.error && /revert/i.test(a.error.message);

/** One text record. A revert (no resolver, unknown name) reads as an empty record. */
export async function readText(call: EthCall, ur: string, name: string, key: string): Promise<string | null> {
  const a = await call(ur, textCallData(name, key));
  if (a.error) {
    if (reverted(a)) return null;
    throw new Error(a.error.message);
  }
  return a.result && a.result !== "0x" ? decodeTextResult(a.result as Hex) : null;
}

/** The name's ETH address record, or null. */
export async function readAddr(call: EthCall, ur: string, name: string): Promise<string | null> {
  const inner = encodeFunctionData({ abi: resolverAbi, functionName: "addr", args: [namehash(name)] });
  const a = await call(ur, encodeFunctionData({ abi: universalAbi, functionName: "resolve", args: [dnsEncode(name), inner] }));
  if (a.error) {
    if (reverted(a)) return null;
    throw new Error(a.error.message);
  }
  const [res] = decodeFunctionResult({ abi: universalAbi, functionName: "resolve", data: a.result as Hex });
  if (res === "0x") return null;
  const addr = decodeFunctionResult({ abi: resolverAbi, functionName: "addr", data: res });
  return /^0x0{40}$/i.test(addr) ? null : addr;
}

/**
 * Can `account` still write `key` on `name`? Simulates setText from it on the
 * name's resolver (works whichever delegation API granted it). null when the
 * resolver has no Enhanced Access Control (e.g. an ENSv1 name behind the
 * Universal Resolver's v1 adapter): there's no role to check.
 */
export async function canWriteText(call: EthCall, ur: string, name: string, key: string, account: string): Promise<boolean | null> {
  const f = await call(ur, encodeFunctionData({ abi: universalAbi, functionName: "findResolver", args: [dnsEncode(name)] }));
  if (f.error || !f.result) return null;
  const [resolver] = decodeFunctionResult({ abi: universalAbi, functionName: "findResolver", data: f.result as Hex });
  if (/^0x0{40}$/i.test(resolver)) return null;
  const eac = await call(resolver, encodeFunctionData({ abi: resolverAbi, functionName: "roles", args: [0n, account as Hex] }));
  if (eac.error || !eac.result || eac.result === "0x") return null;
  const w = await call(resolver, encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [dnsEncode(name), key, ""] }), account);
  if (w.error && !reverted(w)) throw new Error(w.error.message);
  return !w.error;
}

/** Check a verdict record: signature, signer = the verifier name's addr, role still delegated, about this site, not expired. */
export async function checkVerdict(raw: string, site: { origin: string; ens: string }, call: EthCall, ur: string, key: string, now = Date.now()): Promise<VerdictCheck> {
  let r: VerdictRecord;
  try {
    r = parseVerdictRecord(raw);
  } catch (e) {
    return { state: "invalid", error: String((e as Error).message ?? e) };
  }
  const signed = await verifyVerdictRecord(r).then(() => true, () => false);
  let signerIsVerifier = false;
  try {
    const addr = signed ? await readAddr(call, ur, checkName(r.verifier)) : null;
    signerIsVerifier = !!addr && addr.toLowerCase() === r.signer.toLowerCase();
  } catch {
    /* an unsupported or unresolvable verifier name: not verified */
  }
  const delegated = signed ? await canWriteText(call, ur, site.ens, key, r.signer) : null;
  const { signature: _, ...verdict } = r;
  return {
    state: "read",
    verdict,
    signed,
    signerIsVerifier,
    delegated,
    matchesSite: r.name === site.ens && sameOrigin(r.origin, site.origin),
    expired: now / 1000 > r.expiresAt,
  };
}

/** The site's ENS name from /.well-known/canary.json, or null if it doesn't publish one. */
export async function siteEnsName(origin: string, timeoutMs = 5000): Promise<string | null> {
  const r = await fetch(new URL("/.well-known/canary.json", origin), { credentials: "omit", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (r.status === 404 || r.status === 410) return null;
  if (!r.ok) throw new Error(`/.well-known/canary.json: HTTP ${r.status}`);
  const j = await r.json().catch(() => null);
  return j?.ens === undefined ? null : checkName(j.ens);
}

type EnsConfig = { chainId: number; universalResolver: string; verifier?: string; labels?: string };

/** Canary's label for the site, if it has one that points back at it. */
async function readLabel(origin: string, call: EthCall, ens: EnsConfig, now: number): Promise<Label | undefined> {
  const name = labelName(origin, ens.labels ?? LABELS_PARENT);
  if (!name) return undefined;
  const ur = ens.universalResolver;
  const vKey = verdictKey(ens.verifier ?? "canary");
  try {
    const [url, raw] = await Promise.all([readText(call, ur, name, "url"), readText(call, ur, name, vKey)]);
    if (!raw || !(url && sameOrigin(url, origin))) return undefined;
    return { ens: name, verdict: await checkVerdict(raw, { origin, ens: name }, call, ur, vKey, now) };
  } catch (e) {
    return { ens: name, error: String((e as Error).message ?? e) };
  }
}

/** Everything the popup needs to show declared vs observed, and the verdict, for one site. */
export async function readDeclared(origin: string, call: EthCall, ens: EnsConfig, now = Date.now()): Promise<Declared> {
  let name: string | null;
  try {
    name = await siteEnsName(origin);
  } catch (e) {
    const label = await readLabel(origin, call, ens, now);
    return { state: "error", error: String((e as Error).message ?? e), ...(label ? { label } : {}) };
  }
  if (!name) {
    const label = await readLabel(origin, call, ens, now);
    return { state: "none", ...(label ? { label } : {}) };
  }
  const ur = ens.universalResolver;
  const vKey = verdictKey(ens.verifier ?? "canary");
  try {
    const [url, raw, verdictRaw] = await Promise.all([
      readText(call, ur, name, "url"),
      readText(call, ur, name, "privacy.manifest"),
      readText(call, ur, name, vKey),
    ]);
    // Both directions: the site names the ENS name, and the name names the site.
    if (!(url && sameOrigin(url, origin))) return { state: "unbound", ens: name, url };
    const verdict = verdictRaw ? await checkVerdict(verdictRaw, { origin, ens: name }, call, ur, vKey, now) : undefined;
    const v = verdict ? { verdict } : {};
    if (!raw) return { state: "notFound", ens: name, ...v };
    let manifest: DappManifest;
    try {
      manifest = parseDappManifest(raw);
    } catch (e) {
      return { state: "invalid", ens: name, error: String((e as Error).message ?? e), ...v };
    }
    if (manifest.origin && !sameOrigin(manifest.origin, origin)) return { state: "unbound", ens: name, url: manifest.origin };
    return { state: "ok", ens: name, chainId: ens.chainId, manifest, ...v };
  } catch (e) {
    return { state: "error", ens: name, error: String((e as Error).message ?? e) };
  }
}
