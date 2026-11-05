/* Coverage categories (idea.md §4, agent-sdk.md §3.5).
   Wording rule: never "private" or "leak-free"; always "observed, with gaps". */

export type Category =
  | "protected" // answered via anon-rpc from Canary's read endpoint
  | "protectedIpOnly" // forwarded via anon-rpc to the original/upstream URL
  | "blocked" // refused by policy
  | "detected" // carries an address, left as-is
  | "backend" // non-RPC API traffic, listed by destination
  | "notInspected" // a body or channel Canary could not read
  | "failedClosed" // anon path down: answered with an error instead of going direct
  | "direct" // sent normally, because the policy declares it
  | "pseudonymized" // addresses replaced before reaching an LLM or tool
  | "undeclared" // egress to a host not in the manifest (report mode)
  | "localNode"; // an RPC on this machine or private network: no third party, sent as-is

export const CATEGORY_LABEL: Record<Category, string> = {
  protected: "Protected",
  protectedIpOnly: "Protected (IP only)",
  blocked: "Blocked",
  detected: "Detected, unprotected",
  backend: "Backend / indexer",
  notInspected: "Not inspected",
  failedClosed: "Failed closed",
  direct: "Direct (declared)",
  pseudonymized: "Pseudonymized",
  undeclared: "Undeclared",
  localNode: "Local node (no third party)",
};

export type Channel = "fetch" | "xhr" | "websocket" | "beacon" | "url" | "rpc" | "proxy" | "connect" | "sdk" | "llm";

export type Observation = {
  category: Category;
  channel: Channel;
  host: string;
  firstParty?: boolean;
  /** which of your addresses it carried, if any */
  address?: string;
  encoding?: string;
  methods?: string[];
  ms?: number;
  note?: string;
};
