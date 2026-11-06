#!/usr/bin/env node
/* canary-ens: operator and verifier commands for an agent's ENSv2 name.

   canary-ens read <name>                        manifest, report, signature and role checks (anyone)
   canary-ens set-manifest <name> <file.json>    publish privacy.manifest     (CANARY_OWNER_KEY)
   canary-ens grant-reporter <name> <address>    let the gateway's report key write privacy.report only
   canary-ens revoke-reporter <name> <address>   take it back (visible on chain as EACRolesChanged)

   A dapp's name (idea.md §3.3):
   canary-ens set-dapp <name> <manifest.json>     publish url (= manifest.origin) and privacy.manifest   (CANARY_OWNER_KEY)
   canary-ens grant-verifier <name> <address>     let a verifier write privacy.verdict.<id> only         (CANARY_OWNER_KEY)
   canary-ens revoke-verifier <name> <address>    silence it (visible on chain)                           (CANARY_OWNER_KEY)
   canary-ens sign-verdict <name> <scan.json> --verifier-name <ens>   sign a verdict from a scanner baseline report (CANARY_VERIFIER_KEY)
   canary-ens publish-verdict <name> <verdict.json>                   write it, as the verifier            (CANARY_VERIFIER_KEY)
   canary-ens read-dapp <name>                    url, manifest, verdict and whether the verifier still holds its role

   Options: --chain <id> (default 11155111)  --rpc <url> (default: the local Canary
   gateway, http://127.0.0.1:18545/<chain>, so these lookups also go over anon-rpc)
   --universal-resolver <address> (chains viem doesn't know) · --verifier <id> (default canary)
   --ttl-days <n> (default 30) · --evidence <uri>. */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, sepolia } from "viem/chains";
import { parseDappManifest, parseManifest } from "@canary/core";
import { TEXT_KEYS } from "./abi.js";
import { readAgentPrivacy, readText, resolverOf } from "./read.js";
import { policyHashOf } from "./record.js";
import { verdictFromScan, verdictKey, parseVerdictRecord, signVerdict, verifyVerdictRecord } from "./verdict.js";
import { canWriteText, grantTextKey, revokeTextKey, setTextRecord } from "./write.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    chain: { type: "string", default: "11155111" }, rpc: { type: "string" }, "universal-resolver": { type: "string" },
    verifier: { type: "string", default: "canary" }, "verifier-name": { type: "string" }, "ttl-days": { type: "string", default: "30" }, evidence: { type: "string" },
  },
});
const [cmd, name, arg] = positionals;
const usage = () => {
  console.error("usage: canary-ens read|set-manifest|grant-reporter|revoke-reporter|set-dapp|grant-verifier|revoke-verifier|sign-verdict|publish-verdict|read-dapp <name> [file|address] [--chain id] [--rpc url]");
  process.exit(2);
};
if (!cmd || !name) usage();

