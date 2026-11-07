// Chain detection from RPC URLs (src/domain.ts).
//   npm test -w @ayush_saklani/canary-core
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

test("each provider's own network names, read from where it puts them", () => {
  assert.equal(knownChain("https://mainnet.infura.io/v3/KEY"), 1);
  assert.equal(knownChain("https://polygon-mainnet.infura.io/v3/KEY"), 137);
  assert.equal(knownChain("https://polygon-bor-rpc.publicnode.com"), 137);
  assert.equal(knownChain("https://bsc-rpc.publicnode.com"), 56);
  assert.equal(knownChain("https://rpc.ankr.com/eth_sepolia/KEY"), 11155111);
  assert.equal(knownChain("https://1rpc.io/avax/c"), 43114);
  assert.equal(knownChain("https://lb.drpc.org/ogrpc?network=base&dkey=KEY"), 8453);
  assert.equal(knownChain("https://zksync.drpc.org"), 324);
});

test("never another chain's id for an L2 or testnet URL (its reads would get the wrong chain's answers)", () => {
  assert.equal(knownChain("https://linea-mainnet.infura.io/v3/KEY"), 59144);
  assert.equal(knownChain("https://zksync-mainnet.g.alchemy.com/v2/KEY"), 324);
  assert.equal(knownChain("https://bnb-mainnet.g.alchemy.com/v2/KEY"), 56);
  assert.equal(knownChain("https://polygon-amoy.g.alchemy.com/v2/KEY"), 80002);
  assert.equal(knownChain("https://arbnova-mainnet.g.alchemy.com/v2/KEY"), 42170);
  // not listed: probed instead of guessed
  assert.equal(knownChain("https://palm-mainnet.infura.io/v3/KEY"), undefined);
  assert.equal(knownChain("https://somechain-mainnet.g.alchemy.com/v2/KEY"), undefined);
  assert.equal(knownChain("https://rpc.example/ethereum-mainnet"), undefined);
});

test("URL hints are strict: a chain-like segment or query, nothing looser", () => {
  assert.equal(chainHintFromUrl("https://api.dapp.example/rpc/10"), 10);
  assert.equal(chainHintFromUrl("https://api.dapp.example/chains/42161/rpc"), 42161);
  assert.equal(chainHintFromUrl("https://api.dapp.example/rpc?chainId=8453"), 8453);
  assert.equal(chainHintFromUrl("https://api.dapp.example/v1/123/data"), undefined);
  assert.equal(chainHintFromUrl("https://api.dapp.example/rpc"), undefined);
});

test("URL hints read a network's name or a /web3/<id> path", () => {
  // Compound's own node proxy (seen 7 Nov), and 1inch's web3 proxy shape
  assert.equal(chainHintFromUrl("https://node-provider-v3-app.compound.xyz/ethereum-mainnet"), 1);
  assert.equal(chainHintFromUrl("https://proxy-app.dapp.example/v2.0/web3/1"), 1);
  assert.equal(chainHintFromUrl("https://api.dapp.example/node/arbitrum-one"), 42161);
  assert.equal(chainHintFromUrl("https://api.dapp.example/rpc/base-sepolia/"), 84532);
  assert.equal(chainHintFromUrl("https://api.dapp.example/jsonrpc?network=polygon"), 137);
  // the last segment, whole: names inside other words, or earlier in the path, aren't networks
  assert.equal(chainHintFromUrl("https://api.dapp.example/database/basement"), undefined);
  assert.equal(chainHintFromUrl("https://api.dapp.example/base/v1/prices"), undefined);
  assert.equal(chainHintFromUrl("https://api.dapp.example/v1/prices"), undefined);
});
