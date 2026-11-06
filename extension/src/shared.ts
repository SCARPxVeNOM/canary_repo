// The extension's view of @canary/core (packages/core): one classifier and
// one address matcher for both hosts, the browser extension and the agent
// gateway/SDK. esbuild bundles the core source straight into each script.
//
// What stays here is extension-specific: its subset of coverage categories,
// their popup labels, and the page-side Observation shape.

import type { Category as CoreCategory, Observation as CoreObservation } from "../../packages/core/src/index.js";

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
};
