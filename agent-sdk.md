# Canary for Agents: SDK blueprint

**Wrap any autonomous agent so its chain reads go through anon-rpc, and its address doesn't leak to third parties without being declared.**

Draft v0 · 5 Nov 2026 · brainstorm first, then the blueprint. Companion to [idea.md](idea.md) (the browser extension).

---

## TL;DR

- **Yes, we can build it, for any agent**, in two layers:
  1. **Canary Gateway** (any language, any framework): a local process the agent points its RPC URL and HTTP proxy at. Zero code changes.
  2. **`@canary/agent` SDK** (TypeScript first): wraps the agent in-process for the things a proxy can't see. That means request bodies over HTTPS, addresses inside LLM prompts, and per-wallet isolation.
- **The constraint that shapes everything:** anon-rpc's Node harness is a prototype. It runs only the passthrough worker; KPS is stubbed and there's no WebAssembly in its sandbox, so **tor-js can't run natively in Node today**. The browser harness can, and it is tested. So the Gateway hosts the browser harness in a headless Chromium it manages, and swaps to the Node harness when that matures. EF's brief lists "bring anon-rpc to a new platform" as a valid entry, so this is in scope, not a workaround.
- **Agents leak more than dapps.** Their reads reveal *strategy* before they act (quotes, allowances, positions). One server IP links a whole fleet of agent wallets. And LLM providers see addresses in every prompt.
- **ENSv2 fits better here than for dapps.** The ENS brief gives bonus points for "agents as namespaces, each with their own identity and permissions". Each agent gets a subname whose `privacy.manifest` **is** the policy the SDK enforces: declared = enforced, not just compared.
- **Reuse:** `extension/src/shared.ts` (JSON-RPC classifier, address matching, chain detection, coverage categories) is already platform-neutral. It becomes `@canary/core`, shared by the extension and the agent SDK.

---

## 1. Brainstorm: is "wrap any agent" realistic?

### What "any agent" has in common

Whatever the framework (AgentKit, ElizaOS, GOAT, LangChain, Vercel AI SDK, a Python script, an MCP server), an onchain agent's egress falls into five kinds:

| Egress | Example | Who learns what today |
|---|---|---|
| Chain reads | `eth_call`, `getBalance`, `getLogs`, quotes | RPC provider: agent wallet + server IP + timing → strategy |
| Chain writes | `eth_sendRawTransaction` | RPC provider / mempool: IP + tx before inclusion |
| LLM calls | prompt with "wallet 0xabc… holds 3 ETH, should I swap?" | LLM provider: addresses, balances, intent |
| Tool / API calls | price APIs, indexers, block explorers, MCP tools | each API: address + IP |
| Telemetry | framework or SDK analytics | analytics vendor: address + IP |

### Where can we hook in?

