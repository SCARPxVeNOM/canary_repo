# Canary

**See what a dapp leaks before you connect, and stop it once you do. No dapp fork required.**

ETHGlobal Mumbai 2026 · team working doc · v2 · 5 Nov 2026 (updated after the repo tests in [test-repo.md](test-repo.md))

---

## TL;DR

- **What we're building:** a browser extension and a scanner that:
  1. route a dapp's own RPC reads through the Ethereum Foundation's **anon-rpc** by default
  2. block third-party requests that carry your wallet address
  3. compare what the dapp **declares** in its **ENSv2** name with what it **actually sends**
  4. report measured **coverage**, including what Canary could not inspect
- **Primary track:** EF, Best Use of Anon-RPC.
- **Secondary track:** ENS, Best Use of ENSv2.
- **Stretch goal (only with 3+ people):** Uniswap, Build with Uniswap (a private-quote page).
- **Our edge:** no fork + declared vs observed + enforcement + measured coverage. Each piece exists somewhere already; nobody has built the full loop.
- **Status (5 Nov, evening):** the core mechanism works. The spike in `canary-spike/` ran live over tor-js on the unmodified **app.ens.domains**: 8/8 of its RPC batches to its own keyed provider were answered via anon-rpc instead, and the page still worked (1.3–2.8 s per batch). Details: test-repo.md §10.
- **Part 1 (enforcement extension) is built:** `extension/`. It covers fetch, XHR, WebSocket and sendBeacon, blocks third-party requests carrying your address, fails closed, and has a coverage popup. It also reads the dapp's ENSv2 manifest and verifier's verdict over anon-rpc and shows declared vs observed (6 Nov). Its end-to-end test passes 32/32 (`extension/README.md`).
- **Canary for agents is built too (6 Nov):** gateway, SDK, ENSv2 records and two example agents in `packages/` and `examples/`, sharing `@canary/core` with the extension. 61 tests pass on the passthrough worker and mock ENSv2 contracts; not yet run live over tor-js or on ENS's Sepolia deployment. Status and differences from the plan: agent-sdk.md §0.
- **ENSv2 is live on Sepolia (6 Nov):** `leakydash.eth` has its own Permissioned Resolver, `url` and `privacy.manifest` records, and a one-key `grantSetterRoles` grant to the verifier. `canary.eth` has a UserRegistry as its subregistry, holding `verifier.canary.eth`, whose key signed and published a verdict from a real LeakyDash baseline scan (`undeclared`: the tracker). Revoking the verifier's role shows in `canary-ens read-dapp` and in the extension's reader. Names and transactions: `packages/ens/README.md` (*Live on Sepolia*).
- **Biggest remaining risk:** the live demo. LeakyDash runs locally, and its name's `url` is `http://leakydash.localhost:3000`; a deployed LeakyDash (the live demo link, real IPs in the logs) needs `canary-ens set-dapp` with its origin and a new scan. Then real-dapp scans, and the agents' names on Sepolia.
- **Before hacking starts:** take the open questions in section 12 to the EF and ENS mentors (EF's anon-rpc workshop was 5:00 PM IST, Thu 5 Nov, Workshop Room 2).

### 30-second pitch

> Ethereum now has anonymous RPC. But the leak doesn't happen in your wallet; it happens in the dapp. The dapp sends your address to its own RPC provider and to analytics, straight from your IP. Canary fixes that for any dapp without a fork. It sends reads through anon-rpc, blocks third-party leaks, checks what the dapp declared in ENS against what it actually does, and shows you exactly what it couldn't protect.

---

## 1. Problem

1. **Dapps bypass wallet privacy.** Dapps built on wagmi/viem typically send reads (`eth_call`, `balanceOf(you)`, allowances, positions) from your browser straight to *their* RPC provider, usually with *their* API key in the URL. The provider sees your IP, your address and which dapp you're using. Your wallet's RPC settings never touch this traffic.
2. **Analytics and backends get the address too.** A USENIX Security 2023 study found 211 of 616 dapps leaking users' wallet addresses to third parties, including RPC providers and analytics platforms. A PoPETs 2026 study shows that routine RPC calls alone can link a user's addresses to each other.
3. **anon-rpc only protects apps that integrate it, and only when users opt in.** EF's anon-rpc (spec 0.4.0) runs a hash-pinned anonymizing client in a sandbox and hands the host an anonymized `fetch`. One example client is a full Tor client compiled to WebAssembly. Two apps (Kiwi News, Privacy Pools) offer it as an opt-in setting; **no wallet ships it, nothing is on by default, and nothing works on dapps that didn't integrate it.** anon-rpc also only protects traffic the host routes through it, so dapp-side traffic still gets out.
4. **Self-declared privacy labels don't hold up.** Apple's App Store labels are not verified by Apple. A PoPETs 2022 study planted fake "honey data" and caught at least 276 apps violating their own labels. Dapps don't have labels at all.

### Threat model (say this out loud in the demo)

- **We protect against third parties** (RPC providers, analytics, telemetry) linking your wallet identity (address) with your network identity (IP, device).
- **We do not protect against the dapp itself.** It served you the page and you gave it your address. The UI says so on every site.
- **We do not handle your wallet's own traffic or transaction broadcast.** That's the wallet's job.

---

## 2. Product: four moves

| Move | What Canary does | Who it's for |
|---|---|---|
| **Declare** | The dapp publishes a privacy manifest in its ENSv2 name: every party that receives the connected address, and why | ENS track |
| **Observe** | A scanner loads the dapp with a fake wallet holding a fresh *canary* address and records every request carrying it | Proof for the other three moves |
| **Enforce** | The extension answers the page's RPC reads through anon-rpc and blocks third-party requests carrying your address | EF track |
| **Measure** | A coverage report: protected, blocked, left exposed, not inspected | EF's "share of traffic" judging criterion |

---

## 3. Architecture

```
┌──────────────────────────── user's browser ────────────────────────────┐
│ dapp page JS                                                            │
│   │ fetch / XHR / WebSocket / sendBeacon                                │
│   ▼                                                                     │
│ MAIN-world shim (document_start, all frames)                            │
│   classify: JSON-RPC? carries your address? first or third party?       │
│   │                                                                     │
│   ▼ postMessage → content script → extension service worker (policy)    │
│                                         │                               │
│                     offscreen document: anon-rpc harness                │
│                     └ null-origin sandbox → Tor worker (WASM)           │
│ declarativeNetRequest: block 3P URLs containing your address            │
└───────────────────────────────────────────┬─────────────────────────────┘
                                            │ KPS over WebRTC
                         Tor gateway → Tor network → read endpoint (RPC)

ENSv2 (Sepolia): dapp's manifest + verifier's signed verdict ← read via anon-rpc

Scanner:
Playwright Chromium (with or without Canary) ──proxy──► mitmproxy (ground truth)
  fake EIP-6963 wallet = canary address                    │
                                       matcher → report + coverage + build hash
                                       → EIP-712-signed verdict → ENSv2 text record
```

### 3.1 Extension: enforcement (Person A)

- **Start from our spike** (`canary-spike/`, built on `@anon-rpc/browser-extension-harness`; EF's `impl/demo-extension` is the reference). It already has the MAIN-world fetch shim, the bridge, substitution, IP-only forwarding, fail-closed, batch support and stats, plus an offline e2e (8/8). The service worker owns the harness, an offscreen document holds the null-origin sandbox, and the worker stays verified and warm.
- **Page ↔ extension channel:** replace the spike's `window.postMessage` (the page can read and spoof it) with a `MessageChannel` handed to the shim at `document_start`.
- **Shim:** a MAIN-world content script at `document_start`, in all frames. It wraps `fetch`, `XMLHttpRequest`, `WebSocket.prototype.send` and `navigator.sendBeacon`.
- **Classifier (deterministic, no AI):**
  - JSON-RPC = the body has `jsonrpc` and `method` (handle batch arrays).
  - Tainted = the request contains one of *your* addresses in any encoding we check (see 3.2). We know the exact address, so this is exact matching.
  - First party = same registrable domain as the page; otherwise third party (categorize with a tracker domain list).
- **Substitute, don't forward.** Canary answers standard read methods with `worker.fetch(READ_ENDPOINT, …)`, so the dapp's keyed provider never sees the request. **Chain of an RPC URL, in order:** (1) well-known providers whose URLs name the chain (Alchemy, Infura, dRPC, publicnode, …); (2) one cached `eth_chainId` probe over the anon path; (3) only if the probe fails (e.g. the provider refuses Tor exits, as Tenderly does), the wallet's chain, labelled "assumed" in the popup. Not the wallet first: dapps often read chains other than the wallet's (app.ens.domains reads mainnet whatever the wallet is on), so a wallet-first rule would return the wrong chain's data.
  - Methods we can substitute: `eth_call, eth_getBalance, eth_blockNumber, eth_chainId, eth_getCode, eth_getStorageAt, eth_getTransactionCount, eth_estimateGas, eth_gasPrice, eth_feeHistory, eth_maxPriorityFeePerGas, eth_getBlockByNumber, eth_getTransactionReceipt, eth_getTransactionByHash, eth_getLogs (bounded), net_version`.
  - Methods we can't substitute (`alchemy_*`, `debug_*`, `trace_*`, custom ones) are forwarded to the original URL via anon-rpc. That hides your IP, but the provider still learns which dapp you use. Label: **Protected (IP only)**.
- **Blocking:** Canary blocks third-party requests carrying your address. The shim catches request bodies; `declarativeNetRequest` dynamic regex rules catch URLs, including tracking pixels.
- **First-party requests carrying your address** are allowed and labeled **Detected, unprotected**, because blocking them breaks the app.
- **Per-address `isolationKey`** on `worker.fetch`, if the network supports it, so the read endpoint can't link your addresses to each other.
- **Fail closed** for tainted reads when the anon path is down (return a JSON-RPC error). Add a per-site "allow direct" toggle that's clearly labeled.
- **Canary's own ENS lookups go through anon-rpc.** Otherwise the lookup itself reveals which dapp you're visiting.
- **Popup:** declared vs observed, verdict status, live coverage counters, and the line saying the dapp itself sees your address and IP.

### 3.2 Scanner: observation and proof (Person B)

- Playwright `launchPersistentContext` (Chromium). For "after" runs, load Canary with `--load-extension`.
- **Ground truth = mitmproxy.** Route the browser through it (`ignoreHTTPSErrors`, `--disable-quic`) so we see every HTTP(S) request from pages, iframes, workers and the extension. Capture WebSocket frames via CDP. anon-rpc traffic leaves over WebRTC, so anything mitmproxy sees is, by definition, unprotected.
- **Fake wallet** via `addInitScript`, using EIP-6963 announce plus `window.ethereum`. It returns a fresh random canary address, auto-approves `eth_requestAccounts`, rejects signing and sends, and forwards other reads to an RPC on the scanner side.
- **Matcher** looks for the canary as: lowercase, checksummed, without `0x`, 32-byte ABI-padded, URL-encoded, base64 of each, and keccak256 and sha256 of each.
- **Flows:** load → connect → a few scripted page visits per site (keep the scripts short).
- **Output:** a recipients table (destination, category, encoding, first or third party, declared?), coverage %, build fingerprint and scanner version hash.
- **Two runs per site:** without Canary (baseline) and with Canary (what's left). That gives the before/after table.
- The evidence is safe to publish because the identity is synthetic.

### 3.3 ENSv2 manifest and verdicts (Person C)

**Records on the dapp's ENSv2 name** (Sepolia), served by its Permissioned Resolver:

| Text key | Written by | Content |
|---|---|---|
| `url` | dapp | origin, e.g. `https://leakydash.xyz` |
| `privacy.manifest` | dapp | compact JSON: `[{host, kind: rpc\|analytics\|backend, purpose}]` plus RPC policy |
| `privacy.verdict.canary` | **verifier only** (delegated) | EIP-712-signed verdict (below) |

- **Origin binding, in both directions:** the site serves `/.well-known/canary.json` → `{"ens":"leakydash.eth"}`, and the name's `url` record points back to the origin.
- **Delegation:** the dapp calls `authorizeTextRoles(name, "privacy.verdict.canary", verifier, true)`. The verifier can then write that one text key and nothing else.
  - ⚠️ Per the ENSv2 docs, a text-key grant covers that key on every name served by the same Permissioned Resolver instance. That's fine for us, since the verifier can only ever write `privacy.verdict.canary`. If it matters, keep the dapp's name on its own resolver instance.
- **Verdict (EIP-712):** `{name, origin, buildHash, scannerHash, flows, result: matches|undeclared|incomplete, undeclaredHosts, notInspected, issuedAt, expiresAt, evidenceURI}` plus a signature. Keep it small; the full evidence lives at `evidenceURI`.
- **Extension checks, in order:**
  1. The signature recovers to the verifier's ENS `addr`.
  2. The verifier role is still granted (if not, warn).
  3. `buildHash` matches the page you're on (if not, mark it "stale").
  4. The verdict hasn't expired.
  5. Declared vs observed.

**Why ENSv2 is load-bearing, not cosmetic** (our answer to "a manifest in ENS isn't enough"):

1. **Authorization (Enhanced Access Control, EAC):** the verifier can publish bad news without the dapp's help, but can't touch the manifest, addresses or contenthash.
2. **Authenticity (signatures):** the owner keeps admin roles, so it could re-grant itself the key and overwrite the verdict. EAC alone isn't security. Verdicts are signed, and we say this in the README.
3. **Accountability (onchain events):** the only way a dapp can silence its verifier is to revoke the role, which emits `EACRolesChanged`. Canary then shows "independent verification revoked". Manifest edits are also onchain and versioned.
4. **Multiple verifiers:** any number of independent verifiers, each with its own narrowly delegated key.
- Optional, if time allows: an expiring subname per verified build.

### 3.4 Demo dapp: "LeakyDash" (Person C or D)

A small wagmi token dashboard on Sepolia that we control, written the way many real dapps are:

- wagmi `http()` transport → **our observer RPC**, which logs the source IP and params, then forwards to a real Sepolia RPC. It stands in for "the dapp's RPC provider".
- An "analytics" beacon → **our tracker server**, sending `{event:"connect", address}`. It stands in for a real analytics SDK.
- A first-party call: `/api/points?address=…`.
- An ENSv2 name whose manifest declares the RPC provider but **not** the tracker.
- A log viewer with three panes: provider, tracker, and our anon read endpoint (which shows Tor exit IPs).
- A **native mode** toggle in which LeakyDash itself routes 100% of its reads through anon-rpc. This is our fallback in case a retrofit doesn't count as "your app" for the EF track.
- *Uniswap stretch goal:* a quote widget that calls the v4 Quoter via `eth_call` ("private quote": no API learns who is about to trade), plus one real Sepolia swap through the Universal Router for transaction IDs. Check contract addresses in the Uniswap docs.

---

## 4. Coverage model and rules for claims

| Category | Meaning | Example |
|---|---|---|
| **Protected** | Answered via anon-rpc; the dapp's provider never saw it | `eth_call balanceOf(you)` |
| **Protected (IP only)** | Forwarded via anon-rpc to the original URL; the provider learns the dapp but not your IP | `alchemy_getTokenBalances` |
| **Blocked** | A third-party request carrying your address | analytics beacon |
| **Detected, unprotected** | First-party or unsupported traffic carrying your address | `/api/points?address=` |
| **Backend / indexer** | Non-RPC API calls (REST, GraphQL) the dapp makes. Listed by destination; if one carries your address it is also counted as Blocked (third party) or Detected, unprotected (first party) | `api.bigname.sh` name records on app.ens.domains |
| **Not inspected** | Channels the extension can't see | service workers, WebRTC, compressed or encrypted bodies |

**Rules for everything we say, write or show:**

- Never say "leak-free", "private", "safe" or "verified private".
- Say instead: "No undeclared recipients observed in 6 flows on build 3f2a… at 14:20 IST. Not inspected: service workers, WebRTC."
- "No leak observed" is not "no leak". The matcher detects the encodings listed in 3.2. Arbitrary obfuscation or encryption is out of scope and lands in **Not inspected**.
- Coverage % = Protected RPC reads ÷ all RPC reads (the shim's count plus direct RPC requests seen by mitmproxy). Report it alongside the latency overhead (p50/p95).
- Also report the **share of all dapp requests** by category, including Backend / indexer. EF judges "how much of the app's traffic goes through Anon-RPC", and real dapps lean on indexer APIs as much as on RPC.
- Measured so far (test-repo.md §10): ~1.1 s median per read over tor-js, 1.3–2.8 s per Multicall batch on app.ens.domains, ~5 ms added by the extension itself.
- Every site shows: "This dapp can always see your address and your IP."

---

## 5. Demo script (3:00, which also fits EF's 3-minute limit for the CROPS track)

| Time | Beat |
|---|---|
| 0:00 | Hook: "Your wallet can use anon-rpc. The dapp ignores it and sends your address to its own RPC, from your IP." |
| 0:15 | Open LeakyDash and connect. Provider log: your IP and address. Tracker log: your address. |
| 0:35 | Canary panel: declared = RPC provider; observed = RPC provider, tracker (**undeclared**), `/api/points` (first party). ENS verdict: signed, build matches. |
| 1:00 | Turn protection on and reload. The app still works. |
| 1:15 | Provider log: **nothing**. Read endpoint log: requests from Tor exits only. Tracker log: nothing (blocked). |
| 1:40 | Coverage, e.g. "RPC reads 23/23 via anon-rpc · blocked 2 · detected, unprotected 1 · not inspected: service workers · +x ms p50". |
| 2:05 | ENS: show the manifest and the verifier's one-key role. The dapp revokes the role → Canary flags "independent verification revoked". |
| 2:30 | Real world: Canary live on app.ens.domains ("8/8 RPC batches via anon-rpc, indexer calls listed"), plus the before/after table from scans of 3–5 public dapps (observed only, with coverage notes). |
| 2:50 | Close: "No fork. Declared vs observed. Enforced. Measured." |

Record a backup video by hour 30.

---

## 6. Build plan (~36 hours)

| Hours | A: Extension | B: Scanner | C: ENSv2 + LeakyDash | D: only with 4 people |
|---|---|---|---|---|
| 0–3 | ~~Spike~~ **done** (`canary-spike/`) | **Spike:** Playwright + mitmproxy + fake wallet catches the canary | ~~Spike: register an ENSv2 Sepolia name; set a text record; `authorizeTextRoles` on a second key~~ **done** (`grantSetterRoles`: Sepolia has no `authorizeTextRoles`) | Spike: v4 Quoter quote on Sepolia |
| 3–12 | ~~Substitution, method allowlist, chain-id learning, DNR rules~~ **done** (`extension/`) | Matcher (all encodings), flows, report JSON | ~~Manifest/verdict schema, EIP-712 signer, reader library~~ **done** (`packages/ens/src/verdict.ts`) | Private-quote widget |
| 12–20 | ~~Blocking, labels, popup~~ **done**; next: live tor-js runs on real dapps, popup polish | Runs with and without Canary, coverage %, build fingerprint | LeakyDash + observer RPC + tracker + log viewer | Sepolia swap tx, FEEDBACK.md |
| 20–28 | ~~Fail-closed mode, isolation keys, ENS lookups via anon-rpc~~ **done** (declared vs observed in the popup) | Real-dapp scans (3–5) | ~~Verdict write + revocation detection~~ **done, live on Sepolia** (`canary-ens`) | UI polish |
| 28–33 | Bug bash, latency numbers | Results table | README (CROPS section), architecture diagram | Demo video draft |
| 33–36 | Final demo, video, submissions (everyone) | | | |

**Two-person team:** A = extension; B = scanner + ENSv2 + LeakyDash. Cut Uniswap and the real-dapp scans first.

**Hour-3 checkpoints:** the Tor worker and the shim are already proven. Develop on the passthrough worker for speed (offline e2e) and test on tor-js regularly. If the scanner's mitmproxy + fake-wallet spike isn't catching the canary by hour 3, simplify it before adding flows. If ENSv2 Sepolia registration blocks us, go to the ENS mentors immediately.

**Setup notes (test-repo.md):** npm 11 needs `npm install-scripts approve esbuild node-datachannel`. On a Mac, anything running the in-process KPS server needs Docker. Use the full Chromium build (not headless-shell) for extension tests.

**Cut order:** Uniswap → multiple verifiers → WebSocket support → isolation keys → real-dapp scans.
**Never cut:** reads via anon-rpc by default, coverage measurement, the ENS manifest with a delegated signed verdict, honest labels.

---

## 7. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Arbitrary dapp traffic is hard to intercept reliably | High (was Critical; fetch-based JSON-RPC now proven on a real dapp) | Don't promise it. Wrap XHR and WebSocket next; viem's `http()` transport is already covered. Enforce only what has a recognizable structure (JSON-RPC), plus third-party requests carrying your address, and label everything else. mitmproxy measures what we miss, so gaps show up as numbers instead of surprises. Enforce on LeakyDash; show real dapps as scans. |
| Tor gateway failures or latency break the demo | Critical | The demo gateway is shared and "may disappear at any time"; tor-js cold boot is ~13 s (11 s of it downloading the Tor consensus). Keep the worker warm in the offscreen document. Batch and cache reads that never change (`eth_chainId`, `eth_getCode`). Ask EF whether we can run our own KPS gateway. Have the backup video. Show latency honestly. |
| ENSv2 looks cosmetic | Medium | One-key delegation + signed verdicts + revocation as a visible signal + multiple verifiers (3.3). |
| Competition: EF lists leak tools and dapp forks as ideas | Medium | Lead with what forks can't do: works on dapps we didn't write, declared vs observed, measured coverage. Closest prior art is PrivacyRPC (Solana; a desktop app plus extension routing through a local Tor proxy). Canary runs entirely in the browser via anon-rpc, with nothing native to install. |
| A dapp's provider blocks Tor exits | Medium | Known-host table, then the wallet's chain as a labelled fallback, so substituted reads still work; only forwarded (non-standard) calls fail closed, and they're labelled. Read endpoints proven over Tor: publicnode (mainnet, Sepolia), 1rpc, drpc. Not Tenderly. |
| For a retrofit, "your app routes reads by default" is ambiguous | Medium | Ask EF today. Canary's own reads are anonymous by default, and LeakyDash's native mode routes 100% of its reads. |
| Substituted answers differ from the provider's (lagging chain head, missing methods) | Medium | Substitute standard methods only, check it's the same chain, forward the rest. |
| The anonymity network's exit could lie about responses | Low for the demo, high in production | Stretch goal: verify `eth_call` results and balances with `eth_getProof` against a trusted block header. EF lists "anon-rpc + light client or proof verification" as an idea. |
| Overclaiming | High (credibility) | The rules in section 4. |
| Scanning real dapps | Low | Synthetic identity, no transactions, low request rate, neutral wording, published evidence. |

---

## 8. Decision log: where we changed our minds

1. **Corporate Action Firewall → killed.** Chainlink's tokenized-equity price feeds already pause during corporate actions such as stock splits; the issuer triggers the pause (Robinhood, Ondo, Coinbase). Teams at other hackathons have already shipped corporate-action layers.
2. **"Route the dapp's request through Tor" → "substitute it".** Forwarding still delivers the request to the dapp's keyed endpoint. The provider learns "address X used dapp Y", and timing can link it back to your page load.
3. **"Stop the app from linking you" → "stop third parties".** The dapp always has both your address and your IP, so we disclose that instead.
4. **"The scanner catches leaks" → coverage categories.** No leak observed ≠ no leak.
5. **0G → dropped.** The track requires AI to be the core product. Our detection is exact matching, and sending intercepted traffic to remote inference would itself be a leak.
6. **World → dropped for now.** Agent Pass needs an action that requires human approval, not a login, and Canary has none. IDKit would fit a future free quota for anonymous reads (see section 14).
7. **Chainlink CRE → dropped.** It's a single $1,500 prize, and Canary checks freshness client-side using the build fingerprint.
8. **Uniswap → stretch goal only.** The Mumbai brief accepts tooling, and a private-quote page is a real use case, but it takes a person.
9. **ENS → strengthened** from "a manifest in a text record" to delegated, signed verdicts whose revocation is visible.
10. **Demo step "show the endpoint's IP change to a Tor exit" → stronger version:** the dapp's provider sees nothing at all; only our read endpoint sees Tor exits.
11. **Chain detection: "always probe the dapp's endpoint" → known hosts, then probe, then the wallet as a labelled fallback.** The probe leaks dapp usage to the provider and breaks on providers that block Tor; but wallet-first is wrong for dapps that read other chains.
12. **Coverage: RPC only → RPC + backend/indexer.** On app.ens.domains, name data comes from an indexer API, not RPC.

---

## 9. Track checklists

**EF: Best Use of Anon-RPC** ($2,500 / $1,500 / $1,000 · one EF prize per project; EF judges pick the best fit)
- [ ] Reads go through anon-rpc by default (extension + LeakyDash native mode)
- [ ] Excluded traffic disclosed in the README and the UI
- [ ] Works end to end; good UX; shippable; technical depth
- [ ] EF places each project in at most one of anon-rpc / alt mempool / CROPS. CROPS's idea list includes "a tool that shows what an app leaks (RPC calls, trackers, metadata)", which is our scanner.
- [ ] Also meet the CROPS rules in case EF places us in that track: open-source license, a README "CROPS" section (section 13), demo ≤ 3 min, no third-party trackers in our client

**ENS: Best Use of ENSv2** ($3,000 / $2,000 / $1,000 / $1,000)
- [x] ENSv2 on Sepolia (or mainnet), central to the product: `leakydash.eth`, `canary.eth`, `verifier.canary.eth` (`packages/ens/README.md`)
- [x] Permissioned Resolver + EAC one-key delegation (and its revocation, read by the extension)
- [ ] Functional demo, no hard-coded values, live demo link, open-source repo (still needed: the live demo link)

**Uniswap: Build with Uniswap** ($4,000 / $3,000 / $2,000 / $1,000), stretch goal
- [ ] Public repo, FEEDBACK.md, the Developer Feedback Form linking to it, a README pointing to the contracts and lines of code

**ETHGlobal finalists**
- 3–5 people: $1,000 per person + $500 travel credit · 2 people: $250 + $250 · solo: $250
- The travel credit applies to one in-person ETHGlobal hackathon within 365 days. Finalists also get a hoodie, AWS credits and an ETHGlobal Plus discount.

---

## 10. Prize math (illustrative, not a forecast)

- **Maximum, 4 people:** EF 1st $2,500 + ENS 1st $3,000 (+ Uniswap 1st $4,000) + finalist $4,000 (+ $2,000 travel credit).
- **Our target:** one EF placement and one ENS placement. Finalist is a bonus.

---

## 11. Sponsors we're not targeting

| Sponsor | Why not |
|---|---|
| Chainlink | $1,500 CRE prize, and freshness is handled client-side. The CCIP track needs a cross-chain state change |
| World | Agent Pass needs an action that requires human approval; IDKit fits only the future quota idea |
| 0G | AI must be the core product |
| 1inch | Needs an Aqua/SwapVM DeFi position |
| Arc | Must start in Arc Studio; payments/DeFi briefs |
| Hedera | x402 agent payments, tokenization, or native SDK services |
| Whitechain | USDT settlement on Whitechain |
| Definitive | Social trading with Flash orders |
| Arkiv | Brief was still being finalized when we checked |

---

## 12. Open questions for mentors

**EF (workshop: 5:00 PM IST, Thu 5 Nov, Workshop Room 2)**
1. Does a retrofit extension count as "your app routes its reads through anon-rpc by default"?
2. Tor worker: can we point it at our own KPS gateway? How much load can the demo gateway take? Is `isolationKey` supported?
3. ~~Extension harness: what's the recommended way to call `worker.fetch` on behalf of page requests?~~ Answered in practice: calling it from the service worker for page-originated requests works without harness changes (test-repo.md §10).
4. Will judges accept reads answered by a different endpoint than the dapp's own (substitution)?

**ENS**
5. ~~What's the fastest way to get an ENSv2 Sepolia name with a Permissioned Resolver? Is `authorizeTextRoles` live there?~~ Answered in practice: ETHRegistrar commit/register, paid in Sepolia MockUSDC (anyone can mint it), with a resolver from the Verifiable Factory (`packages/ens/scripts/sepolia-setup.mjs`). `authorizeTextRoles` isn't there; `grantSetterRoles` / `revokeRoles` are.
6. What's the best way to check a one-key role is still granted: a view function, or watching `EACRolesChanged`?
7. Would ENS be interested in an ENSIP (ENS improvement proposal) for `privacy.*` keys?

---

## 13. README "CROPS" section (draft)

- **C (censorship resistance):** we run an optional verifier key and the demo's observer servers. If they disappear, the extension still enforces locally, labels fall back to "unverified", and ENS records stay readable through any RPC.
- **O (open source):** MIT license. You can build and run everything from the repo alone (`pnpm i && pnpm build` for the extension; `pnpm scan <url>` for the scanner).
- **P (privacy):** reads go through anon-rpc. The read endpoint learns which addresses are queried, but not your IP or which dapp you're using. Third-party requests carrying your address are blocked. The dapp itself still sees your address and IP. Canary has no analytics and does its own ENS lookups through anon-rpc.
- **S (security):** Canary never holds keys or signs transactions. Trust assumptions: the anon-rpc worker is hash-pinned onchain; Tor; the read endpoint could lie about responses (proof verification is a stretch goal); verdict authenticity rests on the verifier's signature.

---

## 14. After the hackathon

- Ship Canary as a wallet feature, since the wallet already sees every dapp you connect to.
- Human-metered anonymous exits: World ID (IDKit) once a day gives unlinkable tokens, so humans get free anonymous reads and bots are capped.
- Verify substituted reads with proofs (light client).
- Independent verifiers, plus an ENSIP for `privacy.*` keys.
- A CI action so dapps can gate releases on "no undeclared recipients".

---

## Sources

- ETHGlobal Mumbai prizes: https://ethglobal.com/events/mumbai/prizes (subpages: `/ethereum-foundation`, `/ens`, `/uniswap-foundation`, `/chainlink`, `/world`)
- anon-rpc: https://ethereum.github.io/anon-rpc/ · spec https://ethereum.github.io/anon-rpc/spec/ · adopters https://ethereum.github.io/anon-rpc/adopters/ · demo + extension harness https://ethereum.github.io/anon-rpc/demo/
- ENSv2: Permissioned Resolver https://docs.ens.domains/ensv2/permissioned-resolver · Enhanced Access Control https://docs.ens.domains/ensv2/enhanced-access-control
- wagmi `http` transport: https://wagmi.sh/core/api/transports/http
- "Is Your Wallet Snitching On You?" (USENIX Security 2023): https://www.usenix.org/conference/usenixsecurity23/presentation/torres
- "The Masks We (Think We) Wear" (PoPETs 2026): https://arxiv.org/abs/2607.06141
- "Keeping Privacy Labels Honest" (PoPETs 2022): https://petsymposium.org/popets/2022/popets-2022-0119.php
- "The next great wallet will be private" (ethereum.org): https://ethereum.org/latest/next-great-wallet-private/
- Chainlink tokenized equity feeds: https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood
- Repo test log and Canary spike results: [test-repo.md](test-repo.md)
- PrivacyRPC (prior art, Solana): https://github.com/AltCoinWiz/PrivacyRPC
