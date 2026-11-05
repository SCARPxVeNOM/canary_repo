// JSON-RPC classification. Deterministic: exact matching, no heuristics.
// Shared by the browser extension and the agent gateway.

/** Standard read methods Canary answers from its own read endpoint ("substitute"). */
export const SUBSTITUTABLE = new Set([
  "eth_call", "eth_getBalance", "eth_blockNumber", "eth_chainId", "eth_getCode", "eth_getStorageAt",
  "eth_getTransactionCount", "eth_estimateGas", "eth_gasPrice", "eth_feeHistory", "eth_maxPriorityFeePerGas",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionReceipt", "eth_getTransactionByHash",
  "eth_getLogs", "net_version", "eth_blobBaseFee",
]);

/** Methods that publish a signed transaction. Canary never signs; it only routes. */
export const BROADCAST = new Set(["eth_sendRawTransaction", "eth_sendRawTransactionSync"]);

/** Methods that would need a key held by the node. Agents sign locally; refuse these. */
export const NODE_SIGNING = new Set(["eth_sendTransaction", "eth_sign", "personal_sign", "eth_signTransaction", "eth_signTypedData_v4"]);

export type RpcId = string | number | null;
export type RpcCall = { jsonrpc: "2.0"; id?: RpcId; method: string; params?: unknown };
export type RpcResponse = { jsonrpc: "2.0"; id: RpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } };

/** The calls in a JSON-RPC request body (single or batch), or null if it isn't one. */
export function parseJsonRpc(text: string): RpcCall[] | null {
  if (!text || !/^\s*[[{]/.test(text)) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const one = (x: any) => !!x && typeof x === "object" && x.jsonrpc === "2.0" && typeof x.method === "string";
  if (Array.isArray(v)) return v.length > 0 && v.every(one) ? (v as RpcCall[]) : null;
  return one(v) ? [v as RpcCall] : null;
}

/** True when the body was a batch (an array), so the answer must be one too. */
export const isBatchBody = (text: string) => /^\s*\[/.test(text);

export function rpcError(id: RpcId | undefined, message: string, code = -32603, data?: unknown): RpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export function rpcResult(id: RpcId | undefined, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