| Option | Covers | Language-agnostic | Sees HTTPS bodies | Effort |
|---|---|---|---|---|
| **A. Gateway as RPC URL** (`http://127.0.0.1:8545`) | chain reads/writes | ✅ | ✅ (it's the endpoint) | low |
| **B. Gateway as HTTP(S) proxy** (`HTTPS_PROXY=`) | all HTTP egress | ⚠️ partly: Python `requests`/`httpx` and curl honour proxy env vars; Node's built-in `fetch` ignores them by default (recent Node versions need `NODE_USE_ENV_PROXY=1`; check), which is one reason for D | ❌ host only, unless C | low |
| **C. Proxy + local MITM CA** (operator installs Canary's CA: `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`) | all HTTP egress, full bodies | ✅ | ✅ | medium |
| **D. In-process SDK** (wrap `fetch`, viem transport, ethers provider, LLM client) | everything + prompt redaction + per-wallet isolation | ❌ TS only | ✅ | medium |
| **E. MCP gateway** (Canary as an MCP server that fronts other MCP servers) | tool calls of MCP-based agents | ✅ | ✅ tool args | medium |
| F. Framework plugins (Eliza plugin, AgentKit action provider) | one framework each | ❌ | ✅ | high × N |

**Decision:** A + B + D for the hackathon, C as a flag, E as a stretch goal, F never (adapters on top of D instead).

On a browser the page is the adversary's code and we can only patch it. On a server the **operator owns the box and opts in**, so a proxy with a local CA (C) is legitimate. It gives full coverage for any language, which the extension can never have.

### What we deliberately don't do

- **We never hold or touch keys.** The SDK sees signed transactions, never signers.
- **We don't hide the agent from the services it chooses to use with its own API key.** An LLM provider with your key knows it's you; we can stop it learning *wallet addresses*, not *who pays*.
- **We don't make strategies private onchain.** Transactions are public once included. We hide reads and IP before the act, not the act.

---

## 2. Threat model (say this in the demo)

**Protect against third parties** (RPC providers, indexers, APIs, analytics, LLM providers) learning:
1. **which wallets belong to this agent** (linking wallet ↔ server IP ↔ other wallets of the same operator);
2. **what it's about to do** (reads before writes: quotes, allowances, balances);
3. **addresses in prompts and tool calls** that the agent never meant to disclose.

**Not protected:** contracts and counterparties the agent transacts with; services it authenticates to (they know the account, not the wallet, if we do our job); global passive adversaries beyond what Tor gives.

---

## 3. Architecture

```
┌──────────────────────── operator's machine / container ───────────────────────────┐
│                                                                                   │
│  agent process (any framework, any language)                                      │
│   ├─ RPC URL ───────────────────────────────┐                                     │
│   ├─ HTTPS_PROXY ──────────────────────────┐│                                     │
│   └─ @canary/agent (TS, optional) ─────────┼┼─ in-process: wraps fetch, viem,     │
│        prompt pseudonymizer, per-wallet     ││   ethers, LLM clients; reports      │
│        isolation, egress events            ││   events to the gateway             │
│                                            ▼▼                                     │
│  Canary Gateway (Node)                                                            │
│   ├─ JSON-RPC endpoint :8545  ─ classify → substitute / forward / fail closed     │
│   ├─ HTTP(S) proxy :8080      ─ policy per destination: anon | direct | block     │
│   │    (optional MITM CA for body inspection)                                     │
│   ├─ policy  ◄── ENSv2 manifest of this agent's name (or a local file)            │
│   ├─ coverage ledger + signed egress reports (EIP-712, agent's report key)        │
│   └─ AnonBackend ── chromium: headless Chromium running @anon-rpc/browser-harness │
│                     node:     @anon-rpc/node-harness (passthrough only, today)    │
└──────────────────────────────────────────┬────────────────────────────────────────┘
                                           │ worker.fetch → KPS (WebRTC) → Tor
                                           ▼
                         RPC read endpoints, APIs (see Tor exits only)
```

### 3.1 AnonBackend: how we run anon-rpc outside a browser

```ts
interface AnonBackend {
  ready: Promise<void>;
  fetch(url: string, init: RequestInit & { anonOptions?: { isolationKey?: string } }): Promise<Response>;
  status(): { network: string; state: "warming" | "ready" | "failed"; bootMs?: number };
  close(): Promise<void>;
}
```

| Backend | Networks | Status | Notes |
|---|---|---|---|
| `chromium` | tor-js, Nym, Nox | **works today** (browser harness is tested; tor-js reads took ~1.1–1.4 s in our runs) | Gateway launches headless Chromium (Playwright), serves a local page that boots `@anon-rpc/browser-harness`, and bridges `worker.fetch`. ~150 MB dependency; one browser per gateway, many agents per gateway. |
| `node` | passthrough only | prototype (private package) | QuickJS isolate. No KPS and no WebAssembly in the guest, so no tor-js yet. Its proposed `socket` capability would let a native tor-js skip gateways later. |
| `native` (future) | — | — | Whatever EF ships next; the interface stays the same. |

Bodies stream in the browser harness, so large `eth_getLogs` responses are fine. Each `isolationKey` is passed through untouched (tested across the harness hops); whether tor-js gives each key its own circuit is a question for EF.

### 3.2 Gateway: JSON-RPC endpoint

The same policy as the extension, from `@canary/core`:

- **Standard read methods → substituted:** answered by Canary's read endpoint for that chain, via anon-rpc.
- **Other methods → forwarded** to the upstream the operator configured, via anon-rpc (IP only).
- **`eth_sendRawTransaction` → configurable:**
  - `anon` (default): via anon-rpc to a public RPC, so the IP is hidden;
  - `private`: to a private relay over the anon path;
  - `direct`: declared in the manifest, counted as Direct.
- **Batching and caching:** cache `eth_chainId` / `eth_getCode`; batch reads that arrive within a few ms. This matters more for agents that poll.
- **Per-wallet isolation:** `isolationKey = "addr:<address>"` for every request that contains one of the agent's addresses. Two wallets of the same operator should not look linked at the exit.
- **Timing jitter (option):** random delay on polling reads to blur schedules. Cheap; the latency tradeoff is declared.

### 3.3 Gateway: HTTP(S) proxy

Policy per destination host, from the manifest:

| Rule | Meaning |
|---|---|
| `anon` | send via `worker.fetch` (Tor exit). Any HTTPS, not only RPC: anon-rpc's fetch is general. |
| `direct` | send normally (e.g. the LLM provider, latency-critical APIs). Declared, counted. |
| `block` | refuse. |
| *(undeclared)* | default: `block` if the request contains an agent address, else `direct` and reported as **undeclared**. Strict mode: block all undeclared. |

Without MITM, the proxy sees only the CONNECT host, so body rules can't apply; coverage says so ("not inspected: HTTPS bodies"). With the MITM CA flag, it sees everything.

### 3.4 `@canary/agent`: the in-process SDK (TypeScript)

```ts
import { createCanary } from "@canary/agent";

const canary = await createCanary({
  gateway: "http://127.0.0.1:8545",      // or { embedded: true } to run the gateway in-process
  agent: "trader-01.agents.canary.eth",  // ENSv2 name: policy is read from its manifest
  wallets: [account.address],            // the agent's addresses (or learned from signers)
});

// 1. viem / ethers: one line
const client = createPublicClient({ chain: mainnet, transport: canary.viemTransport() });
const provider = canary.ethersProvider();

// 2. everything else that uses fetch
globalThis.fetch = canary.fetch;          // or pass canary.fetch to SDKs that accept one

// 3. LLM calls: addresses never reach the provider
const llm = canary.wrapLLM(openaiClient);  // Anthropic, OpenAI, Vercel AI SDK adapters

// 4. or wrap a whole framework agent
const agent = canary.wrap(agentKitAgent);  // AgentKit / Eliza / LangChain adapters

canary.on("egress", (e) => log(e));        // every decision, live
const report = await canary.report();      // coverage + signed egress report
```

**Prompt pseudonymizer (`wrapLLM`):**
- Before a request leaves, every agent address (and any address it has seen on chain) is replaced with a stable alias: `0x5Ca1…FfEe` → `⟨wallet:1⟩`, `0xA0b8…eB48` → `⟨addr:7⟩`.
- On the response, aliases inside tool calls and text are mapped back before the agent acts.
- The mapping lives only in memory, per session.
- Contract addresses the model needs to reason about (e.g. "USDC") can be allow-listed to pass through.
- Coverage reports **"LLM provider: N addresses pseudonymized"**.

This is exact matching again (we know the addresses), not AI.

**Adapters, in order:** viem → ethers → global fetch → AgentKit → Vercel AI SDK → MCP client → Eliza → LangChain.js. Python agents use the Gateway (A–C) until there's a thin Python client.

### 3.5 Coverage and the egress report

The extension's categories (`Protected`, `Protected (IP only)`, `Blocked`, `Detected, unprotected`, `Backend / indexer`, `Not inspected`, `Failed closed`, `Direct`), plus:
- **`Pseudonymized`**: addresses replaced before reaching an LLM or tool;
- **`Undeclared`**: egress to a host not in the manifest.

Every N minutes (or on demand), the gateway builds an **egress report**:

```json
{ "agent": "trader-01.agents.canary.eth", "policyHash": "0x…", "gatewayVersion": "0.1.0",
  "window": [1793890000, 1793893600],
  "rpc": { "total": 1840, "protected": 1802, "ipOnly": 31, "direct": 7, "failedClosed": 0 },
  "http": { "anon": 120, "direct": 96, "blocked": 3, "undeclared": 0, "notInspected": 0 },
  "llm": { "requests": 210, "addressesPseudonymized": 388 },
  "latencyMs": { "p50": 1120, "p95": 2710 } }
```

The report is EIP-712-signed by a **report key** the gateway holds (not the agent's wallet key) and published at an evidence URI. Its hash goes in the agent's ENS record.

Wording rules from idea.md §4 apply: never "private" or "leak-free"; always "observed in this window, with these gaps".

---

## 4. ENSv2: agents as namespaces

| Record on `trader-01.agents.canary.eth` | Written by | Content |
|---|---|---|
| `privacy.manifest` | operator | the policy: per-host rules (`anon`/`direct`/`block`), RPC write mode, strict mode, latency tradeoffs |
| `privacy.report` | the gateway's report key (one-key EAC role) | hash + URI of the latest signed egress report |
| `privacy.verdict.<verifier>` | independent verifier (one-key EAC role) | verifier's signed opinion, as in idea.md §3.3 |
| `addr` | operator | the agent's wallet(s), or deliberately absent |

**Why this beats the dapp version:**
- **The manifest is enforced, not just compared.** The SDK loads its policy from the agent's own name and refuses anything outside it. Changing the policy is an onchain, versioned event.
- **One-key delegation fits naturally.** The operator grants the gateway's report key only `privacy.report`, and a verifier only its own key. That's the brief's own example: "letting an account edit only certain text records on a name".
- **Fleets are natural:**
  - `agents.canary.eth` as a subname registry (one subname per agent);
  - expiring or revocable subnames for short-lived agents;
  - a Permissioned Resolver per agent so each agent owns its data.
- **Revocation is visible.** An operator who silences reporting must revoke the role, which emits `EACRolesChanged`. Anyone reading the name sees "reporting revoked".

Optional: whether `addr` is set on the agent's name is itself a privacy choice. A public agent identity linked to its wallets defeats unlinkability, so the manifest can declare "wallets undisclosed".

---

## 5. Repo layout (monorepo)

```
packages/
  core/        ← extension/src/shared.ts, generalized (classifier, address matching, chain detection, categories, policy types)
  extension/   ← today's extension/, importing @canary/core
  gateway/     ← Node: JSON-RPC endpoint, HTTP(S) proxy, policy, ledger, reports, AnonBackend (chromium | node)
  agent/       ← @canary/agent: createCanary, viemTransport, ethersProvider, fetch, wrapLLM, adapters
  ens/         ← manifest/report schemas, EIP-712 signer, ENSv2 reader/writer (shared with the extension's verdicts)
examples/
  agentkit-trader/   ← a small agent: reads pool state, asks an LLM, swaps on Sepolia
  python-agent/      ← same idea via the Gateway only (RPC URL + HTTPS_PROXY)
```

---

## 6. Hackathon build plan (agent track, on top of what's done)

The extension is done. This replaces the scanner work in idea.md §6 if we choose to pivot (see §9).

| Hours | Gateway + backend | SDK | ENSv2 | Demo agent |
|---|---|---|---|---|
| 0–3 | **Spike:** headless Chromium boots browser-harness + tor-js; `backend.fetch` answers `eth_blockNumber` | move `shared.ts` → `@canary/core` | ENSv2 Sepolia name + subname for one agent | pick framework (AgentKit or plain viem + LLM) |
| 3–10 | JSON-RPC endpoint: substitute / forward / fail closed, isolation keys, caching | `viemTransport`, `fetch`, events | manifest schema → policy loader | agent loop: read → LLM → decide |
| 10–18 | HTTP proxy with host rules, undeclared detection | `wrapLLM` pseudonymizer (OpenAI/Anthropic shapes) | EAC one-key role for the report key; report writer | wire SDK in; a "leaky" mode for before/after |
| 18–26 | ledger, coverage, EIP-712 report | `canary.report()` | revocation detection | Sepolia swap via anon path |
| 26–32 | MITM CA flag (stretch) | ethers / AgentKit adapter (stretch) | verifier role (stretch) | Python agent via gateway only |
| 32–36 | demo, video, README (CROPS) | | | |

**Hour-3 checkpoint:**
- If the headless-Chromium backend won't boot tor-js, develop on passthrough and ask EF about a native path.
- If ENSv2 subnames block us, use a local policy file and go to ENS mentors.

**Cut order:** MITM CA → Python example → verifier role → ethers adapter → timing jitter.
**Never cut:** reads via anon-rpc by default, fail closed, prompt pseudonymization, manifest-as-policy, signed report.

---

## 7. Demo (3:00)

| Time | Beat |
|---|---|
| 0:00 | "Agents leak their strategy before they trade: every read goes to an RPC provider from one server IP, and every prompt hands the LLM provider your wallets." |
| 0:15 | Leaky run: the provider log shows the agent's wallet, the quote it's checking and the server IP. The LLM log shows raw addresses. |
| 0:40 | Same agent, one line changed (`transport: canary.viemTransport()`) plus `wrapLLM`. |
| 1:00 | Provider log: nothing. Read endpoint: Tor exits only. LLM log: `⟨wallet:1⟩`. The agent still trades (Sepolia tx link). |
| 1:30 | Python agent, zero code changes: just `RPC_URL` and `HTTPS_PROXY`. |
| 1:50 | ENS: `trader-01.agents.canary.eth`. The manifest is the policy: remove a host and the agent's call to it gets blocked live. The report key can write only `privacy.report`. |
| 2:30 | Coverage: "1,802/1,840 RPC calls via anon-rpc · 388 addresses pseudonymized · 0 undeclared · p50 +1.1 s". |
| 2:50 | "One core, two hosts: Canary for your browser, Canary for your agents." |

---

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Headless Chromium as the anon backend feels heavy | Medium | It's what works today; the interface swaps to node-harness when EF adds KPS + WASM there. Say so in the README. A single gateway serves many agents. |
| Tor latency (~1–3 s) hurts latency-sensitive agents | High for trading | Policy can mark hosts `direct` (declared, counted); cache and batch; be honest that this is for reads where linkage matters more than milliseconds. |
| LLM pseudonymization breaks the agent's reasoning | Medium | Stable aliases, an allow-list for well-known contracts, and restoring aliases in tool calls. Test on the demo agent's actual prompts. |
| MITM CA scares judges or users | Low | Off by default; operator-only; explain it's the same model as corporate egress proxies. |
| Proxy env vars ignored by some clients | Medium | Report it as "not inspected"; the in-process SDK covers TS agents fully. |
| EF demo gateway capacity with many agents | High | Ask EF about running our own KPS gateway (already in idea.md §12). |
| Scope: two hosts in 36 h | High | The extension is done. Treat this as the second host built on the same core, and cut the dapp scanner if needed (see §9). |

---

## 9. Decisions for the team

1. **Pivot or extend?**
   - *Extend:* Canary = extension + agent SDK, sharing a core; the scanner gets cut.
   - *Pivot:* lead with agents and keep the extension as proof the core works in browsers.

   My read: *extend, lead the pitch with agents*. The extension is already built; agents carry the ENS bonus and a stronger "new platform" story for EF.
2. **First framework:** plain viem + one LLM client (fastest, and every framework sits on these), or AgentKit (recognizable to judges)?
3. **Default for undeclared hosts:** `report` (friendlier) or `block` (stricter, better story)?
4. **LLM provider for the demo**, and whether the LLM call itself should go `anon` or `direct` (keyed either way).

## 10. Open questions for mentors

**EF:**
- Is there a native path for tor-js in Node (WASM in the QuickJS guest, or the proposed `socket` capability)?
- Is a headless-Chromium backend acceptable as "a new platform"?
- Is `isolationKey` honoured by tor-js (separate circuits)?
- Can we run our own KPS gateway?

**ENS:**
- Fastest path to a subname registry under one name on Sepolia, with a Permissioned Resolver per subname?
- Can a one-key text role be granted per subname rather than per resolver instance?
