# Canary's tor-js gateway

Browsers can't open raw TCP, so tor-js reaches Tor relays through a **gateway**: a small server that relays encrypted Tor connections over [KPS](https://ethereum.github.io/kps/) (WebRTC, one UDP port) and serves the public directory snapshot. This is EF's [`tor-js-gateway`](https://github.com/ethereum/tor-js/tree/main/crates/tor-js-gateway), built from a pinned commit. Nothing in it is Canary-specific.

Why run one: EF's demo gateway (Frankfurt) is shared, "limited capacity, may disappear at any time". On 5–6 Nov 2026 it took 2.8 s just to dial and repeatedly failed to reach guards, then stopped answering KPS entirely (docs/test-log.md §14).

## Run

```sh
docker build -t canary-gateway gateway/          # ~10 min the first time
docker run -d --name canary-gateway --restart unless-stopped \
  -p 12298:12298/udp -e ADVERTISE=<public IP> -v canary-gateway:/data canary-gateway
docker logs canary-gateway                       # prints the address: <ip>:12298:<certhash>
```

- `ADVERTISE`: the IP(s) clients dial, comma-separated. Behind NAT, the public IP, with UDP 12298 forwarded. On a laptop for a local demo: `127.0.0.1`.
- `/data` holds the config, the directory cache and the **KPS identity key**. The certhash in the address is derived from the key, so keep the volume: a new key is a new address, and every client config pointing at the old one breaks.
- Put the printed address into the default configs with `npm run gateways -- <address> [<address> ...]` at the repo root (`--with-ef` appends EF's demo gateway as a fallback), then rebuild the extension.

## How Canary uses gateways (and the caveats)

1. **Several gateways, no single point of failure.** `gateways` is an unordered set: each tor-js client prefers one, spreads load, cools off a failing one with backoff and comes back to it when it recovers. Production: 2–3 gateways in different regions, plus EF's as a last resort.
2. **Don't operate both ends.** The gateway sees a user's IP; the read endpoint sees which address is queried. One operator holding both could match them by timing. Canary's read endpoints are third-party RPCs (`readEndpoints` in the config), never servers we run.
3. **What a gateway learns:** the user's IP, that they use Tor, and traffic volume and timing. Not destinations, not contents: circuits are built and encrypted in the browser, and the gateway only relays to Tor relays listed in the consensus. It's the same position as a Tor guard relay. This is stated in the CROPS section of the main README.
4. **Updating the list** currently means a new extension build. Planned: publish it in an ENS text record, read through the same bootstrap RPC that already reads the worker specifier.
5. **Capacity:** defaults are 16 tunnels per client IP and 8,192 in total; a client needs a few. The biggest per-user transfer, the ~1.5 MB directory snapshot on a first boot, is packaged into the extension instead (`torBootstrap` in the config), so the gateway mostly carries RPC-sized traffic.

Logging: the image runs with `RUST_LOG=warn`, so there are no per-connection logs.
