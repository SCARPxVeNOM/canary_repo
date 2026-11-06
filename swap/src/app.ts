// Canary Swap: a Uniswap v4 swap page whose quotes come from the chain.
//
// app.uniswap.org asks its server for a quote, and the request names you
// (`swapper`, test-artifacts/scans/quote/). Here the quote is an eth_call to
// the v4 Quoter: the pool key and the amount, no address. With Canary
// installed, that call and the balance reads go through anon-rpc, so the RPC
// provider doesn't see your IP either. The swap is one Universal Router
// transaction that your wallet signs and sends (src/v4.js).

import { createPublicClient, createWalletClient, custom, decodeFunctionData, encodeFunctionData, formatUnits, getAddress, http, parseUnits, type Address, type Hex } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { MARKETS } from "./markets.js";
import { ABI, approvalCalls, bestQuote, minOut, poolState, swapExactInSingle } from "./v4.js";

type Token = { symbol: string; address: Address; decimals: number; mintable?: boolean };
type Key = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
type Quote = { key: Key; amountOut: bigint; gasEstimate: bigint };
type Provider = { request(a: { method: string; params?: unknown[] }): Promise<any>; on?(e: string, f: (...a: any[]) => void): void };

const SLIPPAGE_BPS = 50;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const W = window as any;

const param = Number(new URLSearchParams(location.search).get("chain"));
let chainId: number = MARKETS[param as keyof typeof MARKETS] ? param : 11155111;
let zeroForOne = true; // selling currency0 (ETH)
let account: Address | undefined;
let provider: Provider | undefined;
let current: { amountIn: bigint; best: Quote | null; impact?: number } | null = null;
let busy = false;
let seq = 0; // bumped whenever the amount, direction or chain changes: a quote that comes back after is dropped
let quoting = false;
let sent: { to: string; body: string }[] = [];

const market = () => MARKETS[chainId as keyof typeof MARKETS];
const tokens = () => (zeroForOne ? market().tokens : [...market().tokens].reverse()) as [Token, Token];

// Every request the page's reads make, so "What this quote sent" shows the real bodies.
const clients: Record<number, ReturnType<typeof createPublicClient>> = {};
const client = () =>
  (clients[chainId] ??= createPublicClient({
    chain: chainId === 1 ? mainnet : sepolia,
    transport: http(market().rpc, {
      onFetchRequest: async (req: Request) => {
        const body = await req.clone().text();
        const to = /"to":"(0x[0-9a-fA-F]{40})"/.exec(body)?.[1]?.toLowerCase();
        const { quoter, stateView } = market().v4;
        if (to === quoter.toLowerCase() || to === stateView.toLowerCase()) sent.push({ to, body });
      },
    }),
  }));

/* --- formatting ------------------------------------------------------------ */

function fmt(v: bigint, decimals: number, digits = 6) {
  const n = Number(formatUnits(v, decimals));
  if (n === 0) return "0";
  if (n < 10 ** -digits) return `< ${10 ** -digits}`;
  return n.toLocaleString("en-US", { maximumSignificantDigits: digits });
}
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const feePct = (fee: number) => `${(fee / 10_000).toLocaleString("en-US", { maximumFractionDigits: 2 })} %`;
const status = (text: string, tone: "" | "ok" | "bad" = "", link?: { href: string; text: string }) => {
  const el = $("status");
  el.className = `status ${tone}`;
  el.textContent = text;
  if (link) {
    const a = Object.assign(document.createElement("a"), { href: link.href, textContent: link.text, target: "_blank", rel: "noopener" });
    el.append(" ", a);
  }
};

/* --- wallet ---------------------------------------------------------------- */

const announced: { info: { name: string }; provider: Provider }[] = [];
window.addEventListener("eip6963:announceProvider", (e: any) => announced.push(e.detail));
window.dispatchEvent(new Event("eip6963:requestProvider"));

