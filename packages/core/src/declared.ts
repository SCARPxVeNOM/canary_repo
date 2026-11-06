/* A dapp's declared recipients, and how they compare with what a page was
   seen sending (idea.md §2 "Declare", §3.3).

   The manifest lives in the `privacy.manifest` text record of the dapp's ENS
   name; the site names that ENS name at /.well-known/canary.json, and the
   name's `url` record points back at the site. Different from the agent
   manifest in policy.ts: a dapp declares who receives your address, an agent
   declares what its gateway enforces. */

export type RecipientKind = "rpc" | "analytics" | "backend" | "other";

export type DappManifest = {
  /** the dapp's ENS name */
  name?: string;
  /** the site this manifest is for */
  origin?: string;
  /** every party that receives the connected address, and why. Host: exact, or "*.example.com" */
  recipients: { host: string; kind: RecipientKind; purpose?: string }[];
  rpc?: { anonByDefault?: boolean };
};

const KINDS = new Set(["rpc", "analytics", "backend", "other"]);

/** Parse and validate a dapp manifest (JSON text or object). Throws with the path of the first problem. */
export function parseDappManifest(input: string | unknown): DappManifest {
  const m: any = typeof input === "string" ? JSON.parse(input) : input;
  if (!m || typeof m !== "object") throw new TypeError("manifest: not an object");
  if (!Array.isArray(m.recipients)) throw new TypeError("manifest.recipients: expected an array");
  const recipients = m.recipients.map((r: any, i: number) => {
    if (typeof r?.host !== "string" || !/^(\*\.)?[a-z0-9.-]+$/i.test(r.host)) throw new TypeError(`manifest.recipients[${i}].host: bad host "${r?.host}"`);
    const kind = r.kind ?? "other";
    if (!KINDS.has(kind)) throw new TypeError(`manifest.recipients[${i}].kind: expected rpc | analytics | backend | other`);
    return { host: r.host.toLowerCase(), kind, ...(typeof r.purpose === "string" ? { purpose: r.purpose } : {}) };
  });
  return {
    ...(typeof m.name === "string" ? { name: m.name } : {}),
    ...(typeof m.origin === "string" ? { origin: m.origin } : {}),
    recipients,
    ...(m.rpc && typeof m.rpc === "object" ? { rpc: { anonByDefault: m.rpc.anonByDefault === true } } : {}),
  };
}

const hostMatches = (pattern: string, host: string) =>
  pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern;

/** Same origin, ignoring a trailing slash and case. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** What a page was seen sending to one host (the extension's recipient record, the scanner's). */
export type ObservedRecipient = { host: string; firstParty: boolean; carriedAddress: boolean; methods?: string[] };

export type DeclaredRow = {
  host: string;
  /** declared and observed · observed but not declared · declared, not observed on this page */
  status: "declared" | "undeclared" | "notSeen";
  kind?: RecipientKind;
  purpose?: string;
};

/**
 * Declared vs observed. A third party counts as a recipient if the page sent
 * it your address or JSON-RPC calls (an RPC provider learns who you are from
 * the calls themselves), whether or not Canary then blocked or answered them.
 * The dapp itself is never a "recipient": it already has your address.
 */
export function compareDeclared(m: DappManifest, observed: ObservedRecipient[]): { rows: DeclaredRow[]; undeclared: number } {
  const rows: DeclaredRow[] = [];
  const seen = new Set<number>();
  for (const o of observed) {
    if (o.firstParty || !(o.carriedAddress || o.methods?.length)) continue;
    const host = o.host.toLowerCase();
    const i = m.recipients.findIndex((r) => hostMatches(r.host, host));
    if (i < 0) {
      rows.push({ host, status: "undeclared" });
      continue;
    }
    seen.add(i);
    const r = m.recipients[i];
    rows.push({ host, status: "declared", kind: r.kind, ...(r.purpose ? { purpose: r.purpose } : {}) });
  }
  m.recipients.forEach((r, i) => {
    if (!seen.has(i)) rows.push({ host: r.host, status: "notSeen", kind: r.kind, ...(r.purpose ? { purpose: r.purpose } : {}) });
  });
  const order = { undeclared: 0, declared: 1, notSeen: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status] || a.host.localeCompare(b.host));
  return { rows, undeclared: rows.filter((r) => r.status === "undeclared").length };
}
