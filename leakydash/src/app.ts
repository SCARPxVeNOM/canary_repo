// LeakyDash: a small Sepolia token dashboard, written the way many dapps are.
//
// Leaky mode (default): reads go from your browser straight to "our" RPC
// provider, with your address in them; connecting fires an analytics event
// and a tracking pixel carrying your address; the backend gets it too.
//
// Native mode: LeakyDash itself routes 100% of its reads through anon-rpc
// (tor-js) with @anon-rpc/browser-harness. No extension needed. This is the
// "your app routes its RPC reads through anon-rpc by default" path.

import { createPublicClient, formatEther, formatUnits, http, parseAbi, type Address, type PublicClient } from "viem";
import { sepolia } from "viem/chains";
import { AnonRpcWorker } from "@anon-rpc/browser-harness";

declare const __PROVIDER__: string;
declare const __TRACKER__: string;

const TOR_JS = {
  specifier: "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e" as const,
  bootstrapRpc: "https://ethereum-rpc.publicnode.com", // the specifier lives on mainnet
  config: { gateways: ["152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ"] },
  readEndpoint: "https://ethereum-sepolia-rpc.publicnode.com", // accepts Tor exits (test-repo.md §5)
};

const TOKENS: { symbol: string; address: Address; decimals: number }[] = [
  { symbol: "USDC", address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6 },
  { symbol: "WETH", address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", decimals: 18 },
  { symbol: "LINK", address: "0x779877A7B0D9E8603169DdbD7836e478b4624789", decimals: 18 },
];
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const $ = (id: string) => document.getElementById(id)!;
// A random id for this browser, sent with LeakyDash's own requests (in the provider
// URL as RPC URLs carry a project key, as an analytics id, to the backend), so the
// deployed log viewer shows each visitor only their own entries. Not part of the leak.
const SID = localStorage.getItem("leakydash.sid") ?? crypto.randomUUID();
localStorage.setItem("leakydash.sid", SID);
type Mode = "leaky" | "native";
const mode: Mode = (localStorage.getItem("leakydash.mode") as Mode) ?? "leaky";

/* --- the RPC client ----------------------------------------------------- */

let worker: AnonRpcWorker | undefined;
function makeClient(): PublicClient {
  if (mode === "native") {
    const t0 = performance.now();
    worker = new AnonRpcWorker({
      address: TOR_JS.specifier,
      config: TOR_JS.config,
      preExisting: {
        rpcProvider: {
          // Only the §4 specifier read uses this: it carries nothing about you.
          request: async ({ method, params }: { method: string; params?: unknown[] }) => {
            const r = await fetch(TOR_JS.bootstrapRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }) });
            const j = await r.json();
            if (j.error) throw new Error(j.error.message);
            return j.result;
          },
        },
      },
    });
    setStatus("Booting tor-js in a sandbox (≈13 s the first time)…");
    worker.ready.then(
      () => setStatus(`anon-rpc ready: tor-js booted in ${((performance.now() - t0) / 1000).toFixed(1)} s. All reads go through Tor.`, "ok"),
      (e) => setStatus(`anon-rpc failed to boot: ${e?.message ?? e}`, "bad"),
    );
    return createPublicClient({ chain: sepolia, transport: http(TOR_JS.readEndpoint, { fetchFn: worker.fetch, timeout: 45_000 }), batch: { multicall: true } });
  }
  return createPublicClient({ chain: sepolia, transport: http(`${__PROVIDER__}?sid=${SID}`), batch: { multicall: true } });
}
const client = makeClient();

/* --- wallet (EIP-6963, falling back to window.ethereum) ---------------- */

