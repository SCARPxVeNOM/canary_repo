// Canary ISOLATED-world bridge. Injected at document_start, before the shim.
// Accepts the shim's MessagePort, sends it this site's config, and relays
// requests and observations to the service worker.

declare const chrome: any;

const TAG = "__canary";
let connected = false;

async function siteConfig() {
  const r = await chrome.runtime.sendMessage({ type: "config", origin: location.origin, top: window === window.top });
  return r as { enabled: boolean; addresses: string[] };
}

window.addEventListener("message", (ev) => {
  if (ev.source !== window || ev.data?.[TAG] !== "hello" || connected || !ev.ports[0]) return;
  connected = true;
  const port = ev.ports[0];
  port.postMessage({ type: "ack" });
  siteConfig().then(
    (config) => port.postMessage({ type: "config", config }),
    () => port.postMessage({ type: "config", config: { enabled: false, addresses: [] } }),
  );
  port.onmessage = (e) => {
    const m = e.data;
    if (m?.type === "rpc") {
      chrome.runtime
        .sendMessage({ type: "rpc", url: m.url, body: m.body, channel: m.channel, origin: location.origin })
        .then(
          (r: any) => port.postMessage({ type: "res", id: m.id, ...r }),
          (err: Error) =>
            port.postMessage({ type: "res", id: m.id, status: 200, body: errorBody(m.body, `Canary: extension unavailable (${err?.message ?? err})`) }),
        );
    } else if (m?.type === "obs") {
      chrome.runtime.sendMessage({ type: "obs", obs: m.obs, origin: location.origin }).catch(() => {});
    } else if (m?.type === "wallet") {
      chrome.runtime.sendMessage({ type: "wallet", addresses: m.addresses, chainId: m.chainId, origin: location.origin }).catch(() => {});
    }
  };
});

// In case the shim ran first and its hello was missed.
window.postMessage({ [TAG]: "bridge-ready" }, "*");

function errorBody(body: string, message: string) {
  try {
    const v = JSON.parse(body);
    const err = (c: any) => ({ jsonrpc: "2.0", id: c?.id ?? null, error: { code: -32603, message } });
    return JSON.stringify(Array.isArray(v) ? v.map(err) : err(v));
  } catch {
    return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message } });
  }
}
