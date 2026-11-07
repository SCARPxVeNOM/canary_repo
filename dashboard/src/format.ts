/* Display helpers and the category vocabulary, shared by both tabs. Labels
   follow @ayush_saklani/canary-core's CATEGORY_LABEL, and colours follow the extension
   popup, so the dashboard and the popup read as one product. */

import type { Category, Channel, HostRule } from "./types";

export const CATEGORY: Record<Category, { label: string; tone: Tone }> = {
  protected: { label: "Protected", tone: "green" },
  protectedIpOnly: { label: "Protected (IP only)", tone: "blue" },
  blocked: { label: "Blocked", tone: "yellow" },
  detected: { label: "Detected, unprotected", tone: "red" },
  backend: { label: "Backend / indexer", tone: "grey" },
  notInspected: { label: "Not inspected", tone: "grey" },
  failedClosed: { label: "Failed closed", tone: "amber" },
  direct: { label: "Direct (declared)", tone: "violet" },
  pseudonymized: { label: "Pseudonymized", tone: "teal" },
  undeclared: { label: "Undeclared", tone: "red" },
  localNode: { label: "Local node", tone: "grey" },
};

export type Tone = "green" | "blue" | "yellow" | "amber" | "red" | "violet" | "teal" | "grey";

export const CHANNEL_LABEL: Record<Channel, string> = {
  rpc: "RPC",
  llm: "LLM",
  sdk: "SDK",
  proxy: "HTTP",
  connect: "HTTPS",
  fetch: "fetch",
  xhr: "XHR",
  websocket: "WS",
  beacon: "beacon",
  url: "URL",
};

export const RULE: Record<HostRule, { label: string; tone: Tone; hint: string }> = {
  anon: { label: "via Tor", tone: "green", hint: "sent through anon-rpc; the host sees a Tor exit" },
  direct: { label: "direct", tone: "violet", hint: "sent normally, declared in the policy" },
  block: { label: "blocked", tone: "yellow", hint: "refused" },
};

/** 0x5Ca1ab1e…C0FfEe */
export const short = (hex: string, head = 6, tail = 4) => (hex.length > head + tail + 2 ? `${hex.slice(0, head)}…${hex.slice(-tail)}` : hex);

export const num = (n: number) => n.toLocaleString("en-US");

export const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

export const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);

export const dateTime = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export const CHAIN_NAME: Record<string, string> = { "1": "Ethereum", "11155111": "Sepolia" };
