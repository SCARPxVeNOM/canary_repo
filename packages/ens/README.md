# @canary/ens

The ENSv2 side of Canary. For agents (docs/agent-sdk.md §4): an agent's name holds its policy and its signed egress reports, with a one-key role so the gateway can write reports and nothing else. For dapps (docs/design-notes.md §3.3): a dapp's name holds its declared recipients and an independent verifier's signed verdict, again with a one-key role (below).

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

`grantTextKey`/`revokeTextKey` try both and use the one the resolver accepts. Reads go through viem's `getEnsText`, which uses the Universal Resolver address viem ships for the chain (pass `universalResolverAddress` / `--universal-resolver` if ENS gives you a different one); writes use `setText(bytes dnsEncodedName, key, value)`; revocation detection simulates `setText`, so it doesn't depend on either API. The tests run against mock contracts written from the docs (`test/contracts/Mocks.sol`), one per API.

**On Sepolia** (checked against the Sourcify-verified `PermissionedResolver` source, and live, below): the deployed resolver has `grantSetterRoles` / `revokeRoles` and no `authorizeTextRoles`; `setText` needs `ROLE_SET_TEXT` (`1 << 4`) on `keccak256(bytes(key))` or on the root resource, so the one-key grant works as designed. `revokeTextKey` confirms the revoke from the receipt's `EACRolesChanged` (a load-balanced RPC's `latest` can be a block behind the receipt).

## CLI

```sh
canary-ens read trader-01.agents.canary.eth                         # anyone: manifest, report, checks
CANARY_OWNER_KEY=0x… canary-ens set-manifest <name> manifest.json   # validates before publishing
CANARY_OWNER_KEY=0x… canary-ens grant-reporter <name> <reportKeyAddress>
CANARY_OWNER_KEY=0x… canary-ens revoke-reporter <name> <reportKeyAddress>
```

`--chain <id>` (default 11155111). `--rpc <url>` defaults to the local gateway (`http://127.0.0.1:18545/<chain>`), so these lookups and transactions also go over anon-rpc. `--universal-resolver <address>` for chains viem doesn't know.

## A dapp's name: manifest and a verifier's verdict (docs/design-notes.md §3.3)

| Record on the dapp's name | Written by | Content |
|---|---|---|
| `url` | dapp (owner key) | its origin; the site serves `/.well-known/canary.json` → `{"ens": "<name>"}`, so the binding holds both ways |
| `privacy.manifest` | dapp | who receives the connected address: `{name, origin, recipients: [{host, kind, purpose}], rpc}` (`parseDappManifest` in `@canary/core`) |
| `privacy.verdict.canary` | the verifier only, delegated for this one key | a scanner baseline turned into a signed verdict (below) |

