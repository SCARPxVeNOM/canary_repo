/* The test wallet for the live runs: EIP-1193 + EIP-6963 in the page, signing
   in Node with a key from a file. It stands in for MetaMask, so it broadcasts
   through its own RPC, as a wallet does, and Canary doesn't see the send.
   The key is never printed. */

import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

export function readKey(file) {
  const line = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const hex = line.slice(line.lastIndexOf("=") + 1).trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${file}: no private key found`);
  return hex.startsWith("0x") ? hex : `0x${hex}`;
}

/** Installs the wallet in every page of `ctx`. `onTx({ hash, to, selector })` is called for each transaction it sends. */
export async function installWallet(ctx, { keyFile, rpc, onTx = () => {} }) {
  const account = privateKeyToAccount(readKey(keyFile));
  const transport = http(rpc);
  const client = createPublicClient({ chain: sepolia, transport });
  const wallet = createWalletClient({ chain: sepolia, transport, account });

  await ctx.addInitScript(() => {
    const listeners = {};
    const provider = {
      isCanarySwapTest: true,
      request: ({ method, params }) =>
        window.__swapTestWallet(method, params ?? []).then((r) => {
          if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
          return r.result;
        }),
      on(e, f) { (listeners[e] = listeners[e] || []).push(f); return provider; },
      removeListener(e, f) { listeners[e] = (listeners[e] || []).filter((x) => x !== f); return provider; },
    };
    const info = Object.freeze({ uuid: "0b1d6c3e-7a51-4f0e-9d7a-5a9c2b7e1c11", name: "Canary Swap test wallet", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/%3E", rdns: "xyz.canary.swaptest" });
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
    window.ethereum = provider;
  });

  // A load-balanced RPC can answer "pending" from a node a block behind, so
  // the next nonce is never below the one after the last transaction sent.
  let next = 0;
  await ctx.exposeFunction("__swapTestWallet", async (method, params) => {
    try {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return { result: [account.address] };
        case "eth_chainId":
          return { result: `0x${sepolia.id.toString(16)}` };
        case "wallet_switchEthereumChain":
          return { result: null };
        case "eth_sendTransaction": {
          const [tx] = params;
          const nonce = Math.max(next, await client.getTransactionCount({ address: account.address, blockTag: "pending" }));
          const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), nonce });
          next = nonce + 1;
          onTx({ hash, to: tx.to, selector: tx.data?.slice(0, 10) });
          return { result: hash };
        }
        default: {
          const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
          return await r.json();
        }
      }
    } catch (e) {
      return { error: { code: e.code ?? -32603, message: e.shortMessage ?? e.message } };
    }
  });
  return { account, client };
}

/** What each transaction the page sends is, by selector. */
export const TX_LABEL = {
  "0x3593564c": "Universal Router: execute (V4_SWAP)",
  "0x87517c45": "Permit2: approve the Universal Router",
  "0x095ea7b3": "CNRY: approve Permit2",
  "0x40c10f19": "CNRY: mint",
};
