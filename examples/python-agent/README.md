# Example: a Python agent behind Canary (no SDK, no code changes)

Any language works through the gateway: point the agent's RPC URL at it, and its HTTP(S) proxy too. Standard library only.

```sh
# terminal 1, from examples/viem-agent (same gateway config and manifest)
npm run gateway

# terminal 2
export RPC_URL=http://127.0.0.1:18545/11155111
export HTTPS_PROXY=http://127.0.0.1:18080 NO_PROXY=127.0.0.1,localhost
WALLET=0x… python3 agent.py
```

It prints one JSON line per step:

- **chain:** block number and balance, read through anon-rpc (the gateway is the RPC endpoint).
- **price:** `api.coingecko.com`, declared `anon` in the example manifest. Without the MITM CA the proxy can't send HTTPS through anon-rpc, so this is refused (fail closed). With it, it goes through anon-rpc:
  ```sh
  npx canary-gateway ca                                  # prints the bundle path
  export REQUESTS_CA_BUNDLE=~/.canary/ca/bundle.pem SSL_CERT_FILE=~/.canary/ca/bundle.pem
  # and set "mitm": true in canary.config.json, then restart the gateway
  ```
- **undeclared:** `example.com` is not in the manifest, so it's refused.

`NO_PROXY` keeps the RPC calls themselves off the proxy (they already go to the gateway).
