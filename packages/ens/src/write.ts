/* Writing records and managing the one-key role (docs/agent-sdk.md §4).

   - canWriteText: simulates setText from an account. Works whichever
     delegation API the resolver has, and is how Canary detects revocation.
   - grantTextKey / revokeTextKey: detect the API by simulation, then send.
   - roleHistory: EACRolesChanged events for an account (revocation is
     visible on chain: "the only way to silence the reporter is to revoke"). */

import { encodeFunctionData, keccak256, parseEventLogs, toBytes, toHex, type Account, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from "viem";
import { packetToBytes } from "viem/ens";
import { normalize } from "viem/ens";
import { permissionedResolverAbi, ROLE_SET_TEXT } from "./abi.js";

export const dnsEncode = (name: string): Hex => toHex(packetToBytes(normalize(name)));

const short = (e: unknown) => {
  const err = e as any;
  return String(err?.shortMessage ?? err?.message ?? e).split("\n")[0]!;
};

export async function canWriteText(client: PublicClient, resolver: Address, name: string, key: string, account: Address, blockNumber?: bigint): Promise<{ ok: boolean; reason?: string }> {
  try {
    await client.simulateContract({ address: resolver, abi: permissionedResolverAbi, functionName: "setText", args: [dnsEncode(name), key, ""], account, ...(blockNumber === undefined ? {} : { blockNumber }) });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: short(e) };
  }
}

type Writer = { wallet: WalletClient; client: PublicClient };
const accountOf = (w: WalletClient): Account => {
  if (!w.account) throw new TypeError("wallet client has no account");
  return w.account;
};

export async function setTextRecord({ wallet, client }: Writer, resolver: Address, name: string, key: string, value: string): Promise<Hash> {
  const account = accountOf(wallet);
  const { request } = await client.simulateContract({ address: resolver, abi: permissionedResolverAbi, functionName: "setText", args: [dnsEncode(name), key, value], account });
  const hash = await wallet.writeContract(request as any);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`setText(${key}) reverted in ${hash}`);
  return hash;
}

export type DelegationApi = "authorizeTextRoles" | "grantSetterRoles";

/** Grant `account` the right to write one text key (and nothing else) on `name`. */
export async function grantTextKey({ wallet, client }: Writer, resolver: Address, name: string, key: string, grantee: Address): Promise<{ hash: Hash; api: DelegationApi }> {
  const account = accountOf(wallet);
  const attempts: { api: DelegationApi; functionName: any; args: any }[] = [
    {
      api: "grantSetterRoles",
      functionName: "grantSetterRoles",
      args: [encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setText", args: [dnsEncode(name), key, ""] }), grantee],
    },
    { api: "authorizeTextRoles", functionName: "authorizeTextRoles", args: [dnsEncode(name), key, grantee, true] },
  ];
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      const { request } = await client.simulateContract({ address: resolver, abi: permissionedResolverAbi, functionName: a.functionName, args: a.args, account });
      const hash = await wallet.writeContract(request as any);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`reverted in ${hash}`);
      return { hash, api: a.api };
    } catch (e) {
      errors.push(`${a.api}: ${short(e)}`);
    }
  }
  throw new Error(`could not delegate ${key} on ${name}:\n  ${errors.join("\n  ")}`);
}

/** Revoke what grantTextKey granted. */
export async function revokeTextKey({ wallet, client }: Writer, resolver: Address, name: string, key: string, grantee: Address): Promise<{ hash: Hash; api: DelegationApi }> {
  const account = accountOf(wallet);
  const attempts: { api: DelegationApi; functionName: any; args: any }[] = [
    // newer API: the text-key resource is keccak256(bytes(key)) (contracts docs)
    { api: "grantSetterRoles", functionName: "revokeRoles", args: [BigInt(keccak256(toBytes(key))), ROLE_SET_TEXT, grantee] },
    { api: "authorizeTextRoles", functionName: "authorizeTextRoles", args: [dnsEncode(name), key, grantee, false] },
  ];
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      const { request } = await client.simulateContract({ address: resolver, abi: permissionedResolverAbi, functionName: a.functionName, args: a.args, account });
      const hash = await wallet.writeContract(request as any);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`reverted in ${hash}`);
      // A no-op revoke (wrong resource formula) succeeds without changing anything: confirm it took,
      // from the receipt's EACRolesChanged, else by reading at its block (a load-balanced RPC's
      // "latest" can be a block behind the receipt).
      const took = parseEventLogs({ abi: permissionedResolverAbi, eventName: "EACRolesChanged", logs: receipt.logs }).some(
        (l) => l.address.toLowerCase() === resolver.toLowerCase() && l.args.account.toLowerCase() === grantee.toLowerCase() && (l.args.oldRoleBitmap & ROLE_SET_TEXT) !== 0n && (l.args.newRoleBitmap & ROLE_SET_TEXT) === 0n,
      );
      if (!took && (await canWriteText(client, resolver, name, key, grantee, receipt.blockNumber)).ok) throw new Error("transaction succeeded but the account can still write");
      return { hash, api: a.api };
    } catch (e) {
      errors.push(`${a.api}: ${short(e)}`);
    }
  }
  throw new Error(`could not revoke ${key} on ${name}:\n  ${errors.join("\n  ")}`);
}

export type RoleChange = {
  resource: bigint;
  oldRoleBitmap: bigint;
  newRoleBitmap: bigint;
  /** what happened to ROLE_SET_TEXT in this change */
  textRole: "granted" | "revoked" | "unchanged";
  blockNumber: bigint;
  transactionHash: Hash;
};

/** EACRolesChanged events for `account` on the resolver. */
export async function roleHistory(client: PublicClient, resolver: Address, account: Address, fromBlock: bigint = 0n): Promise<RoleChange[]> {
  const logs = await client.getContractEvents({ address: resolver, abi: permissionedResolverAbi, eventName: "EACRolesChanged", args: { account }, fromBlock, toBlock: "latest" });
  return logs.map((l: any) => {
    const had = (l.args.oldRoleBitmap & ROLE_SET_TEXT) !== 0n;
    const has = (l.args.newRoleBitmap & ROLE_SET_TEXT) !== 0n;
    return {
      resource: l.args.resource,
      oldRoleBitmap: l.args.oldRoleBitmap,
      newRoleBitmap: l.args.newRoleBitmap,
      textRole: had === has ? "unchanged" : has ? "granted" : "revoked",
      blockNumber: l.blockNumber,
      transactionHash: l.transactionHash,
    };
  });
}
