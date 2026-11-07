// A tiny viem "dapp", written the way real ones are: an http() transport
// pointed straight at the dapp's own (keyed) RPC provider.
import { createPublicClient, http } from "viem";

declare const __PROVIDER__: string;
const ADDR = "0x5ca1ab1e00000000000000000000000000c0ffee";

(window as any).runDapp = async () => {
  const out: Record<string, unknown> = {};
  const t0 = performance.now();
  const c = createPublicClient({ transport: http(__PROVIDER__), cacheTime: 0 });
  out.chainId = await c.getChainId();
  out.blockNumber = String(await c.getBlockNumber({ cacheTime: 0 }));
  out.balance = String(await c.getBalance({ address: ADDR }));
  try {
    out.custom = await c.request({ method: "alchemy_getTokenBalances" as any, params: [ADDR] as any });
  } catch (e) {
    out.custom = "ERR " + (e as Error).message.split("\n")[0];
  }
  const b = createPublicClient({ transport: http(__PROVIDER__, { batch: true }), cacheTime: 0 });
  const [bn, bal] = await Promise.all([b.getBlockNumber({ cacheTime: 0 }), b.getBalance({ address: ADDR })]);
  out.batch = [String(bn), String(bal)];
  out.ms = Math.round(performance.now() - t0);
  return out;
};
