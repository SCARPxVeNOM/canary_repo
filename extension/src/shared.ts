// The extension's view of @ayush_saklani/canary-core (packages/core): one classifier and
// one address matcher for both hosts, the browser extension and the agent
// gateway/SDK. esbuild bundles the core source straight into each script.
//
// What stays here is extension-specific: its subset of coverage categories,
// their popup labels, and the page-side Observation shape.

import type { AddressNeedles, Category as CoreCategory, Observation as CoreObservation } from "../../packages/core/src/index.js";

export {
  SUBSTITUTABLE,
  parseJsonRpc,
  needlesFor,
  findAddress,
  registrableDomain,
  isThirdParty,
  isLocalHost,
  knownChain,
  chainHintFromUrl,
  parseDappManifest,
  compareDeclared,
  sameOrigin,
  type DappManifest,
  type DeclaredRow,
  type RpcCall,
  type Taint,
  type AddressNeedles,
} from "../../packages/core/src/index.js";

/** The categories a browser page can produce (no LLM traffic, no manifest). */
export type Category = Exclude<CoreCategory, "pseudonymized" | "undeclared">;

export const CATEGORY_LABEL: Record<Category, string> = {
  protected: "Protected",
  protectedIpOnly: "Protected (IP only)",
  blocked: "Blocked",
  detected: "Detected, unprotected",
  backend: "Backend / indexer",
  notInspected: "Not inspected",
  failedClosed: "Failed closed",
  direct: "Direct (you allowed it)",
  localNode: "Local node (no third party)",
};

export type Observation = Omit<CoreObservation, "category" | "channel" | "firstParty"> & {
  category: Category;
  channel: "fetch" | "xhr" | "websocket" | "beacon" | "url";
  firstParty: boolean;
  /** for the receipt: the request around your address, as the recipient would have seen it */
  snippet?: string;
  /** for the receipt: the first JSON-RPC call, as sent */
  sample?: string;
  /** for the receipt: where the call went instead (Canary's read endpoint) */
  via?: string;
};

/** Up to `radius` characters either side of the first of your addresses in `haystack` (hex or base64). Kept on this device only. */
export function snippetAround(haystack: string, needles: AddressNeedles[], radius = 40): string | undefined {
  const lower = haystack.toLowerCase();
  for (const n of needles) {
    let at = lower.indexOf(n.hex);
    let len = n.hex.length;
    for (const b of at < 0 ? n.b64 : []) if ((at = haystack.indexOf(b)) >= 0) { len = b.length; break; }
    if (at < 0) continue;
    const a = Math.max(0, at - radius);
    const z = Math.min(haystack.length, at + len + radius);
    return `${a > 0 ? "…" : ""}${haystack.slice(a, z).replace(/\s+/g, " ")}${z < haystack.length ? "…" : ""}`;
  }
  return undefined;
}

/** `eth_getBalance("0x5ca1…", "latest")`: a call as the provider gets it, cut to `max` characters. */
export function sampleCall(c: { method: string; params?: unknown } | undefined, max = 140): string | undefined {
  if (!c) return undefined;
  const p = Array.isArray(c.params) ? JSON.stringify(c.params).slice(1, -1) : c.params === undefined ? "" : JSON.stringify(c.params);
  const s = `${c.method}(${p})`;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