The dapp grants the verifier exactly one key (`grantTextKey`, as for the agent's reporter), so the verifier can publish bad news without the dapp's help and can't touch anything else. The owner keeps admin roles and could re-grant itself the key, so the verdict is also signed by the key in the verifier name's `addr` record. The only way to silence the verifier is to revoke the role, which readers see: `canWriteText` turns false, and `EACRolesChanged` is on chain. Per the ENS docs, a text-key grant covers that key on every name the same Permissioned Resolver instance serves; give the dapp's name its own resolver if that matters.

The verdict (`verdict.ts`): `{name, origin, verifier, buildHash, scannerHash, flows, result: matches | undeclared | incomplete, undeclaredHosts, addressRecipients?, notInspected, issuedAt, expiresAt, evidenceURI?, signer, signature}`. `addressRecipients` is every third party the scan saw receive the address, with its kind (`[{host, kind}]`, `[]` when none did); records from before it was added still parse. EIP-712 over `Verdict{name, origin, verifier, result, issuedAt, expiresAt, verdictHash}` (domain `Canary Verdict` v1), where `verdictHash = keccak256(canonicalJson(verdict))` commits to the rest. `verdictFromScan` makes it from a `scanner/scan.mjs` baseline report (never a with-Canary run: the verdict is about what the dapp itself sends); `incomplete` when there was no manifest to check against.

```sh
CANARY_OWNER_KEY=0x…    canary-ens set-dapp leakydash.eth manifest.json        # url + privacy.manifest
CANARY_OWNER_KEY=0x…    canary-ens grant-verifier leakydash.eth <verifierAddress>
CANARY_VERIFIER_KEY=0x… canary-ens sign-verdict leakydash.eth scans/leakydash.baseline.json --verifier-name verifier.canary.eth > verdict.json
CANARY_VERIFIER_KEY=0x… canary-ens publish-verdict leakydash.eth verdict.json  # refuses a record that doesn't verify
canary-ens read-dapp leakydash.eth                                             # anyone: records, signer, role still held, expiry
CANARY_OWNER_KEY=0x…    canary-ens revoke-verifier leakydash.eth <verifierAddress>
```

The browser extension reads these records over anon-rpc and shows the verdict next to declared vs observed (`extension/README.md`).

## Canary's labels: a verdict for sites with no name of their own

Most dapps publish no manifest. For those, Canary publishes the verifier's verdict under a name it holds (`label.ts`): `app.aave.com` → `app-aave-com.labels.canary.eth`.

| Record on the label | Written by | Content |
|---|---|---|
| `url` | Canary (owner key) | the site's origin: binds the label to the site, since two hosts can map to one label name (`a-b.com`, `a.b-com`) |
| `privacy.verdict.canary` | the verifier only, delegated for this one key | the verdict from a baseline scan of the site, as above; `addressRecipients` is what the label says |

`labels.canary.eth` has its own UserRegistry, and every label shares one Permissioned Resolver, on which the verifier holds `ROLE_SET_TEXT` for `privacy.verdict.canary` only: one `grantSetterRoles` covers that key on every name the resolver serves. So Canary can bind and unbind labels, the verifier can write verdicts and nothing else, and revoking the verifier is visible as for a dapp. A site that publishes its own name (`/.well-known/canary.json`) is read from there; the label is only a fallback. `labelName(origin)` returns null for an IP address, a host without a dot, or a host whose label wouldn't be plain lowercase ASCII (`xn--…`, `_`, over 63 characters).

## Live on Sepolia

Every record above is on ENSv2 Sepolia, written by these commands. Addresses and every transaction: [`sepolia.json`](sepolia.json).

| Name | What it is | ENSv2 parts used |
|---|---|---|
| `leakydash.eth` | the demo dapp (`leakydash/`, live at https://canary-leakydash.vercel.app): `url`, `privacy.manifest`, and `privacy.verdict.canary` | ETHRegistrar (commit/register, paid in MockUSDC); its own Permissioned Resolver from the Verifiable Factory; a one-key EAC grant (`grantSetterRoles`) to the verifier |
| `swap.canary.eth` | Canary Swap (`swap/`, live at https://canary-swap.vercel.app): `url`, `privacy.manifest`, and the verifier's `privacy.verdict.canary` (`matches`, from a scan of the deployed site) | a subname in canary.eth's registry with its own Permissioned Resolver, like a dapp's own name; a one-key EAC grant to the verifier |
| `canary.eth` | Canary's namespace: `url`, `description` | a UserRegistry as its subregistry (`setParent` → the .eth registry) |
| `verifier.canary.eth` | the verifier: a subname owned by the verifier key, `addr` = that key | a subname in that registry, resolved through the Universal Resolver |
| `agents.canary.eth` | the agents' namespace: one subname per agent | a subname with its own UserRegistry as subregistry (`setParent` → canary.eth's registry) |
| `trader-01.agents.canary.eth` | the example agent (`examples/viem-agent`): `privacy.manifest` is its policy, `privacy.report` its signed egress report | its own Permissioned Resolver, so the report key's one-key grant covers this agent only; a one-key EAC grant to the report key |
| `labels.canary.eth` | Canary's labels: one subname per site | a subname with its own UserRegistry (`setParent` → canary.eth's registry); one Permissioned Resolver for every label, with a one-key grant to the verifier |
| `app-uniswap-org.labels.canary.eth` … | labels for app.uniswap.org, app.aave.com, app.ens.domains, revoke.cash, snapshot.box: `url`, and the verifier's signed verdict from the baseline scans in [`test-artifacts/scans/`](../../test-artifacts/scans/) | subnames resolved through the Universal Resolver; verdicts written by the verifier key under its grant |

```sh
# names, resolvers and the subregistry (rerunnable: it skips what's on chain); --label adds a label per baseline scan
npm run build
node scripts/sepolia-setup.mjs --owner-key-file ../../keys.txt --verifier-key-file ../../verifier.key --report-key-file ../../report.key \
  --label ../../test-artifacts/scans/app.aave.com.baseline.json   # …one per site
# the records, as above, with --rpc https://ethereum-sepolia-rpc.publicnode.com (or a gateway's RPC_URL)
canary-ens read-dapp leakydash.eth --rpc https://ethereum-sepolia-rpc.publicnode.com
canary-ens read trader-01.agents.canary.eth --rpc https://ethereum-sepolia-rpc.publicnode.com
```

The verdict was made from a real baseline scan of the deployed LeakyDash ([`test-artifacts/sepolia/`](../../test-artifacts/sepolia/): the report, and the signed verdict as published). It says `undeclared`: `canary-leakydash-tracker.vercel.app` received the address in three encodings and isn't in the manifest. (The first verdict, from a scan of the local LeakyDash, is `leakydash.localhost.verdict.json`.) Checked live: the signer is `verifier.canary.eth`'s `addr`; the verifier holds `ROLE_SET_TEXT` on that key only; after `revoke-verifier`, both `read-dapp` and the extension's reader (`extension/test/ens-live.mjs`) show the verifier can no longer write, and after `grant-verifier` again, that it can. The name's `url` and the verdict's origin are the deployed site, so a LeakyDash run locally (`npm start`) reads as unbound; point the name back with `set-dapp leakydash.eth leakydash/privacy.manifest.json` to demo it offline.

The labels say what the baseline scans saw (6 Nov 2026): app.uniswap.org, no third party got the address (`matches`: nothing was sent that needed declaring); app.aave.com, 3 (Datadog analytics, Tenderly RPC, apps.aavechan.com); app.ens.domains, 2 (api.bigname.sh, the lb.drpc.live RPC); revoke.cash, 3 (its Alchemy and Avalanche RPCs); snapshot.box, 4 (hub.snapshot.org, rpc.brovider.xyz, stamp.fyi, cdn.stamp.fyi). The others are `incomplete`: there's no manifest to check them against, so the label lists recipients instead. Each verdict's `evidenceURI` is the scan's report in this repo. Checked live with the extension's reader (`extension/test/ens-live.mjs <origin>`): signed by `verifier.canary.eth`'s `addr`, role still held, bound to the site, not expired, for all five; LeakyDash still reads from its own name.

The agent's names were set up and written through a Canary gateway (`examples/viem-agent`, `npm run gateway:local`), so every read and transaction went over anon-rpc. Then a gateway started with `npm run gateway:ens:local` loaded its policy from `trader-01.agents.canary.eth` (policy hash `0x280b5592…`), the example agent ran through it, and `POST /canary/publish` signed the coarse report with the report key and wrote it to `privacy.report`. Checked live: `canary-ens read` shows `reportSigned`, `signerIsReporter`, `policyMatches` and `reporterCanWrite` all true; after `revoke-reporter`, `reporterCanWrite` is false and the gateway's publish gets 409; after `grant-reporter` again, it's true.

## Test

`npm test`: ganache (in-process, chain id 11155111) plus the mock contracts, compiled with solc at test time. Covers both delegation APIs, tampering, a forged reporter, policy drift, and a manifest published on the wrong name; and for dapps (`test/verdict.test.mjs`): a verdict from a scan (and its `addressRecipients`), label names, signature tampering, and the verifier's one-key grant, publish and revoke.
