// The scanner's fake wallet, injected into every frame before page scripts.
// EIP-1193 + EIP-6963. Hands out the canary address, approves connection,
// rejects every signature and transaction, and answers reads through a
// scanner-side RPC that never touches the proxy (so it can't pollute results).
// The address and chain placeholders below are substituted by scan.mjs.
(() => {
  if (window.__canaryScannerWallet) return;
  const ADDR = "__ADDR__";
  const CHAIN = "__CHAIN__";
  const listeners = {};
  const emit = (e, v) => (listeners[e] || []).forEach((f) => { try { f(v); } catch {} });
  const reject = (code, message) => Promise.reject(Object.assign(new Error(message), { code }));
  const provider = {
    isCanaryScanner: true,
    async request({ method, params }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          setTimeout(() => emit("connect", { chainId: CHAIN }), 0);
          return [ADDR];
        case "eth_chainId":
          return CHAIN;
        case "net_version":
          return String(parseInt(CHAIN, 16));
        case "wallet_requestPermissions":
        case "wallet_getPermissions":
          return [{ parentCapability: "eth_accounts", caveats: [] }];
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
        case "wallet_watchAsset":
          return null;
        case "personal_sign":
        case "eth_sign":
        case "eth_signTypedData":
        case "eth_signTypedData_v3":
        case "eth_signTypedData_v4":
        case "eth_sendTransaction":
        case "wallet_sendCalls":
          return reject(4001, "Canary scanner wallet rejects all signing");
        default:
          if (typeof window.__canaryScannerRpc === "function") return window.__canaryScannerRpc(method, params ?? []);
          return reject(4200, "Canary scanner wallet: unsupported " + method);
      }
    },
    on(e, f) { (listeners[e] = listeners[e] || []).push(f); return provider; },
    removeListener(e, f) { listeners[e] = (listeners[e] || []).filter((x) => x !== f); return provider; },
    enable() { return provider.request({ method: "eth_requestAccounts" }); },
  };
  Object.defineProperty(window, "__canaryScannerWallet", { value: provider });
  try { Object.defineProperty(window, "ethereum", { value: provider, configurable: true, writable: true }); } catch {}
  const info = Object.freeze({ uuid: "6f7c2b2e-5d1a-4c3e-9a0b-ca9a7a5ca9e5", name: "Canary Scanner", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3Crect width='1' height='1' fill='%23facc15'/%3E%3C/svg%3E", rdns: "xyz.canary.scanner" });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();
