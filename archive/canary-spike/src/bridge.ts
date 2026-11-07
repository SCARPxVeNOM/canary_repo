// Canary ISOLATED-world content script: relays between the MAIN-world shim
// (window.postMessage) and the extension service worker (runtime messaging).

declare const chrome: any;

const TAG = "__canary";

window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d[TAG] !== "req") return;
  chrome.runtime
    .sendMessage({ type: "canary.rpc", url: d.url, body: d.body, page: location.origin })
    .then((r: any) => window.postMessage({ [TAG]: "res", id: d.id, ...r }, "*"))
    .catch((e: Error) => window.postMessage({ [TAG]: "res", id: d.id, error: String(e?.message ?? e) }, "*"));
});
