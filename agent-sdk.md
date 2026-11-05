# Canary for Agents: SDK blueprint

**Wrap any autonomous agent so its chain reads go through anon-rpc, and its address doesn't leak to third parties without being declared.**

Draft v1.1 · 6 Nov 2026 · brainstorm first, then the blueprint. v1 applies the review findings listed under "Changes in v1"; v1.1 adds what has been built (§0) and where the build differs from the plan. Companion to [idea.md](idea.md) (the browser extension).

---

## TL;DR

- **Yes, we can build it, for any agent**, in two layers:
  1. **Canary Gateway** (any language, any framework): a local process the agent points its RPC URL and HTTP proxy at. Zero code changes for chain traffic; other HTTPS is direct/block per host unless the operator installs Canary's local CA.
  2. **`@canary/agent` SDK** (TypeScript first): wraps the agent in-process for the things a proxy can't see. That means request bodies over HTTPS, addresses inside LLM prompts, and per-wallet isolation.
- **The constraint that shapes everything:** anon-rpc's Node harness is a prototype. It isn't on npm (`@anon-rpc/node-harness` returns 404; `@anon-rpc/browser-harness` 0.4.0 is published) and ran only the passthrough worker in our tests. There's no WebAssembly in its sandbox, so **tor-js can't run natively in Node today**. Whether it supports KPS is unverified: ask EF. The browser harness can, and it is tested. So the Gateway hosts the browser harness in a headless Chromium it manages, and swaps to the Node harness when that matures. EF's brief lists "bring anon-rpc to a new platform" as a valid entry, so this is in scope, not a workaround.
- **Agents leak more than dapps.** Their reads reveal *strategy* before they act (quotes, allowances, positions). One server IP links a whole fleet of agent wallets. And LLM providers see addresses in every prompt.
- **ENSv2 fits better here than for dapps.** The ENS brief gives bonus points for "agents as namespaces, each with their own identity and permissions". Each agent gets a subname whose `privacy.manifest` **is** the policy the SDK enforces: declared = enforced, not just compared.
- **Reuse:** `extension/src/shared.ts` (JSON-RPC classifier, address matching, chain detection, coverage categories) is already platform-neutral. It becomes `@canary/core`, shared by the extension and the agent SDK.

### Changes in v1

- **The HTTPS proxy without the MITM CA is host-level only (direct or block).** It gets an encrypted tunnel, not a request, so it can't route through anon-rpc (§1, 3.3, demo 1:30).
- **Undeclared hosts: one rule,** `block` by default (3.3, §9).
- **Gateway ↔ Chromium bridge specified:** loopback WebSocket, streamed bodies, backpressure (3.1).
- **Batches touching several agent wallets are split per wallet**; one gateway path per chain (3.2).
- **Pseudonymizer:** ASCII aliases; covers ENS names and tx hashes; restores aliases across streamed chunks and before tool validation; balances are declared, not hidden (3.4).
- **The egress report is metadata too:** on chain it is coarse, and updated daily or on demand (3.5, §4).
- **Node harness facts checked** against test-repo.md and npm (TL;DR, 3.1, §10).
- **Gateway default port is 18545:** 8545 clashes with anvil and Hardhat.
- **§9 decisions proposed; staffing for 2–4 people** (§6).

---

## 0. Implementation status (6 Nov 2026)

Everything below is in `packages/` and `examples/`; each package README has the API and config reference. **Tests:** 62 pass (`npm test` at the repo root), on Linux and Windows, plus the extension's 24/24 now that it runs on `@canary/core`. They run against EF's passthrough reference worker (hash-verified as on chain), local fixtures, and a local chain with mock ENSv2 contracts.

**Live over tor-js (test-repo.md round 4):** works when EF's demo KPS gateway lets circuits through. On 5 Nov, 18/19 live checks passed (reads ~0.9 s once warm; the only fail was a 180 s boot limit). On 6 Nov, one run reached its first read at ~229 s, and another got nothing through in 10 min. The bottleneck is the demo gateway ("limited capacity"), not Canary, which failed closed throughout. Readiness is now reported as `path.serving` from call outcomes, because tor-js signals `ready` minutes before it can carry a call. **ENS on Sepolia is not yet run live.**