async function connect() {
  provider = announced[0]?.provider ?? W.ethereum;
  if (!provider) return status("No wallet found. You can still get quotes without one.", "bad");
  try {
    const [a] = await provider.request({ method: "eth_requestAccounts" });
    account = getAddress(a);
  } catch (e: any) {
    return status(`Not connected: ${e?.shortMessage ?? e?.message ?? e}`, "bad");
  }
  provider.on?.("accountsChanged", (accs: string[]) => {
    account = accs[0] ? getAddress(accs[0]) : undefined;
    void refreshBalances();
  });
  status("");
  await refreshBalances();
}

async function onSepolia(p: Provider) {
  const want = `0x${sepolia.id.toString(16)}`;
  if ((await p.request({ method: "eth_chainId" })) !== want) await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
}

const walletClient = () => createWalletClient({ account: account!, chain: sepolia, transport: custom(provider!) });

/** Send one transaction from the wallet and wait for it (receipts are reads, so with Canary they come through anon-rpc too). */
async function sendTx(what: string, tx: { to: Address; data: Hex; value: bigint }) {
  status(`${what}: confirm in your wallet…`);
  const hash = await walletClient().sendTransaction(tx);
  const link = { href: `${market().explorer}/tx/${hash}`, text: short(hash) };
  status(`${what}: sent, waiting for it to be mined.`, "", link);
  const r = await client().waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw Object.assign(new Error(`${what} reverted`), { link });
  return { hash, link };
}

/* --- balances, quote ------------------------------------------------------- */

const balances: Record<string, bigint> = {};
async function refreshBalances() {
  $("connect").textContent = account ? short(account) : "Connect wallet";
  for (const k of Object.keys(balances)) delete balances[k];
  if (account) {
    const c = client();
    await Promise.all(
      market().tokens.map(async (t: Token) => {
        balances[t.symbol] = t.address === "0x0000000000000000000000000000000000000000"
          ? await c.getBalance({ address: account! })
          : await c.readContract({ address: t.address, abi: ABI.erc20, functionName: "balanceOf", args: [account!] });
      }),
    ).catch(() => {});
  }
  render();
}

