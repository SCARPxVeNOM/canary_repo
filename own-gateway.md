# Running our own tor-js gateway

Handoff, 6 Nov 2026. Why the live tor-js runs are slow, what the gateway is, and the steps to run our own (next: on a Mac). Results go into [test-repo.md](test-repo.md) as round 5.

---

## Why

Both halves of Canary, the agent gateway and the extension, reach Tor through one server: EF's demo tor-js gateway `152.236.3.22:12298`. It's in two config lines:

- `examples/viem-agent/canary.config.json` → `network.workerConfig.gateways` (agent SDK)
- `extension/config/live.json` → `network.workerConfig.gateways` (extension)

In our live runs it was the bottleneck (test-repo.md §15–16):

- Fast bootstrap failed every time ("all gateways failed for /bootstrap.zip.zst").
- Tor took from 69 s to never (10+ min) to boot, and circuits came minutes after that.
- Once a circuit existed, reads took ~1 s.
- It labels itself "a demonstration instance: limited capacity, and it may disappear at any time. Run your own gateway for anything real." anon-rpc's `adopters.json5` says the same.
- Live apps also use tor-js (Privacy Pools, Kiwi News), so it's probably shared well beyond the hackathon (likely, not confirmed).

Canary itself behaved correctly: it failed closed throughout, with nothing sent direct.

## What the gateway is

- **Code:** [`ethereum/tor-js`](https://github.com/ethereum/tor-js) → `crates/tor-js-gateway/` (Rust, on Arti, the Tor Project's Rust Tor). MIT / Apache-2.0. Wire protocol: `PROTOCOL.md` in that repo.
- **Job:** browsers can't open raw TCP, and Tor relays only speak TCP. The gateway accepts browser connections over **KPS** (WebRTC, or QUIC for native clients) on **one UDP port** and relays encrypted bytes to Tor relays with `CONNECT`. It never sees the traffic. It only connects to relays listed in the Tor consensus.
- **It also serves** `/bootstrap.zip.zst`, a compressed Tor directory snapshot, so clients boot in seconds instead of downloading the directory hop by hop. The demo gateway fails on this.
- **Its address** is `ip:port:certhash`, printed at startup. The certhash pins its identity: no DNS, no CA.
- **Defaults to know:** `tunnel_per_ip` 16 and `tunnel_max` 8192.

Path of one read: agent → Canary gateway → headless Chrome running tor-js → **tor-js gateway** → Tor guard → middle → exit → RPC provider.

## Where to run it

| Who uses it | Needs a public server? |
|---|---|
| Agent SDK on the same machine | No: run it locally |
| Hackathon demo (agent + extension on one laptop) | No: run it locally |
| Other people's browsers (a public extension) | Yes: a public IP and an open UDP port |

- **Privacy is unchanged when it runs locally.** In any Tor setup the guard relay sees the client's IP. Here it sees the IP of the machine running the gateway.
- **Railway won't work:** it has no inbound UDP (HTTP and a TCP proxy only). Free hosts with a public UDP port: Oracle Cloud Always Free, or a Google Cloud e2-micro. Check the current terms before signing up.
- **Risk:** some networks (college, office, venue Wi-Fi) block outbound connections to Tor relays. EF's gateway hides that today; a local one doesn't. **Test on the venue network before the demo.**

## Steps on macOS

1. Toolchain (Rust 1.91+):
   ```sh
   xcode-select --install                       # C toolchain
   curl https://sh.rustup.rs -sSf | sh          # or: rustup update
   brew install pkg-config openssl@3 sqlite cmake
   ```
2. Build the gateway:
   ```sh
   git clone https://github.com/ethereum/tor-js && cd tor-js/crates/tor-js-gateway
   cargo install --path .
   ```
   If `openssl-sys` can't find OpenSSL: `export OPENSSL_DIR=$(brew --prefix openssl@3)`.
3. Configure and run:
   ```sh
   tor-js-gateway init        # ~/.config/tor-js-gateway/config.json5 and the KPS key
   ```
   - In the config, set `"advertised_addresses": ["127.0.0.1"]` for local use (otherwise it advertises the LAN IP, which also works on the same machine).
   - Leave `"demo": false`.
   - Run it in the foreground with `tor-js-gateway`. `install` is systemd only, so not on macOS.
   - Allow incoming connections if the macOS firewall asks.
   - Note the printed address `127.0.0.1:12298:uEi…`.
   - Wait for its first Tor directory sync. Data routes return 503 until then.
4. Point Canary at it in `examples/viem-agent/canary.config.json`:
   ```json
   "workerConfig": { "gateways": ["127.0.0.1:12298:<certhash>"] }
   ```
   Use ours alone while measuring. Later, list ours and the demo gateway for redundancy; tor-js accepts a set.
5. Test from the repo root:
   ```sh
   npm install && npm run build
   npm test                   # expect 62/62; gateway tests use installed Chrome (or set CHROME_BIN)
   npm run live-check         # real tor-js through our gateway; writes live-check.json
   ```
   Don't wrap the live check in `timeout` (on Windows that killed Chrome and showed up as a fake "page crashed").
6. Record the results in test-repo.md (round 5) against round 4:
   - time to `ready`;
   - time to the first read (`path.firstOkMs`);
   - read latency;
   - whether fast bootstrap succeeded;
   - pass/fail per live-check step.

## Open after that

- If it works, decide whether to point `extension/config/live.json` at our gateway too (same one-line change). The extension is paused for now.
- Ask EF / the tor-js authors whether the demo gateway is shared and rate-limited (agent-sdk.md §10).
- ENS on live Sepolia (needs a Sepolia name; `npm run live-check -- --ens-name <name>`).
- Framework adapters (AgentKit, Vercel AI SDK, MCP).

## State of the repo at handoff

- Branch `feat/agent-sdk`: the SDK (`1171368`), path health + round 4 results (`d1a9a7a`), and this file.
- The SDK passes 62/62 on Windows (Node 25).
- **Not committed (stayed on the Windows machine):** extension edits, including a real fix for a race in `extension/src/shim.ts` (`applyConfig` replaced the addresses learned from the wallet; merging fixes the e2e from 20/24 to 24/24), plus `channel: "chromium"` in `extension/test/e2e.mjs`, because branded Chrome no longer loads unpacked extensions. Redo these when the extension work resumes.
