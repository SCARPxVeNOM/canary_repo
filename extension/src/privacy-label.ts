// What a site's privacy label says, in words: the site's own ENS manifest,
// Canary's label for it (labels.canary.eth, packages/ens/src/label.ts), or
// nothing. Shared by the popup, the dashboard and the notice the page shows
// when you connect a wallet, so all three say the same thing.

import type { Declared, VerdictCheck } from "./ens.js";

export type PrivacyLabel = {
  source: "pending" | "site" | "canary" | "none";
  ens?: string;
  tone: "good" | "bad" | "warn" | "muted";
  /** "3 third parties got your address in Canary's scan" */
  title: string;
  /** who gets the address, and what kind of service each is */
  rows: { host: string; kind: string }[];
  /** where the label comes from */
  by: string;
  /** why it can't be fully trusted, if anything */
  warning?: string;
};

const KIND: Record<string, string> = { rpc: "RPC provider", "backend+rpc": "RPC provider", backend: "backend", analytics: "analytics", indexer: "indexer" };
const kindOf = (k: string | undefined) => (k ? KIND[k] ?? k : "not said");
const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;
const date = (s: number) => new Date(s * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Why a verdict can't be used at all; null when it checks out. */
function unusable(v: VerdictCheck): string | null {
  if (v.state === "invalid") return `its record is malformed (${v.error})`;
  if (!v.signed) return "its signature doesn't verify";
  if (!v.signerIsVerifier) return `it isn't signed by ${v.verdict.verifier}'s address`;
  if (!v.matchesSite) return "it is about another site";
  return null;
}

/** What still holds a usable verdict back. */
function caveat(v: VerdictCheck & { state: "read" }): string | undefined {
  if (v.delegated === false) return `${v.verdict.verifier} can no longer write this record: its role was revoked.`;
  if (v.expired) return `It expired on ${date(v.verdict.expiresAt)}; the site may have changed since.`;
  return undefined;
}

export function privacyLabel(d: Declared | undefined): PrivacyLabel {
  if (!d || d.state === "pending") return { source: "pending", tone: "muted", title: "Looking for this site's privacy label…", rows: [], by: "" };

  if (d.state === "ok") {
    const rows = d.manifest.recipients.map((r) => ({ host: r.host, kind: kindOf(r.kind) }));
    const v = d.verdict && !unusable(d.verdict) && d.verdict.state === "read" ? d.verdict : undefined;
    const more = v?.verdict.result === "undeclared" ? v.verdict.undeclaredHosts : [];
    return {
      source: "site",
      ens: d.ens,
      tone: more.length ? "bad" : "good",
      title: rows.length ? `The site says ${n(rows.length, "third party gets", "third parties get")} your address` : "The site says no third party gets your address",
      rows,
      by: `Published by the site in ${d.ens}${v ? `, checked by ${v.verdict.verifier} on ${date(v.verdict.issuedAt)}` : ""}`,
      ...(more.length ? { warning: `${v!.verdict.verifier} saw it send your address to more: ${more.join(", ")}.` } : v ? { warning: caveat(v) } : {}),
    };
  }

  const label = d.state === "none" || d.state === "error" ? d.label : undefined;
  if (label && "verdict" in label) {
    const v = label.verdict;
    const why = unusable(v);
    if (why || v.state !== "read") return { source: "none", tone: "warn", title: "No privacy label for this site", rows: [], by: "", warning: `Canary's label for it was ignored: ${why}.` };
    const got = v.verdict.addressRecipients;
    const by = `Canary's label ${label.ens}, signed by ${v.verdict.verifier}, scanned ${date(v.verdict.issuedAt)}`;
    if (!got) return { source: "canary", ens: label.ens, tone: "muted", title: "Canary scanned this site", rows: [], by, warning: caveat(v) };
    return {
      source: "canary",
      ens: label.ens,
      tone: caveat(v) ? "warn" : got.length ? "bad" : "good",
      title: got.length ? `${n(got.length, "third party", "third parties")} got your address in Canary's scan` : "No third party got your address in Canary's scan",
      rows: got.map((r) => ({ host: r.host, kind: kindOf(r.kind) })),
      by,
      warning: caveat(v),
    };
  }

  if (d.state === "none" || (d.state === "error" && !d.ens)) {
    const unread = label && "error" in label ? `Canary's label couldn't be read (${label.error}).` : d.state === "error" ? `Canary couldn't ask the site for one (${d.error}).` : undefined;
    return { source: "none", tone: "muted", title: "No privacy label for this site yet", rows: [], by: "It names no ENS manifest, and Canary hasn't scanned it.", ...(unread ? { warning: unread } : {}) };
  }

  // The site names an ENS name, but there's no manifest Canary can use.
  const why =
    d.state === "notFound" ? `${d.ens} has no privacy.manifest record.`
    : d.state === "unbound" ? `${d.ens} points at ${d.url ?? "no site"}, not this one.`
    : d.state === "invalid" ? `Its manifest can't be read: ${d.error}`
    : `Couldn't read it: ${d.error}`;
  return { source: "site", ens: d.ens, tone: "warn", title: "This site's privacy label can't be used", rows: [], by: `Named by the site: ${d.ens}`, warning: why };
}
