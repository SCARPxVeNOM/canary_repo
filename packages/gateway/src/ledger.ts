/* Coverage ledger: every egress decision, counted (docs/agent-sdk.md §3.5). */

import { EventEmitter } from "node:events";
import type { Category, Channel, Observation } from "@canary/core";

export type Egress = Observation & { at: number; count?: number };

export type Counts = {
  rpc: { total: number; protected: number; ipOnly: number; direct: number; blocked: number; failedClosed: number; linked: number };
  http: { anon: number; direct: number; blocked: number; undeclared: number; notInspected: number; failedClosed: number };
  llm: { requests: number; addressesPseudonymized: number };
};

const RPC_CHANNELS = new Set<Channel>(["rpc"]);

export class Ledger extends EventEmitter {
  windowStart = Math.floor(Date.now() / 1000);
  counts: Counts = Ledger.empty();
  latencies: number[] = [];
  hosts = new Map<string, Partial<Record<Category, number>>>();

  static empty(): Counts {
    return {
      rpc: { total: 0, protected: 0, ipOnly: 0, direct: 0, blocked: 0, failedClosed: 0, linked: 0 },
      http: { anon: 0, direct: 0, blocked: 0, undeclared: 0, notInspected: 0, failedClosed: 0 },
      llm: { requests: 0, addressesPseudonymized: 0 },
    };
  }

  record(o: Omit<Egress, "at">) {
    const e: Egress = { ...o, at: Date.now() };
    const n = o.count ?? 1;
    const c = this.counts;
    if (o.channel === "llm") {
      if (o.category === "pseudonymized") c.llm.addressesPseudonymized += n;
      else c.llm.requests += n;
    } else if (RPC_CHANNELS.has(o.channel)) {
      c.rpc.total += n;
      if (o.category === "protected") c.rpc.protected += n;
      else if (o.category === "protectedIpOnly") c.rpc.ipOnly += n;
      else if (o.category === "direct") c.rpc.direct += n;
      else if (o.category === "blocked") c.rpc.blocked += n;
      else if (o.category === "failedClosed") c.rpc.failedClosed += n;
      if (o.note?.includes("links wallets")) c.rpc.linked += n;
    } else {
      if (o.category === "protected" || o.category === "protectedIpOnly") c.http.anon += n;
      else if (o.category === "direct") c.http.direct += n;
      else if (o.category === "blocked") c.http.blocked += n;
      else if (o.category === "undeclared") c.http.undeclared += n;
      else if (o.category === "failedClosed") c.http.failedClosed += n;
      if (o.category === "notInspected" || o.note?.includes("not inspected")) c.http.notInspected += n;
    }
    if (o.ms !== undefined) {
      this.latencies.push(o.ms);
      if (this.latencies.length > 5000) this.latencies.splice(0, this.latencies.length - 5000);
    }
    if (o.host) {
      const h = this.hosts.get(o.host) ?? {};
      h[o.category] = (h[o.category] ?? 0) + n;
      this.hosts.set(o.host, h);
    }
    this.emit("egress", e);
  }

  percentile(p: number): number | undefined {
    if (!this.latencies.length) return undefined;
    const s = [...this.latencies].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  }

  /** Start a new reporting window. */
  rotate() {
    this.windowStart = Math.floor(Date.now() / 1000);
    this.counts = Ledger.empty();
    this.latencies = [];
    this.hosts.clear();
  }
}