type Eip1193 = { request(a: { method: string; params?: unknown[] }): Promise<any>; on?(e: string, f: (...a: any[]) => void): void };
const providers: { info: { name: string; rdns: string }; provider: Eip1193 }[] = [];
window.addEventListener("eip6963:announceProvider", (e: any) => {
  if (!providers.some((p) => p.info.rdns === e.detail.info.rdns)) providers.push(e.detail);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

async function connect() {
  const p = providers[0]?.provider ?? (window as any).ethereum;
  if (!p) return setStatus("No wallet found. Paste an address to watch instead.", "bad");
  const [a] = await p.request({ method: "eth_requestAccounts" });
  p.on?.("accountsChanged", (accs: string[]) => accs[0] && useAddress(accs[0] as Address, "wallet"));
  useAddress(a, "wallet");
}

/* --- the leaks (what many dapps ship without thinking) ------------------ */

function leak(address: Address) {
  if (mode === "native") return; // native mode ships without them
  // 1. "analytics": an event with your address
  navigator.sendBeacon(`${__TRACKER__}/collect`, JSON.stringify({ event: "wallet_connected", address, page: location.pathname, sid: SID }));
  // 2. a tracking pixel with your address in the URL
  new Image().src = `${__TRACKER__}/p.gif?uid=${address}&e=connect&sid=${SID}`;
  // 3. fetch-based analytics, address base64-encoded (still caught: Canary checks base64)
  const raw = new Uint8Array(address.slice(2).match(/../g)!.map((h) => parseInt(h, 16)));
  void fetch(`${__TRACKER__}/v2/identify`, { method: "POST", body: JSON.stringify({ uid: btoa(String.fromCharCode(...raw)), sid: SID }) }).catch(() => {});
}

/* --- the dashboard ------------------------------------------------------ */

let current: Address | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

function useAddress(a: Address, how: "wallet" | "watch") {
  current = a;
  $("who").textContent = `${a.slice(0, 6)}…${a.slice(-4)} (${how})`;
  leak(a);
  // 4. first-party backend: sees your address by design (Canary labels it, doesn't block it)
  fetch(`/api/points?address=${a}&sid=${SID}`).then((r) => r.json()).then((j) => ($("points").textContent = String(j.points)), () => {});
  void refresh();
  clearInterval(timer);
  timer = setInterval(refresh, 15_000);
}

async function refresh() {
  if (!current) return;
  const t0 = performance.now();
  $("updated").textContent = "loading…";
  try {
    const ok = <T,>(p: Promise<T>) => p.then((v) => v, () => null);
    const [block, gas, eth, ...tokens] = await Promise.all([
      ok(client.getBlockNumber()),
      ok(client.getGasPrice()),
      ok(client.getBalance({ address: current })),
      ...TOKENS.map((t) => ok(client.readContract({ address: t.address, abi: ERC20, functionName: "balanceOf", args: [current!] }))),
    ]);
    $("block").textContent = block === null ? "—" : block.toLocaleString();
    $("gas").textContent = gas === null ? "—" : `${Number(formatUnits(gas, 9)).toFixed(2)} gwei`;
    $("eth").textContent = eth === null ? "—" : Number(formatEther(eth)).toFixed(4);
    if ([block, gas, eth].every((v) => v === null)) throw new Error("no reads succeeded");
    $("tokens").innerHTML = TOKENS.map((t, i) => {
      const v = tokens[i] as bigint | null;
      return `<tr><td>${t.symbol}</td><td>${v === null ? "—" : Number(formatUnits(v, t.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td></tr>`;
    }).join("");
    $("updated").textContent = `updated in ${Math.round(performance.now() - t0)} ms`;
  } catch (e: any) {
    $("updated").textContent = `read failed: ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0]}`;
  }
}

function setStatus(text: string, kind: "ok" | "bad" | "" = "") {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${kind}`;
}

/* --- wiring ------------------------------------------------------------- */

$("mode").textContent = mode === "native" ? "Native: reads via anon-rpc" : "Leaky (default)";
($("modeToggle") as HTMLButtonElement).textContent = mode === "native" ? "Switch to leaky mode" : "Switch to native anon-rpc mode";
$("modeToggle").addEventListener("click", () => {
  localStorage.setItem("leakydash.mode", mode === "native" ? "leaky" : "native");
  location.reload();
});
$("connect").addEventListener("click", () => void connect().catch((e) => setStatus(String(e?.message ?? e), "bad")));
$("watchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = ($("watchInput") as HTMLInputElement).value.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) useAddress(v as Address, "watch");
  else setStatus("That isn't a 0x… address.", "bad");
});
if (mode === "leaky") setStatus(`Reads go to ${new URL(__PROVIDER__).host}, straight from your browser.`);
(window as any).leakydash = { useAddress, refresh, mode };
