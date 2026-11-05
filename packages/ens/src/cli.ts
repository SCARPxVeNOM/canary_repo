#!/usr/bin/env node
/* canary-ens: operator and verifier commands for an agent's ENSv2 name.

   canary-ens read <name>                        manifest, report, signature and role checks (anyone)
   canary-ens set-manifest <name> <file.json>    publish privacy.manifest     (CANARY_OWNER_KEY)
   canary-ens grant-reporter <name> <address>    let the gateway's report key write privacy.report only
   canary-ens revoke-reporter <name> <address>   take it back (visible on chain as EACRolesChanged)

   Options: --chain <id> (default 11155111)  --rpc <url> (default: the local Canary
   gateway, http://127.0.0.1:18545/<chain>, so these lookups also go over anon-rpc)
   --universal-resolver <address> (chains viem doesn't know). */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, sepolia } from "viem/chains";
import { parseManifest } from "@canary/core";
import { TEXT_KEYS } from "./abi.js";
import { readAgentPrivacy, resolverOf } from "./read.js";
import { policyHashOf } from "./record.js";
import { grantTextKey, revokeTextKey, setTextRecord } from "./write.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { chain: { type: "string", default: "11155111" }, rpc: { type: "string" }, "universal-resolver": { type: "string" } },
});
const [cmd, name, arg] = positionals;
const usage = () => {
  console.error("usage: canary-ens read|set-manifest|grant-reporter|revoke-reporter <name> [file|address] [--chain id] [--rpc url]");
  process.exit(2);
};
if (!cmd || !name) usage();

const id = Number(values.chain);
const chain: Chain = id === 1 ? mainnet : id === 11155111 ? sepolia : defineChain({ id, name: `chain ${id}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
const transport = http(values.rpc ?? `http://127.0.0.1:18545/${id}`);
const client = createPublicClient({ chain, transport });
const o = values["universal-resolver"] ? { universalResolverAddress: values["universal-resolver"] as Address } : {};
const json = (v: unknown) => console.log(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));

async function writer() {
  const key = process.env.CANARY_OWNER_KEY as Hex | undefined;
  if (!key) throw new Error("set CANARY_OWNER_KEY (the key that controls the name's resolver)");
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
  default:
    usage();
}
