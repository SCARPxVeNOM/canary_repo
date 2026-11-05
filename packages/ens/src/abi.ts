/* The parts of ENSv2's Permissioned Resolver and Enhanced Access Control that
   Canary uses. Sources: docs.ens.domains/ensv2/permissioned-resolver,
   .../enhanced-access-control and .../indexing (Nov 2026).

   ENSv2 is still moving: the docs show two ways to delegate one text key
   (`authorizeTextRoles(name, key, account, grant)` and, on the newer contracts
   page, `grantSetterRoles(setterCalldata, account)` / `revokeRoles`). Canary
   detects which one a resolver accepts (write.ts) and checks write access by
   simulating `setText`, which works the same either way. */

export const ROLE_SET_TEXT = 1n << 4n;
export const ROOT_RESOURCE = 0n;

export const TEXT_KEYS = {
  manifest: "privacy.manifest",
  report: "privacy.report",
} as const;

export const permissionedResolverAbi = [
  {
    type: "function",
    name: "setText",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "bytes" },
      { name: "key", type: "string" },
      { name: "value", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "hasRoles",
    stateMutability: "view",
    inputs: [
      { name: "resource", type: "uint256" },
      { name: "roleBitmap", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "authorizeTextRoles",
    stateMutability: "nonpayable",
    inputs: [
      { name: "toName", type: "bytes" },
      { name: "key", type: "string" },
      { name: "account", type: "address" },
      { name: "grant", type: "bool" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "grantSetterRoles",
    stateMutability: "nonpayable",
    inputs: [
      { name: "setter", type: "bytes" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "revokeRoles",
    stateMutability: "nonpayable",
    inputs: [
      { name: "resource", type: "uint256" },
      { name: "roleBitmap", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "EACRolesChanged",
    inputs: [
      { name: "resource", type: "uint256", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "oldRoleBitmap", type: "uint256", indexed: false },
      { name: "newRoleBitmap", type: "uint256", indexed: false },
    ],
  },
] as const;
