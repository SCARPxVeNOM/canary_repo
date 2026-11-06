# @canary/gateway

One local process that an agent in any language points its RPC URL and HTTP(S) proxy at (agent-sdk.md §3). Chain reads go through EF's anon-rpc; other egress follows the agent's privacy manifest; every decision is counted and reported.

```sh
canary-gateway --config canary.config.json     # see examples/viem-agent for a working config
canary-gateway ca                              # opt-in MITM CA: create it, print how to trust it
```

## Endpoints

| URL | For |
|---|---|
| `http://127.0.0.1:18545/<chainId>` | the agent's RPC URL (`POST /` works when one chain is configured) |
| `http://127.0.0.1:18080` | `HTTPS_PROXY` / `HTTP_PROXY` |
| `POST /canary/fetch` + `x-canary-url` | the SDK's in-process fetch: full policy, bodies visible |
| `GET /canary/status` | backend state, chains, policy hash, jitter, MITM, ENS state |
| `GET /canary/report` | signed full report + coarse form (`?rotate=1` starts a new window) |
| `POST /canary/publish` | sign and publish the coarse report to the agent's ENS name now (409 if the report key can't write) |
| `GET /canary/events` | live egress decisions (server-sent events) |
| `POST /canary/events` | SDK-side counts (`{kind:"llm", requests, pseudonymized}`) and wallets |

The control API answers loopback clients only: requests with a non-loopback `Host` (DNS rebinding) or any `Origin` (a web page) get 403.

## What happens to a request

**JSON-RPC** (`src/rpc.ts`):

| Call | Route | Counted as |
|---|---|---|
| standard read (`eth_call`, `eth_getBalance`, `eth_getLogs`, …) | the chain's `read` endpoint, via anon-rpc | Protected |
| other method (`alchemy_*`, `debug_*`, …) | the chain's `upstream` (or `read`), via anon-rpc | Protected (IP only) |
| `eth_sendRawTransaction` | manifest `rpc.write`: `anon` → `broadcast` (or `read`) via anon-rpc; `private` → `privateRelay` via anon-rpc; `direct` → sent directly | IP only / Direct |
| `eth_chainId`, `net_version` | answered locally | Protected |
| `eth_getCode` | cached for `codeCacheMs` | Protected |
| `eth_sendTransaction`, `eth_sign`, … | refused: agents sign locally | Blocked |
| anon path down, or no answer | JSON-RPC error. Never a direct retry | Failed closed |

A batch is split so calls about different agent wallets never share a request; each goes out under `isolationKey "addr:<address>"`. One call carrying two agent addresses can't be split: it uses the first, and the report counts it as linking wallets.

**HTTP(S)** (`src/http.ts`), per host from the manifest. The `x-canary-decision` response header says what happened:

| Rule | SDK / plain HTTP / HTTPS with MITM CA | HTTPS without the CA (CONNECT) |
|---|---|---|
| `anon` | via anon-rpc (`anon`) | refused: needs the CA (403) |
| `direct` | sent directly (`direct`) | tunnelled, counted Not inspected |
| `block` | refused (`blocked`) | refused (403) |
| not listed, `undeclared: "block"` | refused (`blocked`) | refused (403) |
| not listed, `undeclared: "report"` | sent directly (`undeclared`), or refused if it carries an agent address | tunnelled, counted Undeclared + Not inspected |

## Config

| Key | Meaning | Default |
|---|---|---|
| `network` | anon-rpc worker: `specifier`, `bootstrapRpc`, `workerConfig` (same shape as `extension/config/live.json`) | required unless `backend` |
| `chromium` | `executablePath`, or `channel: "chrome"`, `headless`, `args` | Playwright's Chromium |
| `chains` | `{ "<chainId>": { read, upstream?, broadcast?, privateRelay? } }`. Read endpoints must accept Tor (publicnode, 1rpc, drpc do; Tenderly doesn't) | required |
| `wallets` | the agent's addresses (isolation keys, taint checks). The SDK can add more at runtime | `[]` |
| `manifest` / `manifestFile` (CLI) | the policy, given locally | — |
| `ens` | `{ name, chainId, refreshMs?, publishEveryMs?, evidenceUri?, universalResolverAddress? }`. Without a local manifest, the policy is read from the name over anon-rpc and re-read every `refreshMs` (default 5 min), so on-chain changes apply live; until it loads, undeclared = block (fail closed). Reports are published every `publishEveryMs` (default daily; 0 = only on `POST /canary/publish`) | — |
| `reportKey` | signs reports and writes `privacy.report`. The CLI reads it from `CANARY_REPORT_KEY` only. Never the agent's wallet key | — |
| `mitm` | `true` or `{ dir?, passthrough? }`: opt-in local CA. HTTPS is decrypted with a per-host certificate, so bodies get the full policy and `anon` hosts go through anon-rpc. `passthrough` hosts (certificate-pinned clients) are tunnelled untouched | off |
| `jitterMs` | random 0..jitterMs delay before substituted reads, to blur polling schedules (costs latency; shown in status) | 0 |
| `hedgeMs` | if an anon read hasn't answered in this long (or fails), send it again under a fresh isolation key so tor-js builds a new circuit; first answer wins, and the working circuit is kept for that key. Never for broadcasts. 0 = off | 3000 |
| `port`, `proxyPort`, `host` | `proxyPort: false` disables the proxy | 18545, 18080, 127.0.0.1 |
| `timeoutMs`, `codeCacheMs` | per anon request; `eth_getCode` cache | 30000, 60000 |

## The anon backend

`src/backend/chromium.ts` runs `@anon-rpc/browser-harness` in headless Chrome (the Node harness can't run tor-js yet). The page reads the worker from its on-chain specifier (the specifier read leaves from the gateway's Node process) and verifies its hash. Node reaches `worker.fetch` over a loopback WebSocket:
- bodies stream in ≤256 KB frames with credit-based backpressure, and aborts propagate;
- if Chrome crashes or the worker fails to boot, pending calls fail closed and Chrome relaunches with backoff (1 s, 2 s, … 60 s).

## The MITM CA

`canary-gateway ca` creates `~/.canary/ca/ca.pem`, `ca.key` (mode 0600, never leaves the folder) and `bundle.pem` (public roots + Canary's CA, for clients whose CA setting replaces the default set). Trust it in the agent's runtime only:

| Runtime | Setting |
|---|---|
| Node | `NODE_EXTRA_CA_CERTS=~/.canary/ca/ca.pem` |
| Python `requests` | `REQUESTS_CA_BUNDLE=~/.canary/ca/bundle.pem` |
| OpenSSL, curl | `SSL_CERT_FILE` / `CURL_CA_BUNDLE` = the bundle |

Upstream TLS is still verified normally on the way out. A client that doesn't trust the CA gets a TLS error, never silent interception.

## Test

`npm test` needs Chrome (`CHROME_BIN`, else `/usr/bin/google-chrome`, else the installed Chrome). It runs against EF's passthrough reference worker (hash-verified as on chain) and local fixtures:
- `backend.test.mjs`: the bridge, streaming, aborts, crash and boot-failure recovery;
- `gateway.test.mjs`: the RPC endpoint, proxy, reports, jitter;
- `ens.test.mjs`: the policy from ENS with live updates, publishing, revocation (ganache + mock ENSv2);
- `mitm.test.mjs`: the CA;
- `python.test.mjs`: the Python example agent (skipped without python3).
