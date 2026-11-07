/* Placeholder content: what the screens show until they're wired up.
   Every value has the shape the real source returns (see types.ts):
     STATUS          GET  /canary/status
     REPORT          GET  /canary/report
     EVENTS          GET  /canary/events (one item per server-sent event)
     LOOKUP_RESULT   readAgentPrivacy(client, name) from @ayush_saklani/canary-ens
   Replace these with real calls; the components only take props. */

import type { AgentPrivacy, Egress, GatewayStatus, Manifest, SignedReport } from "./types";

export const AGENT = "trader-01.agents.canary.eth";
const POLICY_HASH = "0x2297952e9c41f0b8d6a3e5f71c2b4d8a9e0f3c6b5a4d7e8f9a0b1c2d3e4f5a6b";
const REPORTER = "0x9E4b5C3d2A1f0e9D8c7B6a5F4e3D2c1B0a9F8e7D";
const WALLET_1 = "0x5Ca1ab1e00000000000000000000000000C0FfEe";
const WALLET_2 = "0x7a11e70000000000000000000000000000Be3F00";

export const STATUS: GatewayStatus = {
  version: "0.1.0",
  agent: AGENT,
  policyHash: POLICY_HASH,
  backend: { backend: "chromium", network: "tor-js", state: "ready", bootMs: 14_200, restarts: 0 },
  chains: ["1", "11155111"],
  wallets: 2,
  undeclared: "block",
  llmAllow: ["0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"],
  jitterMs: 0,
  mitm: { enabled: false },
  ens: {
    name: AGENT,
    chainId: 11155111,
    manifest: { source: "ens", state: "loaded", loadedAt: Date.UTC(2026, 10, 6, 10, 2) },
    reporter: REPORTER,
    reportRole: "granted",
    reporterDeclared: true,
    lastPublish: {
      at: Date.UTC(2026, 10, 6, 9, 0),
      tx: "0x8f3a1c9e2b7d4f6a0c5e8b1d3f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a",
      reportHash: "0x4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a8f3a1c9e2b7d4f6a0c5e8b1d3f7a9c2e",
    },
  },
};

export const REPORT: SignedReport = {
  report: {
    agent: AGENT,
    policyHash: POLICY_HASH,
    gatewayVersion: "0.1.0",
    window: [Date.UTC(2026, 10, 6, 0, 0) / 1000, Date.UTC(2026, 10, 6, 10, 42) / 1000],
    rpc: { total: 1840, protected: 1774, ipOnly: 28, direct: 0, blocked: 0, failedClosed: 38, linked: 2 },
    http: { anon: 46, direct: 210, blocked: 12, undeclared: 0, notInspected: 3, failedClosed: 0 },
    llm: { requests: 210, addressesPseudonymized: 388 },
    latencyMs: { p50: 1080, p95: 2310 },
    hosts: {
      "ethereum-sepolia-rpc.publicnode.com": { protected: 1402, failedClosed: 30 },
      "ethereum-rpc.publicnode.com": { protected: 372, failedClosed: 8 },
      "1rpc.io": { protectedIpOnly: 28 },
      "api.coingecko.com": { protected: 46 },
      "api.anthropic.com": { direct: 210, pseudonymized: 388 },
      "telemetry.example-sdk.io": { blocked: 9 },
      "api.etherscan.io": { blocked: 3 },
      "cdn.example-assets.net": { notInspected: 3 },
    },
  },
  reportHash: "0x4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a8f3a1c9e2b7d4f6a0c5e8b1d3f7a9c2e",
  signer: REPORTER,
  signature:
    "0x1b6e4f2a9c8d7e3b5a0f1c2d4e6b8a9c0d3e5f7a1b2c4d6e8f0a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d1e3f5a7b9c2d4e6f8a0b1c3d5e7f9a2b4c6d8e0f1a3b51c",
};

const T0 = Date.UTC(2026, 10, 6, 10, 41, 12);
const at = (s: number) => T0 + s * 1000;

