# Example: a viem agent behind Canary

A minimal agent loop on Sepolia: read ETH/USDC balances, ask an LLM, print what Canary decided. The same agent can run without Canary (`--leaky`) for the demo's before/after.

```sh
# from the repo root, once
npm install && npm run build

cd examples/viem-agent
npm run gateway                                     # terminal 1: tor-js boots in ~13 s
npm run gateway:local                               # or through your own gateways (below)
WALLET=0x… OPENAI_API_KEY=sk-… npm run agent         # terminal 2 (no key: prints the redacted prompt)
WALLET=0x… npm run agent:leaky                       # same agent, no Canary: direct RPC, raw prompt
```

On Windows (cmd), set variables first: `set WALLET=0x…` then `npm run agent`.

| File | What |
|---|---|
| `agent.mjs` | the agent. The only line that differs between the two modes is the viem transport (plus `llmFetch` for the LLM call) |
| `canary.config.json` | gateway config: tor-js (same as the extension's `config/live.json`), Sepolia + mainnet read endpoints, local manifest |
| `manifest.json` | the policy: LLM hosts `direct` (keyed; addresses pseudonymized), `api.coingecko.com` `anon`, everything else blocked; Sepolia USDC and WETH allow-listed for the LLM |
| `canary.ens.config.json` | the same gateway, but the policy comes from the agent's ENSv2 name (below) |
| `canary.local.config.json` | the same gateway through three tor-js gateways run on this machine |

Notes:
- **Chrome:** the configs use your installed Chrome (`"channel": "chrome"`). Or set `"executablePath"`, or run `npx playwright install chromium` and remove `channel`.
- **Gateways:** EF's demo gateway is shared and unreliable (on 6 Nov it stopped completing boots). `canary.local.config.json` uses three run from [`../../gateway/`](../../gateway/) with `ADVERTISE=127.0.0.1` on ports 12298–12300 (`KPS_PORT`, one volume each); put in the addresses `docker logs` prints for yours (the certhash comes from each gateway's key).
- **Read endpoints** must accept Tor traffic: publicnode and 1rpc do, Tenderly doesn't (test-repo.md §5).
- **ethers instead of viem:** `const provider = await canary.ethersProvider(11155111)`.

## Policy from ENS (`npm run gateway:ens`)

`canary.ens.config.json` has no local manifest: the gateway reads `privacy.manifest` from `trader-01.agents.canary.eth` over anon-rpc, re-reads it every 5 minutes, and blocks every undeclared host until it loads. With `CANARY_REPORT_KEY` set, it publishes the signed coarse report to `privacy.report` daily, or on `POST http://127.0.0.1:18545/canary/publish`.

```sh
# operator, once (owner key controls the name's resolver); these also go through the gateway
export CANARY_OWNER_KEY=0x…
npx canary-ens set-manifest trader-01.agents.canary.eth manifest.json      # add "reporter": "<report key address>" first
npx canary-ens grant-reporter trader-01.agents.canary.eth <report key address>

# gateway with reporting
CANARY_REPORT_KEY=0x… npm run gateway:ens

# anyone
npx canary-ens read trader-01.agents.canary.eth
```

Replace `trader-01.agents.canary.eth` with a name you control on Sepolia (with a Permissioned Resolver), in both the config and the commands. See `packages/ens/README.md` for the ENSv2 compatibility note.

## Demo beats (agent-sdk.md §7)

| Beat | Command |
|---|---|
| Leaky run | `npm run agent:leaky`: the provider gets this machine's IP and every read; the LLM gets the raw wallet |
| With Canary | `npm run agent`: reads via anon-rpc; the LLM sees `WALLET_1` |
| Python, zero code changes | `examples/python-agent` |
| Manifest is the policy | `canary-ens set-manifest` without a host: the gateway blocks it within `refreshMs` |
| Report | `curl -X POST http://127.0.0.1:18545/canary/publish`, then `canary-ens read` |