const id = Number(values.chain);
const chain: Chain = id === 1 ? mainnet : id === 11155111 ? sepolia : defineChain({ id, name: `chain ${id}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
const transport = http(values.rpc ?? `http://127.0.0.1:18545/${id}`);
const client = createPublicClient({ chain, transport });
const o = values["universal-resolver"] ? { universalResolverAddress: values["universal-resolver"] as Address } : {};
const json = (v: unknown) => console.log(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));

async function writer(env = "CANARY_OWNER_KEY") {
  const key = process.env[env] as Hex | undefined;
  if (!key) throw new Error(env === "CANARY_OWNER_KEY" ? "set CANARY_OWNER_KEY (the key that controls the name's resolver)" : `set ${env}`);
  const resolver = await resolverOf(client as any, name!, o);
  if (!resolver) throw new Error(`${name} has no resolver`);
  return { w: { wallet: createWalletClient({ chain, transport, account: privateKeyToAccount(key) }), client: client as any }, resolver };
}

switch (cmd) {
  case "read":
    json(await readAgentPrivacy(client as any, name!, { ...o, policyHashOf }));
    break;
  case "set-manifest": {
    if (!arg) usage();
    const manifest = parseManifest(await readFile(arg!, "utf8")); // validate before publishing
    const { w, resolver } = await writer();
    const hash = await setTextRecord(w, resolver, name!, TEXT_KEYS.manifest, JSON.stringify(manifest));
    json({ set: TEXT_KEYS.manifest, policyHash: policyHashOf(manifest), tx: hash });
    break;
  }
  case "grant-reporter":
  case "revoke-reporter": {
    if (!arg) usage();
    const { w, resolver } = await writer();
    const r = await (cmd === "grant-reporter" ? grantTextKey : revokeTextKey)(w, resolver, name!, TEXT_KEYS.report, arg as Address);
    json({ [cmd === "grant-reporter" ? "granted" : "revoked"]: TEXT_KEYS.report, to: arg, via: r.api, tx: r.hash });
    break;
  }
  case "set-dapp": {
    if (!arg) usage();
    const manifest = parseDappManifest(await readFile(arg!, "utf8")); // validate before publishing
    if (!manifest.origin) throw new Error("the manifest needs an origin: it becomes the name's url record, which binds the name to the site");
    if (manifest.name && manifest.name !== name) throw new Error(`manifest.name is ${manifest.name}, not ${name}`);
    const { w, resolver } = await writer();
    const url = await setTextRecord(w, resolver, name!, "url", new URL(manifest.origin).origin);
    const m = await setTextRecord(w, resolver, name!, TEXT_KEYS.manifest, JSON.stringify(manifest));
    json({ set: ["url", TEXT_KEYS.manifest], origin: new URL(manifest.origin).origin, tx: [url, m], next: "serve /.well-known/canary.json → {\"ens\": \"" + name + "\"} on the site" });
    break;
  }
  case "grant-verifier":
  case "revoke-verifier": {
    if (!arg) usage();
    const { w, resolver } = await writer();
    const key = verdictKey(values.verifier);
    const r = await (cmd === "grant-verifier" ? grantTextKey : revokeTextKey)(w, resolver, name!, key, arg as Address);
    json({ [cmd === "grant-verifier" ? "granted" : "revoked"]: key, to: arg, via: r.api, tx: r.hash });
    break;
  }
  case "sign-verdict": {
    if (!arg || !values["verifier-name"]) usage();
    const key = process.env.CANARY_VERIFIER_KEY as Hex | undefined;
    if (!key) throw new Error("set CANARY_VERIFIER_KEY (the key the verifier name's addr record points at)");
    const v = verdictFromScan(JSON.parse(await readFile(arg!, "utf8")), { name: name!, verifier: values["verifier-name"]!, ttlDays: Number(values["ttl-days"]), evidenceURI: values.evidence });
    json(await signVerdict(v, key));
    break;
  }
  case "publish-verdict": {
    if (!arg) usage();
    const record = parseVerdictRecord(await readFile(arg!, "utf8"));
    const signer = await verifyVerdictRecord(record); // refuse to publish a record that doesn't verify
    if (record.name !== name) throw new Error(`the verdict is about ${record.name}, not ${name}`);
    const { w, resolver } = await writer("CANARY_VERIFIER_KEY");
    const hash = await setTextRecord(w, resolver, name!, verdictKey(values.verifier), JSON.stringify(record));
    json({ set: verdictKey(values.verifier), signer, result: record.result, tx: hash });
    break;
  }
  case "read-dapp": {
    const key = verdictKey(values.verifier);
    const [url, manifest, verdict, resolver] = await Promise.all([
      readText(client as any, name!, "url", o),
      readText(client as any, name!, TEXT_KEYS.manifest, o),
      readText(client as any, name!, key, o),
      resolverOf(client as any, name!, o),
    ]);
    const out: Record<string, unknown> = { name, resolver, url, manifest: manifest ? parseDappManifest(manifest) : null };
    if (verdict) {
      const r = parseVerdictRecord(verdict);
      const signer = await verifyVerdictRecord(r).catch((e) => `invalid: ${(e as Error).message}`);
      const addr = await client.getEnsAddress({ name: r.verifier, ...(o.universalResolverAddress ? { universalResolverAddress: o.universalResolverAddress } : {}) }).catch(() => null);
      out.verdict = {
        result: r.result, undeclaredHosts: r.undeclaredHosts, buildHash: r.buildHash, verifier: r.verifier, signer,
        signerIsVerifier: !!addr && addr.toLowerCase() === r.signer.toLowerCase(),
        verifierCanWrite: resolver ? (await canWriteText(client as any, resolver, name!, key, r.signer as Address)).ok : null,
        expired: Date.now() / 1000 > r.expiresAt,
      };
    }
    json(out);
    break;
  }
  default:
    usage();
}
