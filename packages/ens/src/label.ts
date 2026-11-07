/* Canary's privacy labels: the verifier's verdict on a site that publishes no
   ENS name of its own, under a name Canary holds (docs/design-notes.md §3.3).

     app.uniswap.org → app-uniswap-org.labels.canary.eth
       url                      https://app.uniswap.org (binds the label to the site)
       privacy.verdict.canary   a verdict from a baseline scan, signed by verifier.canary.eth

   Canary owns the labels and their resolver and delegates the verdict key to
   the verifier, as a dapp does on its own name. A site that names its own
   (/.well-known/canary.json) is read from there: a label is only a fallback.
   Two hosts can map to one label (a-b.com, a.b-com); the url record says
   which site it is about, and readers check it. */

export const LABELS_PARENT = "labels.canary.eth";

/** The label's name for a site's origin, or null for a host that can't have one (an IP address, no dot, or not a plain lowercase ASCII label). */
export function labelName(origin: string, parent = LABELS_PARENT): string | null {
  let host: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    host = u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  if (!host.includes(".") || host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return null;
  const label = host.replace(/\./g, "-");
  // ENSIP-15 rejects ASCII labels with "--" in 3rd–4th place (xn--…)
  if (!/^[a-z0-9-]{1,63}$/.test(label) || label.slice(2, 4) === "--") return null;
  return `${label}.${parent}`;
}
