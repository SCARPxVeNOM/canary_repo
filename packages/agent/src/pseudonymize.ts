/* Prompt pseudonymizer (docs/agent-sdk.md §3.4).

   Before a request reaches an LLM provider:
     agent wallets        0x5Ca1…FfEe → WALLET_1   (also bare 40-hex forms)
     other addresses      0xA0b8…     → ADDR_1     (unless allow-listed)
     32-byte hashes       0x…(64 hex) → HASH_1     (tx hashes, mostly the agent's own)
     the agent's ENS name(s)          → AGENT_NAME, AGENT_NAME_2
   Plain ASCII aliases: models mangle unusual brackets.

   Not replaced, and said so in coverage: amounts and balances, and addresses
   inside longer hex blobs (calldata). Exact matching, not AI.

   Restoring: `restore` for whole bodies, `restoreDeep` for parsed values
   (strict mode throws on an alias with no mapping: a model that invents
   WALLET_9 must fail the tool call, never be guessed), and
   `restoreTextStream` for text deltas, holding back a partial alias split
   across chunks. Raw SSE/JSON streams can't be restored in place (an alias can
   be split across events), so restore at the framework level: wrapTools(), or
   restore the accumulated text. */

const ADDR_RE = /(?<![0-9a-fA-Fx])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const HASH_RE = /(?<![0-9a-fA-Fx])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
const BARE_RE = /(?<![0-9a-fA-Fx])[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const ALIAS_RE = /\b(?:(?:WALLET|ADDR|HASH)_\d+|AGENT_NAME(?:_\d+)?)\b/g;
const PREFIXES = ["WALLET_", "ADDR_", "HASH_", "AGENT_NAME"];

export class UnknownAliasError extends Error {
  constructor(readonly aliases: string[]) {
    super(`the model used ${aliases.join(", ")}, which Canary never issued; refusing to guess`);
    this.name = "UnknownAliasError";
  }
}

export type PseudonymizerOptions = {
  wallets?: string[];
  agentNames?: string[];
  /** addresses that pass through unchanged (well-known contracts: USDC, WETH, routers) */
  allow?: string[];
  /** replace 32-byte hashes (default true) */
  hashes?: boolean;
};

export class Pseudonymizer {
  private toAlias = new Map<string, string>();
  private fromAlias = new Map<string, string>();
  private walletIndex = new Map<string, number>();
  private allow: Set<string>;
  private names: string[] = [];
  private nextAddr = 1;
  private nextHash = 1;
  private hashes: boolean;

  constructor(opts: PseudonymizerOptions = {}) {
    this.allow = new Set((opts.allow ?? []).map((a) => a.toLowerCase()));
    this.hashes = opts.hashes ?? true;
    this.addWallets(opts.wallets ?? []);
    for (const n of opts.agentNames ?? []) this.addAgentName(n);
  }

  addWallets(addrs: string[]) {
    for (const a of addrs) {
      const k = a.toLowerCase();
      if (this.walletIndex.has(k)) continue;
      this.walletIndex.set(k, this.walletIndex.size + 1);
      // Bound up front: the agent's own wallets always restore, even in a fresh session.
      this.bind(k, `WALLET_${this.walletIndex.size}`, a);
    }
  }

  addAgentName(name: string) {
    if (!name || this.names.includes(name.toLowerCase())) return;
    this.names.push(name.toLowerCase());
    this.bind(name.toLowerCase(), this.names.length === 1 ? "AGENT_NAME" : `AGENT_NAME_${this.names.length}`, name);
  }

  get size() {
    return this.fromAlias.size;
  }

  private bind(key: string, alias: string, original: string) {
    this.toAlias.set(key, alias);
    if (!this.fromAlias.has(alias)) this.fromAlias.set(alias, original);
    return alias;
  }

  private addressAlias(original: string): string | undefined {
    const k = original.toLowerCase();
    if (this.allow.has(k)) return undefined;
    const known = this.toAlias.get(k);
    if (known) return known;
    const w = this.walletIndex.get(k);
    return this.bind(k, w ? `WALLET_${w}` : `ADDR_${this.nextAddr++}`, original);
  }

  /** Replace addresses, hashes and agent names. Returns the text and how many replacements were made. */
  redact(text: string): { text: string; count: number } {
    let count = 0;
    let out = text;
    for (const name of this.names) {
      const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      out = out.replace(re, () => (count++, this.toAlias.get(name)!));
    }
    if (this.hashes) {
      out = out.replace(HASH_RE, (h) => {
        count++;
        const k = h.toLowerCase();
        return this.toAlias.get(k) ?? this.bind(k, `HASH_${this.nextHash++}`, h);
      });
    }
    out = out.replace(ADDR_RE, (a) => {
      const alias = this.addressAlias(a);
      if (alias) count++;
      return alias ?? a;
    });
    // Bare 40-hex: only the agent's own wallets (anything else is too likely to be other data).
    out = out.replace(BARE_RE, (h) => {
      if (!this.walletIndex.has("0x" + h.toLowerCase())) return h;
      count++;
      return this.addressAlias("0x" + h)!;
    });
    return { text: out, count };
  }

  /** Map aliases back. Unknown aliases are left as they are and reported. */
  restore(text: string): { text: string; unknown: string[] } {
    const unknown: string[] = [];
    const out = text.replace(ALIAS_RE, (a) => {
      const o = this.fromAlias.get(a);
      if (o === undefined) unknown.push(a);
      return o ?? a;
    });
    return { text: out, unknown };
  }

  /** Restore every string in a parsed value (tool-call arguments). strict: throw on unknown aliases. */
  restoreDeep<T>(value: T, opts: { strict?: boolean } = {}): T {
    const unknown: string[] = [];
    const walk = (v: any): any => {
      if (typeof v === "string") {
        const r = this.restore(v);
        unknown.push(...r.unknown);
        return r.text;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    const out = walk(value);
    if (opts.strict && unknown.length) throw new UnknownAliasError([...new Set(unknown)]);
    return out;
  }

  /** For streams of text deltas: restores aliases even when one is split across chunks. */
  restoreTextStream(): TransformStream<string, string> {
    let buf = "";
    return new TransformStream<string, string>({
      transform: (chunk, ctl) => {
        buf += chunk;
        const hold = partialAliasTail(buf);
        const ready = buf.slice(0, buf.length - hold);
        buf = buf.slice(buf.length - hold);
        if (ready) ctl.enqueue(this.restore(ready).text);
      },
      flush: (ctl) => {
        if (buf) ctl.enqueue(this.restore(buf).text);
      },
    });
  }
}

/** Length of the longest suffix of `s` that could still grow into an alias. */
function partialAliasTail(s: string): number {
  for (let k = Math.min(s.length, 24); k > 0; k--) {
    const tail = s.slice(-k);
    if (k < s.length && /[A-Za-z0-9_]/.test(s[s.length - k - 1]!)) continue; // must start at a word boundary
    if (PREFIXES.some((p) => p.startsWith(tail))) return k;
    if (/^(?:(?:WALLET|ADDR|HASH)_\d*|AGENT_NAME(?:_\d*)?)$/.test(tail)) return k;
  }
  return 0;
}
