# @canary/core

Platform-neutral Canary logic, shared by the browser extension (`extension/src/shared.ts` re-exports it) and the agent packages. No dependencies; deterministic exact matching, no heuristics.

| Module | What |
|---|---|
| `rpc.ts` | `parseJsonRpc` (single or batch), `SUBSTITUTABLE` read methods, `BROADCAST`, `NODE_SIGNING`, error/result helpers |
| `address.ts` | `needlesFor` / `findAddress` / `findAddresses`: an address in hex (any case, padded, URL-encoded) or base64; `isolationKeyFor` |
| `domain.ts` | `registrableDomain`, `isThirdParty`, `knownChain` (extension only) |
| `coverage.ts` | coverage categories and labels (docs/agent-sdk.md §3.5) |
| `policy.ts` | the privacy manifest: `parseManifest`, `ruleFor`, `canonicalJson` |

## The privacy manifest

The agent's policy. The gateway enforces it ("declared = enforced"). It lives in the agent's ENSv2 `privacy.manifest` text record, or in a local file.

```json
{
  "v": 1,
  "agent": "trader-01.agents.canary.eth",
  "hosts": { "api.openai.com": "direct", "*.coingecko.com": "anon", "tracker.example": "block" },
  "undeclared": "block",
  "rpc": { "write": "anon" },
  "reporter": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "wallets": "undisclosed",
  "llm": { "allow": ["0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"] }
}
```

| Field | Meaning | Default |
|---|---|---|
| `v` | schema version | required, `1` |
| `agent` | the agent's ENS name; must match the name it's published on | — |
| `hosts` | per host: `anon` (via anon-rpc), `direct` (declared, counted), `block`. Exact host, or `*.example.com` for subdomains (not the apex); longest match wins | `{}` |
| `undeclared` | hosts not listed: `block`, or `report` (sent directly, counted Undeclared, blocked if the request visibly carries an agent address) | `block` |
| `rpc.write` | how `eth_sendRawTransaction` leaves: `anon`, `private` (relay over anon-rpc), `direct` | `anon` |
| `reporter` | the gateway's report key address: the only account meant to write `privacy.report` | — |
| `wallets` | declaration only: whether the agent's wallets are published on its name | — |
| `llm.allow` | addresses the prompt pseudonymizer passes through (well-known contracts) | `[]` |

`parseManifest` validates and normalizes (host patterns lowercased, `llm.allow` lowercased). `canonicalJson` gives sorted-key JSON; the policy hash in reports is `keccak256` of it.

## Test

`npm test` (after `npm run build` at the repo root).
