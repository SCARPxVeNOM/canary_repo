/* The privacy manifest: an agent's declared policy (agent-sdk.md §3.3, §4).
   Stored in the agent's ENSv2 `privacy.manifest` text record, or in a local
   file. The gateway enforces it: declared = enforced. */

import { isAddress } from "./address.js";

export type HostRule = "anon" | "direct" | "block";
export type WriteMode = "anon" | "private" | "direct";

export type Manifest = {
  v: 1;
  /** the agent's ENS name, e.g. trader-01.agents.canary.eth */
  agent?: string;
  /** per destination host: exact host, or "*.example.com" for its subdomains */
  hosts: Record<string, HostRule>;
  /** what happens to a host that isn't listed (§9: block by default) */
  undeclared: "block" | "report";
  rpc: {
    /** how eth_sendRawTransaction leaves: anon (public RPC over anon-rpc), private (relay over anon-rpc), direct */
    write: WriteMode;
  };
  /** the gateway's report key address: the only account meant to write privacy.report (agent-sdk.md §4) */
  reporter?: string;
  /** whether the agent's wallets are published on its name; a declaration, not enforced here */
  wallets?: "disclosed" | "undisclosed";
  llm?: {
    /** addresses the pseudonymizer passes through unchanged (well-known contracts) */
    allow?: string[];
  };
};

export const DEFAULT_MANIFEST: Manifest = { v: 1, hosts: {}, undeclared: "block", rpc: { write: "anon" } };

const RULES = new Set(["anon", "direct", "block"]);

/** Parse and validate a manifest (JSON text or object). Throws with the path of the first problem. */
export function parseManifest(input: string | unknown): Manifest {
  const m: any = typeof input === "string" ? JSON.parse(input) : input;
  if (!m || typeof m !== "object") throw new TypeError("manifest: not an object");
  if (m.v !== 1) throw new TypeError(`manifest.v: expected 1, got ${JSON.stringify(m.v)}`);
  const hosts: Record<string, HostRule> = {};
  for (const [h, r] of Object.entries(m.hosts ?? {})) {
    if (!RULES.has(r as string)) throw new TypeError(`manifest.hosts["${h}"]: expected anon | direct | block, got ${JSON.stringify(r)}`);
    if (!/^(\*\.)?[a-z0-9.-]+$/i.test(h)) throw new TypeError(`manifest.hosts: bad host pattern "${h}"`);
    hosts[h.toLowerCase()] = r as HostRule;
  }
  const undeclared = m.undeclared ?? "block";
  if (undeclared !== "block" && undeclared !== "report") throw new TypeError(`manifest.undeclared: expected block | report`);
  const write = m.rpc?.write ?? "anon";
  if (!["anon", "private", "direct"].includes(write)) throw new TypeError(`manifest.rpc.write: expected anon | private | direct`);
  if (m.reporter !== undefined && !isAddress(m.reporter)) throw new TypeError("manifest.reporter: expected an address");
  const allow = m.llm?.allow ?? [];
  if (!Array.isArray(allow) || !allow.every(isAddress)) throw new TypeError("manifest.llm.allow: expected an array of addresses");
  return {
    v: 1,
    ...(typeof m.agent === "string" ? { agent: m.agent } : {}),
    hosts,
    undeclared,
    rpc: { write },
    ...(m.reporter ? { reporter: m.reporter } : {}),
    ...(m.wallets === "disclosed" || m.wallets === "undisclosed" ? { wallets: m.wallets } : {}),
    ...(allow.length ? { llm: { allow: allow.map((a: string) => a.toLowerCase()) } } : {}),
  };
}

/** The rule for a host: exact match first, then the longest "*.suffix" match. */
export function ruleFor(m: Manifest, host: string): HostRule | undefined {
  const h = host.toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (m.hosts[h]) return m.hosts[h];
  let best: { len: number; rule: HostRule } | undefined;
  for (const [pat, rule] of Object.entries(m.hosts)) {
    if (!pat.startsWith("*.")) continue;
    const suffix = pat.slice(1); // ".example.com"
    if (h.endsWith(suffix) && (!best || suffix.length > best.len)) best = { len: suffix.length, rule };
  }
  return best?.rule;
}

/** JSON with sorted keys, so the same manifest always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