**Next:** run our own tor-js gateway (it's open source, in `ethereum/tor-js`) and repeat the live check: [own-gateway.md](own-gateway.md).

| Blueprint part | Where | Status |
|---|---|---|
| `@canary/core` (§5) | `packages/core` | done; the extension's `shared.ts` re-exports it |
| Chromium AnonBackend + loopback bridge (§3.1) | `packages/gateway/src/backend/` | done: streaming in ≤256 KB frames with backpressure, abort, crash and boot-failure relaunch with backoff |
| JSON-RPC endpoint (§3.2) | `packages/gateway/src/rpc.ts` | done: substitute / forward / local / refuse signing / fail closed; batches split per wallet; `eth_getCode` cache; write modes; timing jitter |
| HTTP(S) proxy (§3.3) | `packages/gateway/src/http.ts` | done: host rules, CONNECT direct/block, undeclared handling |
| MITM CA (option C) | `packages/gateway/src/mitm.ts` | done, opt-in: `canary-gateway ca`, per-host certs, passthrough list, bundle for Python/curl |
| SDK (§3.4) | `packages/agent` | done: `viemTransport`, `ethersProvider`, `fetch`, `llmFetch`/`wrapLLM`, `wrapTools`, events, report, embedded mode |
| Ledger, signed report, coarse form (§3.5) | `packages/gateway/src/ledger.ts`, `report.ts` | done |
| ENSv2: manifest as policy, report role, revocation (§4) | `packages/ens`, `packages/gateway/src/ens.ts` | done against mocks: policy read over anon-rpc and re-read live, signed `privacy.report` published over anon-rpc, revocation detected, `canary-ens` CLI |
| Demo agent with leaky mode, Python agent (§6, §7) | `examples/viem-agent`, `examples/python-agent` | done; Python tested end to end |
| AgentKit / Eliza / LangChain adapters, verifier role, Sepolia swap | — | not built |

**Where the build differs from the plan:**

1. **ENSv2 delegation API.** The ENS docs currently describe two ways to delegate one text key:
   - `authorizeTextRoles(name, key, account, grant)` in the Permissioned Resolver guide;
   - `grantSetterRoles(setterCalldata, account)` / `revokeRoles` in the contracts reference.

   `@canary/ens` tries both and uses the one the resolver accepts. It detects revocation by simulating `setText` from the report key, which doesn't depend on either API. Both variants are tested.
2. **`reporter` in the manifest.** The manifest declares the report key's address, so a reader can check that the report's signer is the declared reporter, and that the reporter still has the role.
3. **What `privacy.report` holds.** It holds the coarse report itself plus an EIP-712 signature over it, not only a hash and URI. Readers can verify it without fetching anything. `reportHash` commits to the full report, and `evidenceUri` is optional.
4. **One policy engine.** The SDK sends non-RPC requests through the gateway's `/canary/fetch`, so the policy is enforced in one place (with bodies visible), not re-implemented in the SDK.
5. **Precedence.** A local manifest overrides ENS when both are configured; ENS is then used for reports only. Until an ENS manifest loads, undeclared hosts are blocked (fail closed).
6. **Small API changes.** `ethersProvider(chainId)` is async (ethers is an optional dependency). Hashes become `HASH_n`. Raw SSE streams are not restored in place (see §3.4).
7. **Not built from §3:** coalescing of separate RPC requests (clients batch instead), the `roundAmounts` pseudonymizer option, and the framework-level `canary.wrap()` adapters.
8. **Sandboxes that set `HTTPS_PROXY`** need Chromium's `--no-proxy-server`, or Chrome sends the anon backend's traffic through that proxy. The test fixtures pass it.

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
| **A. Gateway as RPC URL** (`http://127.0.0.1:18545`) | chain reads/writes | ✅ | ✅ (it's the endpoint) | low |
| **B. Gateway as HTTP(S) proxy** (`HTTPS_PROXY=`) | all HTTP egress, **host-level only: direct or block** (can't route HTTPS via anon-rpc: it gets an encrypted tunnel, not a request) | ⚠️ partly: Python `requests`/`httpx` and curl honour proxy env vars; Node's built-in `fetch` ignores them by default (recent Node versions need `NODE_USE_ENV_PROXY=1`; check), which is one reason for D | ❌ host only, unless C | low |
| **C. Proxy + local MITM CA** (operator installs Canary's CA: `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`) | all HTTP egress, full bodies; **the only zero-code way to send non-RPC HTTPS via anon-rpc** | ✅ | ✅ | medium |
| **D. In-process SDK** (wrap `fetch`, viem transport, ethers provider, LLM client) | everything + prompt redaction + per-wallet isolation | ❌ TS only | ✅ | medium |
| **E. MCP gateway** (Canary as an MCP server that fronts other MCP servers) | tool calls of MCP-based agents | ✅ | ✅ tool args | medium |
| F. Framework plugins (Eliza plugin, AgentKit action provider) | one framework each | ❌ | ✅ | high × N |

**Decision:** A + D are the core. B ships as host-level direct/block plus reporting. C is a flag, off by default; without it, non-TS agents get anon-rpc for chain traffic only (A). E is a stretch goal; F never (adapters on top of D instead).

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
│   ├─ JSON-RPC endpoint :18545 ─ classify → substitute / forward / fail closed     │
│   ├─ HTTP(S) proxy :8080      ─ policy per destination: anon | direct | block     │
│   │    (anon + body rules need the MITM CA; otherwise direct | block)             │
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
| `node` | passthrough only | prototype, not on npm (404 on 5 Nov) | QuickJS isolate. No WebAssembly in the guest, so no tor-js yet. A bridged `socket` capability already exists in the prototype (test-repo.md §2: it carried a real connection), which a native tor-js could use later. KPS support: unverified, ask EF. |
| `native` (future) | — | — | Whatever EF ships next; the interface stays the same. |

**Gateway ↔ Chromium bridge.** Not Playwright's `evaluate`/`exposeBinding`, which serialize whole values and can't stream.
- The local page opens a WebSocket to the gateway on loopback (random port, one-time token in the URL).
- Request frames: `{id, url, method, headers}`, then body chunks. Response frames: a head frame (status, headers), then body chunks, with backpressure.
- Bodies already stream inside the harness; this keeps them streaming end to end, so large `eth_getLogs` responses are fine.
- Abort frames map to an `AbortController` (the harness handles aborted fetches, test-repo.md §3).
- If Chromium crashes, the gateway fails closed, relaunches it and re-boots the worker (~13 s cold); status shows `warming`.
- **Passthrough during development:** the passthrough worker uses the page's own `fetch`, so CORS applies and many non-RPC APIs will fail. Launch the dev Chromium with `--disable-web-security` (passthrough only, never with tor-js), or test the proxy against CORS-enabled servers.

Each `isolationKey` is passed through untouched (tested across the harness hops); whether tor-js gives each key its own circuit is a question for EF.

### 3.2 Gateway: JSON-RPC endpoint

The same policy as the extension, from `@canary/core`:

- **Standard read methods → substituted:** answered by Canary's read endpoint for that chain, via anon-rpc.
- **Other methods → forwarded** to the upstream the operator configured, via anon-rpc (IP only).
- **`eth_sendRawTransaction` → configurable:**
  - `anon` (default): via anon-rpc to a public RPC, so the IP is hidden;
  - `private`: to a private relay over the anon path;
  - `direct`: declared in the manifest, counted as Direct.
- **Batching and caching:** `eth_chainId` is answered locally and `eth_getCode` cached (built). Coalescing separate requests that arrive within a few ms is **not built**: use the client's own batching (`canary.viemTransport({ batch: true })`), which the gateway splits per wallet.
- **Per-wallet isolation:** `isolationKey = "addr:<address>"` for every request that contains one of the agent's addresses. Two wallets of the same operator should not look linked at the exit.
  - A JSON-RPC batch touching more than one agent address is split per address and reassembled in order.
  - A single call that contains two agent addresses (e.g. one Multicall `eth_call`) can't be split. It goes with the first address's key, and the report notes it as linking wallets. The SDK's viem transport can avoid this by not batching Multicalls across wallets.
- **Chains:** one path per chain, `http://127.0.0.1:18545/<chainId>`. The operator maps each chain to a read endpoint and an upstream; no guessing from URLs, unlike the extension.
- **Timing jitter (option):** random delay on polling reads to blur schedules. Cheap; the latency tradeoff is declared.

### 3.3 Gateway: HTTP(S) proxy

Policy per destination host, from the manifest:

| Rule | Meaning |
|---|---|
| `anon` | send via `worker.fetch` (Tor exit). Plain HTTP, or HTTPS **with the MITM CA only**. Without the CA there's no request to hand to `worker.fetch`, so an `anon` HTTPS host is **blocked** (fail closed) and the report says why. (anon-rpc's fetch is general, but we've only tested RPC endpoints over tor-js so far.) |
| `direct` | send normally (e.g. the LLM provider, latency-critical APIs). Declared, counted. |
| `block` | refuse. |
| *(undeclared)* | **`block` by default** (§9). `report` mode (send directly, count as **Undeclared**) is an opt-in for development. With the MITM CA, the default can be relaxed to "block only if the request contains an agent address"; without it, bodies can't be checked, so that rule isn't available. |

Without MITM, the proxy sees only the CONNECT host: rules are per host, `direct` or `block`, and coverage says "not inspected: HTTPS bodies". Agents that need non-RPC HTTPS via anon-rpc use the in-process SDK (D) or the MITM CA (C). With the CA flag, the proxy sees everything.

Many APIs (Cloudflare-fronted ones, some LLM providers) refuse or challenge Tor exits, as Tenderly did (test-repo.md §5). Test every host over tor-js before declaring it `anon`.

### 3.4 `@canary/agent`: the in-process SDK (TypeScript)

```ts
import { createCanary } from "@canary/agent";

const canary = await createCanary({
  gateway: "http://127.0.0.1:18545",      // or embedded: <gateway config> to run the gateway in-process
  wallets: [account.address],            // the agent's addresses
});                                       // the policy comes from the gateway (its manifest, local or from the agent's ENS name)

// 1. viem / ethers: one line
const client = createPublicClient({ chain: mainnet, transport: canary.viemTransport() });
const provider = await canary.ethersProvider(1);

// 2. everything else that uses fetch
globalThis.fetch = canary.fetch;          // or pass canary.fetch to SDKs that accept one
                                          // (canary.fetch keeps the original fetch; wrapLLM's calls are tagged so they aren't handled twice)

// 3. LLM calls: addresses never reach the provider
const llm = canary.wrapLLM(openaiClient);  // any client with a fetch: OpenAI, Anthropic SDKs; Vercel AI SDK: createOpenAI({ fetch: canary.llmFetch })

// 4. tool calls: real addresses back before a tool runs
const safeTools = canary.wrapTools(tools);

// (planned, not built: canary.wrap(agentKitAgent) for AgentKit / Eliza / LangChain)

canary.on("egress", (e) => log(e));        // every decision, live
const report = await canary.report();      // coverage + signed egress report
```

**Prompt pseudonymizer (`wrapLLM`):**
- Before a request leaves, every agent address (and any address it has seen on chain) is replaced with a stable ASCII alias: `0x5Ca1…FfEe` → `WALLET_1`, another counterparty → `ADDR_7`. (Not `⟨wallet:1⟩`: models often mangle unusual brackets.)
- Also replaced: the agent's own ENS name(s) → `AGENT_NAME`, and 32-byte hashes (mostly the agent's own transaction hashes) → `HASH_3`.
- Not replaced (a documented gap): amounts and balances, and addresses inside longer hex blobs such as calldata. An exact balance can identify a wallet; a `roundAmounts` option is planned, not built, and would be off by default because it changes what the model reasons about.
- Well-known contracts the model needs to reason about (USDC, WETH, the Uniswap routers) are allow-listed and pass through unchanged.
- On the response, aliases in text and tool calls are mapped back before the agent acts:
  - text-delta streams go through `restoreTextStream()`, which holds back a partial alias split across chunks. Raw SSE/JSON streams can't be restored in place (an alias can be split across events), so for streamed responses tool arguments are restored by `wrapTools()` and the final text by `restore()`;
  - tool-call arguments are restored before the framework validates them (tool schemas often regex-check `0x` addresses);
  - an alias with no mapping (the model invented `WALLET_9`) fails the tool call; it is never guessed.
- The mapping lives only in memory, per session.
- Coverage reports **"LLM provider: N addresses pseudonymized"**.

This is exact matching again (we know the addresses), not AI.

**Adapters, in order:** viem → ethers → global fetch → AgentKit → Vercel AI SDK → MCP client → Eliza → LangChain.js. Python agents use the Gateway (A–C) until there's a thin Python client.

### 3.5 Coverage and the egress report

The extension's categories (`Protected`, `Protected (IP only)`, `Blocked`, `Detected, unprotected`, `Backend / indexer`, `Not inspected`, `Failed closed`, `Direct`), plus:
- **`Pseudonymized`**: addresses replaced before reaching an LLM or tool;
- **`Undeclared`**: egress to a host not in the manifest.

On demand (`GET /canary/report`), and when it publishes (daily by default, or `POST /canary/publish`), the gateway builds an **egress report**:

```json
{ "agent": "trader-01.agents.canary.eth", "policyHash": "0x…", "gatewayVersion": "0.1.0",
  "window": [1793890000, 1793893600],
  "rpc": { "total": 1840, "protected": 1802, "ipOnly": 31, "direct": 7, "failedClosed": 0 },
  "http": { "anon": 120, "direct": 96, "blocked": 3, "undeclared": 0, "notInspected": 0 },
  "llm": { "requests": 210, "addressesPseudonymized": 388 },
  "latencyMs": { "p50": 1120, "p95": 2710 } }
```

The report is EIP-712-signed by a **report key** the gateway holds (not the agent's wallet key) and published at an evidence URI. Its hash goes in the agent's ENS record.

**The report is metadata too.** Hourly counts and timing would tell anyone reading the agent's name when and how much it works: the very pattern we hide from RPC providers. So:
- the full report stays with the operator (at the evidence URI, access-controlled or published later);
- the on-chain `privacy.report` record is updated on demand or at most daily, with windows aligned to whole days and counts as coarse buckets and percentages;
- the record update is a transaction from the report key: send it through the gateway's anon path, and fund the report key without linking it to the agent's wallets.

Wording rules from idea.md §4 apply: never "private" or "leak-free"; always "observed in this window, with these gaps".

---

## 4. ENSv2: agents as namespaces

| Record on `trader-01.agents.canary.eth` | Written by | Content |
|---|---|---|
| `privacy.manifest` | operator | the policy: per-host rules (`anon`/`direct`/`block`), undeclared handling, RPC write mode, the `reporter` address (schema: `packages/core/README.md`) |
| `privacy.report` | the gateway's report key (one-key EAC role) | the coarse report plus its EIP-712 signature, with `reportHash` committing to the full report (daily or on demand; see 3.5 and `packages/ens/README.md`) |
| `privacy.verdict.<verifier>` | independent verifier (one-key EAC role) | verifier's signed opinion, as in idea.md §3.3 |
| `addr` | operator | the agent's wallet(s), or deliberately absent |

**Why this beats the dapp version:**
- **The manifest is enforced, not just compared.** The gateway loads its policy from the agent's own name (over anon-rpc), re-reads it, and refuses anything outside it. Changing the policy is an onchain, versioned event, and it applies live.
- **One-key delegation fits naturally.** The operator grants the gateway's report key only `privacy.report`, and a verifier only its own key. That's the brief's own example: "letting an account edit only certain text records on a name".
- **Fleets are natural:**
  - `agents.canary.eth` as a subname registry (one subname per agent);
  - expiring or revocable subnames for short-lived agents;
  - a Permissioned Resolver per agent so each agent owns its data. A text-key grant covers that key on every name served by the same resolver instance (idea.md §3.3), so with a shared resolver one gateway's report key could write every agent's `privacy.report`. If a fleet shares a resolver, it shares one report key, and the manifest says so.
- **Revocation is visible.** An operator who silences reporting must revoke the role, which emits `EACRolesChanged`. Anyone reading the name sees "reporting revoked".

Optional: whether `addr` is set on the agent's name is itself a privacy choice. A public agent identity linked to its wallets defeats unlinkability, so the manifest can declare "wallets undisclosed".

---

## 5. Repo layout (monorepo)

As built (npm workspaces at the repo root):

```
packages/
  core/        ← @canary/core: classifier, address matching, chain detection, categories, manifest
  ens/         ← @canary/ens: manifest/report records, coarse-report signing, one-key role, revocation, canary-ens CLI
  gateway/     ← @canary/gateway: AnonBackend (chromium), JSON-RPC endpoint, HTTP(S) proxy, MITM CA, ledger, reports, ENS binding, canary-gateway CLI
  agent/       ← @canary/agent: createCanary, viemTransport, ethersProvider, fetch, llmFetch/wrapLLM, wrapTools
extension/     ← unchanged location; src/shared.ts re-exports @canary/core (bundled by esbuild)
examples/
  viem-agent/    ← Sepolia agent: reads balances, asks an LLM; --leaky for the before/after; local or ENS policy
  python-agent/  ← same idea via the gateway only (RPC_URL + HTTPS_PROXY), standard library
```

---

## 6. Hackathon build plan (agent track, on top of what's done)

The extension is done. This replaces the scanner work in idea.md §6 if we choose to pivot (see §9).

**Progress (6 Nov):** every cell below is built and tested (§0) except these:
- live tor-js and ENS Sepolia runs (hour-3 checkpoints);
- the Sepolia swap;
- the AgentKit adapter;
- the verifier role.

| Hours | Gateway + backend | SDK | ENSv2 | Demo agent |
|---|---|---|---|---|
| 0–3 | **Spike:** headless Chromium boots browser-harness + tor-js; `backend.fetch` answers `eth_blockNumber` over the loopback WebSocket bridge, and a large `eth_getLogs` streams through it | move `shared.ts` → `@canary/core` | ENSv2 Sepolia name + subname for one agent | plain viem + one LLM client (§9) |
| 3–10 | JSON-RPC endpoint: substitute / forward / fail closed, isolation keys, caching | `viemTransport`, `fetch`, events | manifest schema → policy loader | agent loop: read → LLM → decide |
| 10–18 | HTTP proxy with host rules, undeclared detection | `wrapLLM` pseudonymizer (OpenAI/Anthropic shapes) | EAC one-key role for the report key; report writer | wire SDK in; a "leaky" mode for before/after |
| 18–26 | ledger, coverage, EIP-712 report | `canary.report()` | revocation detection | Sepolia swap via anon path |
| 26–32 | MITM CA flag (stretch; only needed for anon non-RPC HTTPS from non-TS agents) | ethers / AgentKit adapter (stretch) | verifier role (stretch) | Python agent via gateway only |
| 32–36 | demo, video, README (CROPS) | | | |

**Before hour 0:** confirm the §9 decisions.

**Staffing:** the four columns assume four people.
- Three: one person takes ENS and the demo agent.
- Two: person 1 = gateway + backend; person 2 = SDK + demo agent. ENS shrinks to manifest-as-policy and the report key; the verifier role is cut.

**Hour-3 checkpoint:**
- If the headless-Chromium backend won't boot tor-js, develop on passthrough and ask EF about a native path.
- If ENSv2 subnames block us, use a local policy file and go to ENS mentors.
- If the bridge can't stream yet, buffer whole responses with a size cap and limit `eth_getLogs` ranges; fix streaming later.

**Cut order:** MITM CA → Python example → verifier role → ethers adapter → timing jitter. If the MITM CA is cut, the Python example still gets anon-rpc for chain traffic (`RPC_URL`); its other HTTPS is direct/block per host.
**Never cut:** reads via anon-rpc by default, fail closed, prompt pseudonymization, manifest-as-policy, signed report.

---

## 7. Demo (3:00)

| Time | Beat |
|---|---|
| 0:00 | "Agents leak their strategy before they trade: every read goes to an RPC provider from one server IP, and every prompt hands the LLM provider your wallets." |
| 0:15 | Leaky run: the provider log shows the agent's wallet, the quote it's checking and the server IP. The LLM log shows raw addresses. |
| 0:40 | Same agent, one line changed (`transport: canary.viemTransport()`) plus `wrapLLM`. |
| 1:00 | Provider log: nothing. Read endpoint: Tor exits only. LLM log: `WALLET_1`. The agent still trades (Sepolia tx link). |
| 1:30 | Python agent, zero code changes: `RPC_URL` points at the gateway, so its chain reads go via anon-rpc. `HTTPS_PROXY` enforces host rules: an undeclared host is blocked live. (Its other HTTPS goes via anon-rpc only with the MITM CA; say so.) |
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
| Gateway ↔ Chromium bridge doesn't stream, or drops under load | Medium | Loopback WebSocket with chunked bodies and backpressure (3.1); spike it at hour 0; fallback: buffered responses with a size cap. |
| APIs refuse Tor exits (as Tenderly did, test-repo.md §5) | Medium | Test every `anon` host over tor-js before declaring it; declare the rest `direct`. |
| The egress report itself reveals the agent's activity | Medium | The full report stays with the operator; the on-chain record is coarse and updated daily or on demand (3.5). |
| Port clash with anvil/Hardhat on 8545 | Low | Gateway defaults to 18545, configurable. |

---

## 9. Decisions (proposed in v1; confirm at kickoff, before hour 0)

1. **Extend, and lead the pitch with agents.** Canary = extension + agent SDK on one core; the dapp scanner is cut. The extension is already built; agents carry the ENS bonus and a stronger "new platform" story for EF. (Pivoting stays possible: the extension then becomes proof that the core works in browsers.)
2. **First framework: plain viem + one LLM client.** It's the fastest path, every framework sits on these, and the AgentKit adapter would wrap them anyway. AgentKit becomes a stretch adapter.
3. **Undeclared hosts: `block` by default.** It's the only rule the proxy can enforce without the MITM CA (3.3), and the stronger story: the manifest *is* the policy. `report` is an opt-in for development.
4. **LLM calls go `direct`, declared, through `wrapLLM`.** The provider knows who pays from the API key anyway, many providers challenge Tor exits, and Tor adds 1–3 s per call. What we hide is wallet addresses, not the account. The demo provider is still open: pick the one the team has credits for, and test `wrapLLM` on its tool-call format first.

## 10. Open questions for mentors

**EF:**
- Is there a native path for tor-js in Node (WASM in the QuickJS guest, or tor-js over the node harness's existing `socket` capability)? Does the node harness implement KPS, and when will it be on npm?
- Is a headless-Chromium backend acceptable as "a new platform"?
- Is `isolationKey` honoured by tor-js (separate circuits)?
- Can we run our own KPS gateway? The demo one (`152.236.3.22:12298`) is the bottleneck in our live runs: fast bootstrap always failed, and boot to first circuit took ~4 min in a good run and never finished in a bad one (test-repo.md §15). Is it shared and rate-limited?

**ENS:**
- Which one-key delegation API is deployed on Sepolia: `authorizeTextRoles(name, key, account, grant)` or `grantSetterRoles(setter, account)` / `revokeRoles`? (`@canary/ens` handles both; we want to demo the live one.) Which Universal Resolver address should clients use?
- Fastest path to a subname registry under one name on Sepolia, with a Permissioned Resolver per subname?
- Can a one-key text role be granted per subname rather than per resolver instance?