async function requote() {
  const my = ++seq;
  const [tIn] = tokens();
  let amountIn: bigint;
  try {
    amountIn = parseUnits($<HTMLInputElement>("amountIn").value.trim().replace(/,/g, "") || "0", tIn.decimals);
  } catch {
    amountIn = 0n;
  }
  if (amountIn <= 0n) return (quoting = false), (current = null), render();
  sent = [];
  $("amountOut").textContent = "…";
  const c = client();
  const best: Quote | null = await bestQuote(c, chainId, market().pools, zeroForOne, amountIn).catch(() => null);
  let impact: number | undefined;
  if (best) {
    const s = await poolState(c, chainId, best.key).catch(() => null);
    if (s && s.sqrtPriceX96 > 0n) {
      const [t0, t1] = market().tokens as [Token, Token];
      const p = (Number(s.sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (t0.decimals - t1.decimals); // token1 per token0
      const [tI, tO] = tokens();
      const exec = Number(formatUnits(best.amountOut, tO.decimals)) / Number(formatUnits(amountIn, tI.decimals));
      impact = Math.max(0, 1 - exec / ((zeroForOne ? p : 1 / p) * (1 - best.key.fee / 1e6)));
    }
  }
  if (my !== seq) return;
  quoting = false;
  current = { amountIn, best, impact };
  render();
}

/* --- render ---------------------------------------------------------------- */

function render() {
  const m = market();
  const [tIn, tOut] = tokens();
  $("tokenIn").textContent = tIn.symbol;
  $("tokenOut").textContent = tOut.symbol;
  const bal = (t: Token) => (account && balances[t.symbol] !== undefined ? `Balance ${fmt(balances[t.symbol], t.decimals)}` : "");
  $("balIn").textContent = bal(tIn);
  $("balOut").textContent = bal(tOut);
  $("mintRow").hidden = !(account && m.swap && m.tokens.some((t: Token) => t.mintable));
  $("mint").textContent = `Get 1,000 test ${m.tokens.find((t: Token) => t.mintable)?.symbol ?? ""}`;

  const q = current?.best;
  $("amountOut").textContent = q ? fmt(q.amountOut, tOut.decimals, 8) : current ? "—" : quoting ? "…" : "0";
  $("details").hidden = !q;
  if (q && current) {
    const rate = Number(formatUnits(q.amountOut, tOut.decimals)) / Number(formatUnits(current.amountIn, tIn.decimals));
    $("rate").textContent = `1 ${tIn.symbol} = ${rate.toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${tOut.symbol}`;
    $("pool").textContent = `${m.tokens[0].symbol}/${m.tokens[1].symbol} · ${feePct(q.key.fee)}${m.pools.length > 1 ? ` (best of ${m.pools.length})` : ""}`;
    $("impact").textContent = current.impact === undefined ? "—" : `${(current.impact * 100).toFixed(2)} %`;
    $("min").textContent = `${fmt(minOut(q.amountOut, SLIPPAGE_BPS), tOut.decimals, 8)} ${tOut.symbol} (${SLIPPAGE_BPS / 100} % slippage)`;
    $("gas").textContent = `${q.gasEstimate.toLocaleString("en-US")} units`;
  }

  const btn = $<HTMLButtonElement>("swap");
  const label =
    !m.swap ? `Quote only on ${m.name}: swaps run on Sepolia`
    : !current ? (quoting ? "Quoting…" : "Enter an amount")
    : !q ? "No liquidity for this amount"
    : !account ? "Connect wallet to swap"
    : balances[tIn.symbol] !== undefined && balances[tIn.symbol] < current.amountIn ? `Not enough ${tIn.symbol}`
    : busy ? "Swapping…"
    : "Swap";
  btn.textContent = label;
  btn.disabled = label !== "Swap" && label !== "Connect wallet to swap";

  renderSent();
}

function renderSent() {
  const m = market();
  $("sentNone").hidden = sent.length > 0;
  $("sent").hidden = sent.length === 0;
  if (sent.length) {
    $("sentCount").textContent = `${sent.length} request${sent.length === 1 ? "" : "s"}`;
    $("sentHost").textContent = new URL(m.rpc).hostname;
    $("sentList").replaceChildren(
      ...sent.map(({ to, body }) => {
        const li = document.createElement("li");
        try {
          const data = JSON.parse(body).params[0].data as Hex;
          const isQuoter = to === m.v4.quoter.toLowerCase();
          const { functionName, args } = decodeFunctionData({ abi: isQuoter ? ABI.quoter : ABI.stateView, data }) as { functionName: string; args: any[] };
          if (isQuoter) {
            const p = args[0];
            const [t0, t1] = m.tokens as [Token, Token];
            const [tI, tO] = p.zeroForOne ? [t0, t1] : [t1, t0];
            li.textContent = `Quoter.${functionName}: pool ${t0.symbol}/${t1.symbol} ${feePct(p.poolKey.fee)}, ${tI.symbol} → ${tO.symbol}, exactAmount ${p.exactAmount} (${fmt(p.exactAmount, tI.decimals)} ${tI.symbol})`;
          } else li.textContent = `StateView.${functionName}: pool id ${short(args[0])}`;
        } catch {
          li.textContent = `${short(to)}: ${body.length} bytes`;
        }
        return li;
      }),
    );
    const mine = account && sent.some((s) => s.body.toLowerCase().includes(account!.slice(2).toLowerCase()));
    const el = $("sentAddr");
    el.className = `small ${account ? (mine ? "bad" : "ok") : ""}`;
    el.textContent = account
      ? mine ? `Your address ${short(account)} is in one of them.` : `Your address ${short(account)} is in none of them.`
      : "No wallet connected, so no address to send. Connected, the requests are the same.";
    $("sentBody").textContent = JSON.stringify(JSON.parse(sent.at(-1)!.body), null, 2);
  }
  const host = new URL(m.rpc).hostname;
  $("canary").textContent = "__canaryShim" in W
    ? `Canary is on this page: while protection is on, it answers these reads through anon-rpc, so ${host} doesn't see your IP either.`
    : `Without Canary, these reads go straight to ${host}, which sees your IP. With Canary they go through anon-rpc.`;
  const links = (Object.entries({ Quoter: m.v4.quoter, StateView: m.v4.stateView, "Universal Router": m.v4.universalRouter, Permit2: m.v4.permit2, PoolManager: m.v4.poolManager }) as [string, string][]).map(([name, a]) =>
    Object.assign(document.createElement("a"), { href: `${m.explorer}/address/${a}`, textContent: name, target: "_blank", rel: "noopener" }),
  );
  $("contracts").replaceChildren(`${m.name}: `, ...links.flatMap((a, i) => (i ? [" · ", a] : [a])));
}

/* --- actions --------------------------------------------------------------- */

async function swap() {
  if (!account) return connect();
  if (!current?.best || busy) return;
  busy = true;
  render();
  try {
    await onSepolia(provider!);
    const c = client();
    const { key } = current.best;
    const amountIn = current.amountIn;
    // A fresh quote right before signing, so the minimum is from the pool as it is now.
    const fresh = await bestQuote(c, chainId, [key], zeroForOne, amountIn);
    if (!fresh) throw new Error("the pool can't fill this amount now");
    const tokenIn = zeroForOne ? key.currency0 : key.currency1;
    for (const a of await approvalCalls(c, chainId, tokenIn, account, amountIn)) await sendTx(a.what, a);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const { link } = await sendTx("Swap", swapExactInSingle({ chainId, key, zeroForOne, amountIn, minAmountOut: minOut(fresh.amountOut, SLIPPAGE_BPS), deadline }));
    const [, tOut] = tokens();
    status(`Swapped. At least ${fmt(minOut(fresh.amountOut, SLIPPAGE_BPS), tOut.decimals)} ${tOut.symbol} received.`, "ok", link);
  } catch (e: any) {
    status(`Not swapped: ${e?.shortMessage ?? e?.message ?? e}`, "bad", e?.link);
  } finally {
    busy = false;
    await refreshBalances();
    void requote();
  }
}

async function mint() {
  const t = market().tokens.find((x: Token) => x.mintable);
  if (!account || !t) return;
  try {
    await onSepolia(provider!);
    const { link } = await sendTx(`Mint 1,000 ${t.symbol}`, { to: t.address, data: encodeFunctionData({ abi: ABI.erc20, functionName: "mint", args: [account, parseUnits("1000", t.decimals)] }), value: 0n });
    status(`1,000 ${t.symbol} minted.`, "ok", link);
  } catch (e: any) {
    status(`Not minted: ${e?.shortMessage ?? e?.message ?? e}`, "bad", e?.link);
  }
  await refreshBalances();
}

/* --- wiring ---------------------------------------------------------------- */

let timer: ReturnType<typeof setTimeout> | undefined;
// The quote on screen, and the swap it arms, are for the amount last quoted: drop them as soon as
// the amount changes, so Swap can't send an amount that is no longer in the box.
$("amountIn").addEventListener("input", () => {
  clearTimeout(timer);
  ++seq;
  current = null;
  sent = [];
  quoting = $<HTMLInputElement>("amountIn").value.trim() !== "";
  render();
  timer = setTimeout(requote, 350);
});
$("flip").addEventListener("click", () => (clearTimeout(timer), ++seq, (quoting = false), (zeroForOne = !zeroForOne), ($<HTMLInputElement>("amountIn").value = ""), (current = null), (sent = []), render()));
$("connect").addEventListener("click", () => void connect());
$("swap").addEventListener("click", () => void swap());
$("mint").addEventListener("click", () => void mint());
$<HTMLSelectElement>("chain").value = String(chainId);
$("chain").addEventListener("change", async (e) => {
  chainId = Number((e.target as HTMLSelectElement).value);
  history.replaceState(null, "", chainId === 11155111 ? location.pathname : `?chain=${chainId}`);
  zeroForOne = true;
  clearTimeout(timer);
  ++seq;
  current = null;
  sent = [];
  quoting = $<HTMLInputElement>("amountIn").value.trim() !== "";
  await refreshBalances();
  void requote();
});
render();
