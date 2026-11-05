#!/usr/bin/env python3
"""A Python agent behind Canary with zero code changes: only environment variables.

    RPC_URL=http://127.0.0.1:18545/11155111       chain reads go through anon-rpc (the gateway is the endpoint)
    HTTPS_PROXY=http://127.0.0.1:18080             other HTTP(S) gets the manifest's per-host rules
    NO_PROXY=127.0.0.1,localhost                   don't send the RPC calls themselves through the proxy
    WALLET=0x...                                   an address to watch (Canary never needs a key)

Without the MITM CA, HTTPS through the proxy is host-level only: declared
`direct` hosts are tunnelled, everything else is refused. With it
(`canary-gateway ca`, then REQUESTS_CA_BUNDLE / SSL_CERT_FILE = the bundle),
`anon` hosts go through anon-rpc too. Standard library only.
"""

import json
import os
import sys
import urllib.error
import urllib.request

RPC_URL = os.environ.get("RPC_URL", "http://127.0.0.1:18545/11155111")
WALLET = os.environ.get("WALLET", "0x0000000000000000000000000000000000000000")
PRICE_URL = os.environ.get("PRICE_URL", "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd")
UNDECLARED_URL = os.environ.get("UNDECLARED_URL", "https://example.com/")


def out(**kv):
    print(json.dumps(kv), flush=True)


def rpc(method, params=None):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode()
    req = urllib.request.Request(RPC_URL, data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        j = json.load(r)
    if "error" in j:
        raise RuntimeError(f"{method}: {j['error'].get('message')}")
    return j["result"]


def get(url):
    """GET through whatever proxy the environment names; report what Canary decided."""
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            return {"status": r.status, "decision": r.headers.get("x-canary-decision"), "body": r.read(200).decode(errors="replace")}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "decision": e.headers.get("x-canary-decision"), "reason": e.headers.get("x-canary-reason")}
    except (urllib.error.URLError, OSError) as e:
        # e.g. a CONNECT refused by the proxy (403) surfaces here for https URLs
        return {"status": None, "error": str(getattr(e, "reason", e))}


def main():
    block = int(rpc("eth_blockNumber"), 16)
    balance = int(rpc("eth_getBalance", [WALLET, "latest"]), 16)
    out(step="chain", block=block, wallet=WALLET, balance_wei=balance)
    out(step="price", url=PRICE_URL, **get(PRICE_URL))
    out(step="undeclared", url=UNDECLARED_URL, **get(UNDECLARED_URL))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # fail closed shows up here as an RPC error
        out(step="error", error=str(e))
        sys.exit(1)
