#!/usr/bin/env node
/* Canary's demo names on ENSv2 Sepolia (idea.md §3.3). Safe to rerun: each
   step checks the chain first and skips what is already done.

     leakydash.eth          the dapp, with its own Permissioned Resolver (a
                            verifier's one-key grant covers every name on a
                            resolver, so a dapp shouldn't share one)
     canary.eth             Canary's namespace: a UserRegistry is its subregistry
     verifier.canary.eth    the verifier: a subname owned by the verifier key,
                            addr = that key (readers check verdict signers against it)

   The records themselves are written with canary-ens afterwards (set-dapp,
   grant-verifier, sign-verdict, publish-verdict; see packages/ens/README.md).

   usage: node scripts/sepolia-setup.mjs --owner-key-file <file> --verifier-key-file <file>
            [--rpc <url>] [--out sepolia.json]

   A key file holds a hex key, alone or as `name=key` (first line used). Keys
   are never printed. A missing verifier key file is created (mode 600) with a
   fresh key, and the owner sends it a little Sepolia ETH for gas.
   Registration is paid in Sepolia MockUSDC, which anyone can mint.

   Contract addresses: docs.ens.domains/ensv2 (Sepolia, Nov 2026); ABIs checked
   against the Sourcify-verified sources. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  createPublicClient, createWalletClient, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, http, keccak256,
  labelhash, namehash, parseAbi, parseEther, toBytes, toHex, zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { packetToBytes } from "viem/ens";
import { sepolia } from "viem/chains";

const A = {
  ethRegistrar: "0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3",
  ethRegistry: "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4",
  factory: "0xda70306c98e97ece36f997a21368e53298572991",
  resolverImpl: "0x115eb53f0c60696633855f90b138178fb40b2b2c",
  userRegistryImpl: "0x9bd8a88719068d09ecee662f36c0e3856708366a",
  usdc: "0x240b0316df57887dbbe58b586508b19e633a14aa",
  universalResolver: "0xeeeeeeee14d718c2b47d9923deab1335e144eeee",
};

const DAPP = "leakydash";
const NAMESPACE = "canary";
const VERIFIER = "verifier";
const DURATION = 365n * 86400n;
// every role, admin roles included, for the owner of a resolver or registry it deploys
const ALL_ROLES = ((1n << 256n) - 1n) / 15n; // 0x1111…1
// what ETHRegistrar grants a .eth owner (RegistryRolesLib): set subregistry and resolver, with admin, and transfer
const NAME_OWNER_ROLES = (1n << 20n) | (1n << 148n) | (1n << 24n) | (1n << 152n) | (1n << 156n);
const COIN_ETH = 60n;

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
]);
const registrar = parseAbi([
  "function isAvailable(string) view returns (bool)",
  "function getRegisterPrice(string,uint64,address) view returns (uint256 base, uint256 premium)",
  "function makeCommitment(string,address,bytes32,address,address,uint64,bytes32) pure returns (bytes32)",
  "function commit(bytes32)",
  "function commitmentAt(bytes32) view returns (uint64)",
  "function MIN_COMMITMENT_AGE() view returns (uint64)",
  "function register(string,address,bytes32,address,address,uint64,address,bytes32) returns (uint256)",
]);
const registry = parseAbi([
  "function findOwner(string) view returns (address)",
  "function findExpiry(string) view returns (uint64)",
  "function getResolver(string) view returns (address)",
  "function getSubregistry(string) view returns (address)",
  "function getParent() view returns (address, string)",
  "function setParent(address,string)",
  "function register(string,address,address,address,uint256,uint64) returns (uint256)",
]);
const factory = parseAbi([
  "function deployProxy(address,uint256,bytes) returns (address)",
  "function predictProxyAddress(address,uint256) view returns (address)",
]);
const initAbi = parseAbi([
  "function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)",
  "function initialize((address account, uint256 roleBitmap)[] grants)",
]);
const resolver = parseAbi([
  "function setText(bytes,string,string)",
  "function setAddress(bytes,uint256,bytes)",
]);
const universal = parseAbi(["function resolve(bytes,bytes) view returns (bytes, address)"]);
const addrAbi = parseAbi(["function addr(bytes32,uint256) view returns (bytes)", "function text(bytes32,string) view returns (string)"]);

const { values: opt } = parseArgs({
  options: {
    "owner-key-file": { type: "string" }, "verifier-key-file": { type: "string" },
    rpc: { type: "string", default: "https://ethereum-sepolia-rpc.publicnode.com" }, out: { type: "string", default: "sepolia.json" },
  },
});
if (!opt["owner-key-file"] || !opt["verifier-key-file"]) {
  console.error("usage: node scripts/sepolia-setup.mjs --owner-key-file <file> --verifier-key-file <file> [--rpc url] [--out sepolia.json]");
  process.exit(2);
}

const readKey = (file) => {
  const line = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const hex = line.slice(line.lastIndexOf("=") + 1).trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${file}: no private key found`);
  return hex.startsWith("0x") ? hex : `0x${hex}`;
};
if (!existsSync(opt["verifier-key-file"])) writeFileSync(opt["verifier-key-file"], generatePrivateKey() + "\n", { mode: 0o600 });

const owner = privateKeyToAccount(readKey(opt["owner-key-file"]));
const verifier = privateKeyToAccount(readKey(opt["verifier-key-file"]));
const transport = http(opt.rpc);
const client = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ chain: sepolia, transport, account: owner });

const out = existsSync(opt.out) ? JSON.parse(readFileSync(opt.out, "utf8")) : {};
Object.assign(out, { chainId: sepolia.id, contracts: A, owner: owner.address, verifier: verifier.address, names: out.names ?? {}, txs: out.txs ?? {} });
const save = () => writeFileSync(opt.out, JSON.stringify(out, null, 2) + "\n");
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const dns = (name) => toHex(packetToBytes(name));

/** Simulate, send, wait; record the tx under `label`. */
async function send(label, address, abi, functionName, args, w = wallet) {
  const { request } = await client.simulateContract({ address, abi, functionName, args, account: w.account });
  const hash = await w.writeContract(request);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label}: reverted in ${hash}`);
  out.txs[label] = hash;
  save();
  console.log(`  ${label}: ${hash}`);
  return r;
}

/** A proxy owned by `owner` with every role, at a deterministic address. */
async function deployProxy(label, impl, saltTag, data) {
  const salt = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }], [keccak256(toBytes(saltTag)), owner.address, label.endsWith(".eth") ? namehash(label) : keccak256(toBytes(label))])));
  const at = await client.readContract({ address: A.factory, abi: factory, functionName: "predictProxyAddress", args: [owner.address, salt] });
  if ((await client.getCode({ address: at }))?.length > 2) return at;
  await send(`deploy ${saltTag} for ${label}`, A.factory, factory, "deployProxy", [impl, salt, data]);
  return at;
}

const grants = [{ account: owner.address, roleBitmap: ALL_ROLES }];
const resolverInit = encodeFunctionData({ abi: initAbi, functionName: "initialize", args: [grants, []] });
const registryInit = encodeFunctionData({ abi: [initAbi[1]], functionName: "initialize", args: [grants] });

console.log(`owner ${owner.address} · verifier ${verifier.address}`);

// 0. gas for the verifier (it publishes verdicts itself)
if ((await client.getBalance({ address: verifier.address })) < parseEther("0.001")) {
  const hash = await wallet.sendTransaction({ to: verifier.address, value: parseEther("0.003") });
  await client.waitForTransactionReceipt({ hash });
  out.txs["fund verifier"] = hash;
  save();
  console.log(`  fund verifier: ${hash}`);
}

// 1. contracts the names point at: one resolver each, and canary.eth's subregistry
const dappResolver = await deployProxy(`${DAPP}.eth`, A.resolverImpl, "PermissionedResolver", resolverInit);
const canaryResolver = await deployProxy(`${NAMESPACE}.eth`, A.resolverImpl, "PermissionedResolver", resolverInit);
const canaryRegistry = await deployProxy(`${NAMESPACE}.eth`, A.userRegistryImpl, "UserRegistry", registryInit);
out.names[`${DAPP}.eth`] = { resolver: dappResolver };
out.names[`${NAMESPACE}.eth`] = { resolver: canaryResolver, subregistry: canaryRegistry };
save();

// 2. register the two .eth names (commit, wait, pay, register)
const want = [
  { label: DAPP, subregistry: zeroAddress, resolver: dappResolver },
  { label: NAMESPACE, subregistry: canaryRegistry, resolver: canaryResolver },
];
const todo = [];
for (const n of want) {
  const holder = await client.readContract({ address: A.ethRegistry, abi: registry, functionName: "findOwner", args: [n.label] });
  if (same(holder, owner.address)) continue;
  if (!(await client.readContract({ address: A.ethRegistrar, abi: registrar, functionName: "isAvailable", args: [n.label] }))) throw new Error(`${n.label}.eth is taken (owner ${holder})`);
  todo.push({ ...n, secret: keccak256(toBytes(`${owner.address}:${n.label}:${Date.now()}:${Math.random()}`)) });
}
if (todo.length) {
  let total = 0n;
  for (const n of todo) {
    const [base, premium] = await client.readContract({ address: A.ethRegistrar, abi: registrar, functionName: "getRegisterPrice", args: [n.label, DURATION, A.usdc] });
    total += base + premium;
    n.commitment = await client.readContract({ address: A.ethRegistrar, abi: registrar, functionName: "makeCommitment", args: [n.label, owner.address, n.secret, n.subregistry, n.resolver, DURATION, toHex(0, { size: 32 })] });
    await send(`commit ${n.label}.eth`, A.ethRegistrar, registrar, "commit", [n.commitment]);
  }
  if ((await client.readContract({ address: A.usdc, abi: erc20, functionName: "balanceOf", args: [owner.address] })) < total)
    await send("mint MockUSDC", A.usdc, erc20, "mint", [owner.address, total]);
  if ((await client.readContract({ address: A.usdc, abi: erc20, functionName: "allowance", args: [owner.address, A.ethRegistrar] })) < total)
    await send("approve MockUSDC", A.usdc, erc20, "approve", [A.ethRegistrar, total]);
  const age = await client.readContract({ address: A.ethRegistrar, abi: registrar, functionName: "MIN_COMMITMENT_AGE" });
  for (const n of todo) {
    const at = await client.readContract({ address: A.ethRegistrar, abi: registrar, functionName: "commitmentAt", args: [n.commitment] });
    for (;;) {
      const { timestamp } = await client.getBlock();
      if (timestamp > at + age) break;
      console.log(`  waiting ${at + age - timestamp + 1n}s for the ${n.label}.eth commitment to age`);
      await new Promise((r) => setTimeout(r, Number(at + age - timestamp + 2n) * 1000));
    }
    await send(`register ${n.label}.eth`, A.ethRegistrar, registrar, "register", [n.label, owner.address, n.secret, n.subregistry, n.resolver, DURATION, A.usdc, toHex(0, { size: 32 })]);
  }
}

// 3. canary.eth's subregistry knows its place, and holds verifier.canary.eth for the verifier key
const [parent, childLabel] = await client.readContract({ address: canaryRegistry, abi: registry, functionName: "getParent" });
if (!same(parent, A.ethRegistry) || childLabel !== NAMESPACE) await send("setParent canary registry", canaryRegistry, registry, "setParent", [A.ethRegistry, NAMESPACE]);
if (!same(await client.readContract({ address: canaryRegistry, abi: registry, functionName: "findOwner", args: [VERIFIER] }), verifier.address)) {
  const expiry = await client.readContract({ address: A.ethRegistry, abi: registry, functionName: "findExpiry", args: [NAMESPACE] });
  await send(`register ${VERIFIER}.${NAMESPACE}.eth`, canaryRegistry, registry, "register", [VERIFIER, verifier.address, zeroAddress, canaryResolver, NAME_OWNER_ROLES, expiry]);
}

// 4. records the setup owns: the verifier's addr; canary.eth points at the code
const verifierName = `${VERIFIER}.${NAMESPACE}.eth`;
/** A record through the Universal Resolver, decoded; null if the name doesn't resolve yet. */
const record = async (name, functionName, args) => {
  try {
    const [res] = await client.readContract({ address: A.universalResolver, abi: universal, functionName: "resolve", args: [dns(name), encodeFunctionData({ abi: addrAbi, functionName, args: [namehash(name), ...args] })] });
    return res === "0x" ? null : decodeFunctionResult({ abi: addrAbi, functionName, data: res });
  } catch {
    return null;
  }
};
if (!same(await record(verifierName, "addr", [COIN_ETH]), verifier.address))
  await send(`addr ${verifierName}`, canaryResolver, resolver, "setAddress", [dns(verifierName), COIN_ETH, verifier.address]);
for (const [key, value] of [["url", "https://github.com/SCARPxVeNOM/canary_repo"], ["description", "Canary: privacy checks for dapps and agents"]])
  if ((await record(`${NAMESPACE}.eth`, "text", [key])) !== value) await send(`text ${NAMESPACE}.eth ${key}`, canaryResolver, resolver, "setText", [dns(`${NAMESPACE}.eth`), key, value]);

out.names[verifierName] = { owner: verifier.address, resolver: canaryResolver, addr: verifier.address, labelhash: labelhash(VERIFIER) };
save();
console.log(JSON.stringify(out.names, null, 2));
