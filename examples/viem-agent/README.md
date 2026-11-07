# Example: a viem agent behind Canary

A minimal agent loop on Sepolia: read ETH/USDC balances, ask an LLM, print what Canary decided. The same agent can run without Canary (`--leaky`) for the demo's before/after.

```sh
# from the repo root, once
npm install && npm run build

cd examples/viem-agent
npm run gateway                                     # terminal 1: tor-js boots in ~8–13 s (needs a tor-js gateway: main README, Quick start step 1)
npm run gateway:local                               # or through your own gateways (below)
WALLET=0x… OPENAI_API_KEY=sk-… npm run agent         # terminal 2 (no key: prints the redacted prompt)
WALLET=0x… npm run agent:leaky                       # same agent, no Canary: direct RPC, raw prompt
```

On Windows (cmd), set variables first: `set WALLET=0x…` then `npm run agent`.

| File | What |
|---|---|
| `agent.mjs` | the agent. The only line that differs between the two modes is the viem transport (plus `llmFetch` for the LLM call) |
| `swap.mjs` | the agent swaps on Uniswap v4 through the gateway (below) |
| `canary.config.json` | gateway config: tor-js (same as the extension's `config/live.json`), Sepolia + mainnet read endpoints, local manifest |
| `manifest.json` | the policy: LLM hosts `direct` (keyed; addresses pseudonymized), `api.coingecko.com` `anon`, everything else blocked; Sepolia USDC and WETH allow-listed for the LLM |
| `canary.ens.config.json` | the same gateway, but the policy comes from the agent's ENSv2 name (below) |
| `canary.local.config.json`, `canary.ens.local.config.json` | the same two, through three tor-js gateways run on this machine |

Notes:
- **Chrome:** the configs use your installed Chrome (`"channel": "chrome"`). Or set `"executablePath"`, or run `npx playwright install chromium` and remove `channel`.
- **Gateways:** EF's demo gateway is shared and unreliable (on 6 Nov it stopped completing boots). `canary.local.config.json` uses three run from [`../../gateway/`](../../gateway/) with `ADVERTISE=127.0.0.1` on ports 12298–12300 (`KPS_PORT`, one volume each); put in the addresses `docker logs` prints for yours (the certhash comes from each gateway's key). `canary.config.json` (`npm run gateway`) now uses the same gateways by default; `npm run gateways -- <address> …` at the repo root rewrites all of them.
- **Read endpoints** must accept Tor traffic: publicnode and 1rpc do, Tenderly doesn't (docs/test-log.md §5).
- **ethers instead of viem:** `const provider = await canary.ethersProvider(11155111)`.

## Swap on Uniswap v4 (`npm run swap`)

```sh
npm run gateway:local                                # terminal 1
AGENT_KEY_FILE=../../agent.key npm run swap          # terminal 2: 0.0001 ETH → CNRY on Sepolia (AMOUNT=… to change it)
```

The same swap as [Canary Swap](../../swap/)'s page, with the same code (`swap/src/v4.js`): a quote from the v4 Quoter over `eth_call` (the pool key and the amount, no address), then one Universal Router transaction (`V4_SWAP`). viem signs it with the local key and sends it as `eth_sendRawTransaction` (the gateway answers viem's `eth_fillTransaction` with "method not found", so viem fills it from the standard reads); the manifest's `rpc.write: "anon"` sends that over anon-rpc too, so the RPC learns neither this machine's IP nor that the quote and the wallet belong together. The key file holds a Sepolia test key with a little ETH, and is never printed. A run: [`test-artifacts/swap/agent-swap.log`](../../test-artifacts/swap/agent-swap.log) (16 of 17 calls protected, the broadcast IP-only, none direct).

## Policy from ENS (`npm run gateway:ens`)

`canary.ens.config.json` has no local manifest: the gateway reads `privacy.manifest` from `trader-01.agents.canary.eth` over anon-rpc, re-reads it every 5 minutes, and blocks every undeclared host until it loads. With `CANARY_REPORT_KEY` set, it publishes the signed coarse report to `privacy.report` daily, or on `POST http://127.0.0.1:18545/canary/publish`.

```sh
# operator, once (owner key controls the name's resolver); these also go through the gateway
export CANARY_OWNER_KEY=0x…
npx canary-ens set-manifest trader-01.agents.canary.eth manifest.json      # "reporter" is the report key's address
npx canary-ens grant-reporter trader-01.agents.canary.eth <report key address>

# gateway with reporting (gateway:ens:local through your own gateways)
CANARY_REPORT_KEY=0x… npm run gateway:ens

# anyone
npx canary-ens read trader-01.agents.canary.eth
```

`trader-01.agents.canary.eth` is live on Sepolia with this manifest and its report key granted (`packages/ens/README.md`, *Live on Sepolia*), so `canary-ens read` works for anyone, and the gateway runs against it as is. To write its records you need its owner key; for your own agent, replace the name with one you control (with a Permissioned Resolver) in the config, the manifest's `agent` and the commands.

## Demo beats (docs/agent-sdk.md §7)

| Beat | Command |
|---|---|
| Leaky run | `npm run agent:leaky`: the provider gets this machine's IP and every read; the LLM gets the raw wallet |
| With Canary | `npm run agent`: reads via anon-rpc; the LLM sees `WALLET_1` |
| Python, zero code changes | `examples/python-agent` |
| Manifest is the policy | `canary-ens set-manifest` without a host: the gateway blocks it within `refreshMs` |
| Report | `curl -X POST http://127.0.0.1:18545/canary/publish`, then `canary-ens read` |
