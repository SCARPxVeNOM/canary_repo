// Local test chain: ganache (HTTP, chainId 11155111) + the mock ENSv2 contracts.
// Exported for the gateway's ENS tests too.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import ganache from "ganache";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { packetToBytes } from "viem/ens";
import { toHex } from "viem";

const require = createRequire(import.meta.url);
const HERE = import.meta.dirname;

// ganache --wallet.deterministic keys
export const KEYS = {
  owner: "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d",
  reporter: "0x6cbed15c793ce57650b9877cf6fa156fbef513c4e6134f022a85b1ffdd59b2a1",
  stranger: "0x6370fd033278c143179d81c5526140625662b8daa446c22ee2d73db3707e620c",
};

let compiled;
function compile() {
  if (compiled) return compiled;
  const solc = require("solc");
  return readFile(resolve(HERE, "contracts/Mocks.sol"), "utf8").then((src) => {
    const out = JSON.parse(
      solc.compile(JSON.stringify({ language: "Solidity", sources: { "Mocks.sol": { content: src } }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })),
    );
    const errs = (out.errors ?? []).filter((e) => e.severity === "error");
    if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
    const c = out.contracts["Mocks.sol"];
    compiled = {
      resolver: { abi: c.MockPermissionedResolver.abi, bytecode: "0x" + c.MockPermissionedResolver.evm.bytecode.object },
      universal: { abi: c.MockUniversalResolver.abi, bytecode: "0x" + c.MockUniversalResolver.evm.bytecode.object },
    };
    return compiled;
  });
}

export const chain = defineChain({ id: 11155111, name: "local sepolia", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://unused.invalid"] } } });

export async function startChain() {
  const c = await compile();
  const server = ganache.server({ wallet: { deterministic: true }, chain: { chainId: 11155111 }, logging: { quiet: true }, miner: { instamine: "eager" } });
  await server.listen(0, "127.0.0.1");
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = createPublicClient({ chain, transport: http(url) });
  const wallet = (key) => createWalletClient({ chain, transport: http(url), account: privateKeyToAccount(key) });
  const owner = wallet(KEYS.owner);

  const deploy = async (art, args) => {
    const hash = await owner.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
    return (await client.waitForTransactionReceipt({ hash })).contractAddress;
  };
  const universal = await deploy(c.universal, []);

  /** Deploy a resolver for `name` (one of the two delegation APIs) and register it with the universal resolver. */
  async function nameWithResolver(name, { setterApi = false } = {}) {
    const resolver = await deploy(c.resolver, [setterApi]);
    const hash = await owner.writeContract({ address: universal, abi: c.universal.abi, functionName: "setResolver", args: [toHex(packetToBytes(name)), resolver] });
    await client.waitForTransactionReceipt({ hash });
    return resolver;
  }

  return { url, client, wallet, owner, universal, nameWithResolver, address: (k) => privateKeyToAccount(k).address, close: () => server.close() };
}
