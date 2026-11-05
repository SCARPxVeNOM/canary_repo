// "LeakyDash (fixture)": a dapp written the way many real ones are, used by the
// e2e. It has a fake wallet that hands out a fixed canary address, reads
// through its own RPC provider over HTTP, XHR and WebSocket, and leaks the
// address to a tracker through every channel we claim to handle.

import { createPublicClient, http, webSocket, encodeFunctionData, parseAbi } from "viem";

declare const __P__: string; // port
const U = (h: string) => `http://${h}:${__P__}`;
const PROVIDER = U("rpc.provider.test") + "/";
const HOSTILE = U("torblock.provider.test") + "/";
const TRACKER = U("tracker.test");
const INDEXER = U("indexer.test");
const ADDR = "0x5Ca1ab1e00000000000000000000000000C0FfEe";

/* --- fake wallet: EIP-1193 + EIP-6963 --- */
const wallet = {
  async request({ method }: { method: string }) {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [ADDR];
    if (method === "eth_chainId") return "0xaa36a7";
    throw new Error("fixture wallet: unsupported " + method);
  },
  on() {},
};
(window as any).ethereum = wallet;
const announce = () =>
  window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
    detail: Object.freeze({ info: { uuid: "00000000-0000-4000-8000-000000000000", name: "Fixture Wallet", icon: "data:,", rdns: "test.fixture" }, provider: wallet }),
  }));
window.addEventListener("eip6963:requestProvider", announce);
announce();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = <T>(p: Promise<T>) => p.then((v) => v, (e) => `ERR ${String(e?.message ?? e).split("\n")[0]}`);

function xhr(method: string, url: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    x.setRequestHeader("content-type", "application/json");
    x.onload = () => resolve({ status: x.status, text: x.responseText });
    x.onerror = () => resolve({ status: 0, text: "error" });
    x.send(body);
  });
}
const img = (src: string) =>
  new Promise<string>((resolve) => {
    const i = new Image();
    i.onload = () => resolve("loaded");
    i.onerror = () => resolve("error");
    i.src = src;
  });

(window as any).runDapp = async (opts: { leaks?: boolean } = {}) => {
  const out: Record<string, unknown> = {};
  const t0 = performance.now();
  const [acct] = await wallet.request({ method: "eth_requestAccounts" });
  await sleep(300);

  const c = createPublicClient({ transport: http(PROVIDER), cacheTime: 0 });
  out.chainId = await settle(c.getChainId());
  out.blockNumber = await settle(c.getBlockNumber({ cacheTime: 0 }).then(String));
  out.balance = await settle(c.getBalance({ address: acct as `0x${string}` }).then(String));
  out.call = await settle(
    c.call({ to: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", data: encodeFunctionData({ abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [acct as `0x${string}`] }) }).then((r) => r.data),
  );
  out.custom = await settle(c.request({ method: "alchemy_getTokenBalances" as any, params: [acct] as any }));
  const b = createPublicClient({ transport: http(PROVIDER, { batch: true }), cacheTime: 0 });
  out.batch = await settle(Promise.all([b.getBlockNumber({ cacheTime: 0 }), b.getBalance({ address: acct as `0x${string}` })]).then((x) => x.map(String)));
  out.xhrBalance = await xhr("POST", PROVIDER, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "eth_getBalance", params: [acct, "latest"] })).then((r) => JSON.parse(r.text).result ?? r.text, () => "ERR");
  const ws = createPublicClient({ transport: webSocket(PROVIDER.replace("http", "ws") + "ws", { keepAlive: false, reconnect: false }), cacheTime: 0 });
  out.wsBlockNumber = await settle(ws.getBlockNumber({ cacheTime: 0 }).then(String));
  out.hostileBalance = await settle(createPublicClient({ transport: http(HOSTILE), cacheTime: 0 }).getBalance({ address: acct as `0x${string}` }).then(String));
  out.rpcMs = Math.round(performance.now() - t0);

  if (opts.leaks !== false) {
    out.trackerFetch = await fetch(`${TRACKER}/collect`, { method: "POST", body: JSON.stringify({ event: "connect", address: acct }) }).then((r) => `sent ${r.status}`, (e) => `failed: ${e.message}`);
    const raw = new Uint8Array(acct.slice(2).match(/../g)!.map((h: string) => parseInt(h, 16)));
    out.trackerBase64 = await fetch(`${TRACKER}/collect2`, { method: "POST", body: JSON.stringify({ uid: btoa(String.fromCharCode(...raw)) }) }).then((r) => `sent ${r.status}`, (e) => `failed: ${e.message}`);
    out.trackerBeacon = navigator.sendBeacon(`${TRACKER}/beacon`, JSON.stringify({ wallet: acct.toLowerCase() }));
    out.trackerXhr = (await xhr("POST", `${TRACKER}/xhr`, `wallet=${acct}`)).status;
    out.trackerPixel = await img(`${TRACKER}/pixel.gif?a=${acct.slice(2)}`);
    out.trackerClean = await fetch(`${TRACKER}/event`, { method: "POST", body: JSON.stringify({ event: "pageview" }) }).then((r) => `sent ${r.status}`, (e) => `failed: ${e.message}`);
    out.points = await fetch(`/api/points?address=${acct}`).then((r) => r.json(), (e) => `failed: ${e.message}`);
    out.indexer = await fetch(`${INDEXER}/names/vitalik.eth`).then((r) => r.json(), (e) => `failed: ${e.message}`);
    await sleep(500); // let the beacon go out (or not)
  }
  return out;
};
