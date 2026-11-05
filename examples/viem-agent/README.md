# Example: a viem agent behind Canary

A minimal agent loop on Sepolia: read ETH/USDC balances, ask an LLM, print what Canary decided.

```sh
# from the repo root, once
npm install && npm run build

cd examples/viem-agent
npm run gateway                                   # terminal 1
WALLET=0x… OPENAI_API_KEY=sk-… npm run agent       # terminal 2 (no key: prints the redacted prompt)
```

- **Chrome:** `canary.config.json` uses your installed Chrome (`"channel": "chrome"`). Or set `"executablePath"`, or run `npx playwright install chromium` and remove `channel`.
- **Network:** tor-js with EF's demo gateway, same as the extension's `config/live.json`. The first boot takes ~13 s; reads take ~1–1.5 s each.
- **Read endpoints** must accept Tor traffic: publicnode and 1rpc do, Tenderly doesn't (test-repo.md §5).
- **Policy:** `manifest.json`. The LLM host is declared `direct` (keyed; addresses pseudonymized). Undeclared hosts are blocked.
- **Any other language:** skip the SDK and set the agent's RPC URL to `http://127.0.0.1:18545/11155111`.