/** Newest first, as a live feed shows them. */
export const EVENTS: Egress[] = [
  { at: at(47), category: "protected", channel: "rpc", host: "ethereum-sepolia-rpc.publicnode.com", methods: ["eth_call"], address: WALLET_1, ms: 912 },
  { at: at(46), category: "pseudonymized", channel: "llm", host: "api.anthropic.com", count: 3, note: "3 addresses → WALLET_1, ADDR_4, HASH_2" },
  { at: at(45), category: "direct", channel: "llm", host: "api.anthropic.com", note: "declared direct (keyed provider)" },
  { at: at(44), category: "protected", channel: "rpc", host: "ethereum-sepolia-rpc.publicnode.com", methods: ["eth_getBalance", "eth_call"], address: WALLET_1, ms: 1104 },
  { at: at(41), category: "blocked", channel: "proxy", host: "telemetry.example-sdk.io", note: "not in the manifest" },
  { at: at(39), category: "protected", channel: "sdk", host: "api.coingecko.com", ms: 1380 },
  { at: at(36), category: "protected", channel: "rpc", host: "ethereum-sepolia-rpc.publicnode.com", methods: ["eth_blockNumber"], ms: 841 },
  { at: at(33), category: "protectedIpOnly", channel: "rpc", host: "1rpc.io", methods: ["eth_feeHistory"], ms: 1520 },
  { at: at(30), category: "protected", channel: "rpc", host: "ethereum-rpc.publicnode.com", methods: ["eth_call"], address: WALLET_2, ms: 978 },
  { at: at(27), category: "failedClosed", channel: "rpc", host: "ethereum-sepolia-rpc.publicnode.com", methods: ["eth_getLogs"], note: "anon path timed out; not sent directly" },
  { at: at(22), category: "blocked", channel: "connect", host: "api.etherscan.io", address: WALLET_1, note: "not in the manifest" },
  { at: at(19), category: "protected", channel: "rpc", host: "ethereum-sepolia-rpc.publicnode.com", methods: ["eth_getTransactionCount"], address: WALLET_1, ms: 1012 },
  { at: at(15), category: "pseudonymized", channel: "llm", host: "api.anthropic.com", count: 2, note: "2 addresses → WALLET_1, WALLET_2" },
  { at: at(14), category: "direct", channel: "llm", host: "api.anthropic.com", note: "declared direct (keyed provider)" },
  { at: at(9), category: "notInspected", channel: "connect", host: "cdn.example-assets.net", note: "HTTPS body not inspected (no local CA)" },
  { at: at(4), category: "protected", channel: "rpc", host: "ethereum-sepolia-rpc.publicnode.com", methods: ["eth_chainId", "eth_blockNumber"], ms: 866 },
];

/** The before/after the LLM panel shows. */
export const PSEUDONYM_EXAMPLE = {
  before: `Wallet ${WALLET_1} holds 0.42 ETH and 1,250 USDC. Should it swap?`,
  after: "Wallet WALLET_1 holds 0.42 ETH and 1,250 USDC. Should it swap?",
};

const MANIFEST: Manifest = {
  v: 1,
  agent: AGENT,
  hosts: {
    "ethereum-sepolia-rpc.publicnode.com": "anon",
    "ethereum-rpc.publicnode.com": "anon",
    "api.coingecko.com": "anon",
    "api.anthropic.com": "direct",
    "*.etherscan.io": "block",
  },
  undeclared: "block",
  rpc: { write: "anon" },
  reporter: REPORTER,
  wallets: "undisclosed",
  llm: { allow: ["0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"] },
};

export const LOOKUP_RESULT: AgentPrivacy = {
  name: AGENT,
  resolver: "0x3D2c1B0a9F8e7D6c5B4a3F2e1D0c9B8a7F6e5D4c",
  manifest: MANIFEST,
  report: {
    agent: AGENT,
    policyHash: POLICY_HASH,
    reportHash: "0x4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a8f3a1c9e2b7d4f6a0c5e8b1d3f7a9c2e",
    days: [Date.UTC(2026, 10, 6) / 86_400_000, Date.UTC(2026, 10, 6) / 86_400_000],
    rpcViaAnonPct: 98,
    rpcVolume: "1000-9999",
    failedClosed: "10-99",
    blocked: "10-99",
    undeclared: "0",
    notInspected: "1-9",
    llmAddressesPseudonymized: "100-999",
    signer: REPORTER,
    signature: REPORT.signature!,
  },
  checks: { reportSigned: true, signerIsReporter: true, policyMatches: true, reporterCanWrite: true, reporterRevoked: false },
  roleChanges: [
    {
      resource: 0n,
      oldRoleBitmap: 0n,
      newRoleBitmap: 16n,
      textRole: "granted",
      blockNumber: 12_071_204n,
      transactionHash: "0x2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a8f3a1c9e2b7d4f6a0c5e8b1d3f7a9c",
    },
  ],
};

/** A lookup whose report doesn't hold up, for the error styling. */
export const LOOKUP_RESULT_BAD: AgentPrivacy = {
  ...LOOKUP_RESULT,
  name: "scout-07.agents.canary.eth",
  checks: { reportSigned: true, signerIsReporter: false, policyMatches: false, reporterCanWrite: false, reporterRevoked: true },
  roleChanges: [
    ...LOOKUP_RESULT.roleChanges!,
    { resource: 0n, oldRoleBitmap: 16n, newRoleBitmap: 0n, textRole: "revoked", blockNumber: 12_088_940n, transactionHash: "0x7d9f2a4c6e8b0d1f3a8f3a1c9e2b7d4f6a0c5e8b1d3f7a9c2e4b6d8f0a1c3e5b" },
  ],
};
