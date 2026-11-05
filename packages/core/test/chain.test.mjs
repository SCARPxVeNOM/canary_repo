// Chain detection from RPC URLs (src/domain.ts).
//   npm test -w @canary/core
import { test } from "node:test";
import assert from "node:assert/strict";
import { chainHintFromUrl, knownChain } from "../dist/index.js";

test("Uniswap's own RPC proxy: chain from the path (it refuses probes over Tor)", () => {
  assert.equal(knownChain("https://entry-gateway.backend-prod.api.uniswap.org/rpc/1"), 1);
  assert.equal(knownChain("https://entry-gateway.backend-prod.api.uniswap.org/rpc/8453"), 8453);
  assert.equal(knownChain("https://entry-gateway.backend-prod.api.uniswap.org/v2/quote"), undefined);
  assert.equal(knownChain("https://evil.example/entry-gateway.backend-prod.api.uniswap.org/rpc/1"), undefined);
});

test("well-known providers still resolve from the URL", () => {
  assert.equal(knownChain("https://eth-sepolia.g.alchemy.com/v2/KEY"), 11155111);
  assert.equal(knownChain("https://lb.drpc.live/ethereum/KEY"), 1);
  assert.equal(knownChain("https://rpc.unknown.example/"), undefined);
});

test("URL hints are strict: a chain-like segment or query, nothing looser", () => {
  assert.equal(chainHintFromUrl("https://api.dapp.example/rpc/10"), 10);
  assert.equal(chainHintFromUrl("https://api.dapp.example/chains/42161/rpc"), 42161);
  assert.equal(chainHintFromUrl("https://api.dapp.example/rpc?chainId=8453"), 8453);
  assert.equal(chainHintFromUrl("https://api.dapp.example/v1/123/data"), undefined);
  assert.equal(chainHintFromUrl("https://api.dapp.example/rpc"), undefined);
});
