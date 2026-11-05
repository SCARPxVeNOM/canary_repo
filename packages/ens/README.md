# @canary/ens

The ENSv2 side of Canary for agents (agent-sdk.md §4): an agent's name holds its policy and its signed egress reports, with a one-key role so the gateway can write reports and nothing else.

| Record on the agent's name | Written by | Content |
|---|---|---|
| `privacy.manifest` | operator (owner key) | the policy (see `packages/core/README.md`) |
| `privacy.report` | the gateway's report key, delegated for this one text key | coarse report + EIP-712 signature (below) |

## API

| Function | What |
|---|---|
| `loadManifest(client, name)` | read and validate `privacy.manifest`; throws `ManifestNotFound`, or if `manifest.agent` names another name |
| `readAgentPrivacy(client, name, { policyHashOf })` | everything a verifier needs: manifest, report, and `checks` (below) |
| `canWriteText(client, resolver, name, key, account)` | simulates `setText` from `account`. Works with either delegation API; it's how revocation is detected |
| `grantTextKey` / `revokeTextKey` | delegate or revoke one text key. Detects the resolver's API by simulation (see below); a revoke is confirmed by re-checking write access |
| `roleHistory(client, resolver, account)` | `EACRolesChanged` events for `account`, each marked granted/revoked/unchanged for the text role |
| `setTextRecord(writer, resolver, name, key, value)` | simulate, send, wait for the receipt |
| `signCoarseReport` / `verifyReportRecord` | sign the coarse report with the report key; recover the signer |
| `policyHashOf(manifest)` | `keccak256(canonicalJson(manifest))` |

`readAgentPrivacy(...).checks`:

| Check | True when |
|---|---|
| `reportSigned` | the record's signature recovers to its `signer` |
| `signerIsReporter` | that signer is the manifest's declared `reporter` |
| `policyMatches` | the report was made under the manifest published now |
| `reporterCanWrite` | the reporter can still write `privacy.report` (simulated) |
| `reporterRevoked` | the reporter's text role was revoked at some point (visible on chain) |

## The `privacy.report` record

```json
{ "agent": "trader-01.agents.canary.eth", "policyHash": "0x…", "reportHash": "0x…",
  "days": [1793836800, 1793923200], "rpcViaAnonPct": 95, "rpcVolume": "1k-10k",
  "failedClosed": "0", "blocked": "1-99", "undeclared": "0", "notInspected": "0",
  "llmAddressesPseudonymized": "100-999", "evidenceUri": "https://…",
  "signer": "0x…", "signature": "0x…" }
```

Coarse on purpose: whole-day windows, bucketed counts, no per-host detail or timing, because hourly numbers would reveal when and how much the agent works. `reportHash` commits to the full report, which stays with the operator (`evidenceUri`, if published). The signature is EIP-712 over `CoarseReport{agent, policyHash, reportHash, coarseHash}`, domain `Canary Egress Report` v1.

## ENSv2 compatibility (read this before the demo)

As of Nov 2026 the ENS docs describe two ways to delegate one text key:

- `authorizeTextRoles(bytes name, string key, address account, bool grant)` (Permissioned Resolver guide);
- `grantSetterRoles(bytes setterCalldata, address account)` / `revokeRoles(resource, roleBitmap, account)`, where a text key's resource is `keccak256(bytes(key))` (contracts reference).

`grantTextKey`/`revokeTextKey` try both and use the one the resolver accepts. Reads go through viem's `getEnsText`, which uses the Universal Resolver address viem ships for the chain (pass `universalResolverAddress` / `--universal-resolver` if ENS gives you a different one); writes use `setText(bytes dnsEncodedName, key, value)`; revocation detection simulates `setText`, so it doesn't depend on either API. The tests run against mock contracts written from the docs (`test/contracts/Mocks.sol`), one per API. **Not yet run against the live Sepolia deployment:** confirm with the ENS mentors which API is deployed.

## CLI

```sh
canary-ens read trader-01.agents.canary.eth                         # anyone: manifest, report, checks
CANARY_OWNER_KEY=0x… canary-ens set-manifest <name> manifest.json   # validates before publishing
CANARY_OWNER_KEY=0x… canary-ens grant-reporter <name> <reportKeyAddress>
CANARY_OWNER_KEY=0x… canary-ens revoke-reporter <name> <reportKeyAddress>
```

`--chain <id>` (default 11155111). `--rpc <url>` defaults to the local gateway (`http://127.0.0.1:18545/<chain>`), so these lookups and transactions also go over anon-rpc. `--universal-resolver <address>` for chains viem doesn't know.

## Test

`npm test`: ganache (in-process, chain id 11155111) plus the mock contracts, compiled with solc at test time. Covers both delegation APIs, tampering, a forged reporter, policy drift, and a manifest published on the wrong name.
