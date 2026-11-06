// Canary Swap: a Uniswap v4 swap page whose quotes come from the chain.
//
// app.uniswap.org asks its server for a quote, and the request names you
// (`swapper`, test-artifacts/scans/quote/). Here the quote is an eth_call to
// the v4 Quoter: the pool key and the amount, no address. With Canary
// installed, that call and the balance reads go through anon-rpc, so the RPC
// provider doesn't see your IP either. The swap is one Universal Router
// transaction that your wallet signs and sends (src/v4.js).

import { createPublicClient, createWalletClient, custom, decodeFunctionData, encodeFunctionData, formatUnits, getAddress, http, isAddress, parseUnits, type Address, type Hex } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { MARKETS } from "./markets.js";
import { ABI, approvalCalls, bestQuote, minOut, poolState, swapExactInSingle } from "./v4.js";

type Token = { symbol: string; address: Address; decimals: number; mintable?: boolean };
type Key = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
type Quote = { key: Key; amountOut: bigint; gasEstimate: bigint };
type Provider = {
  request(a: { method: string; params?: unknown[] }): Promise<any>;
  on?(e: string, f: (...a: any[]) => void): void;
  removeListener?(e: string, f: (...a: any[]) => void): void;
};
type Wallet = { id: string; name: string; icon?: string; provider: Provider };

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
let minting = false;
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

// Every wallet that announces itself (EIP-6963), or the one at window.ethereum if none does.
// With more than one, the visitor picks; the pick is remembered for the next visit.
const wallets: Wallet[] = [];
const WALLET_KEY = "canary-swap.wallet";
let wallet: Wallet | undefined;
let connecting: Wallet | undefined;
let attempt = 0; // bumped on every connect: an answer that comes back after another was started is dropped

window.addEventListener("eip6963:announceProvider", (e: any) => {
  const d = e?.detail;
  const p = d?.provider;
  if (!p || typeof p.request !== "function" || wallets.some((w) => w.provider === p || (d.info?.rdns && w.id === d.info.rdns))) return;
  wallets.push({ id: d.info?.rdns || d.info?.uuid || `wallet-${wallets.length}`, name: d.info?.name || "Wallet", icon: d.info?.icon, provider: p });
  if (!$("wallets").hidden) renderWallets();
});
window.dispatchEvent(new Event("eip6963:requestProvider"));
const available = (): Wallet[] =>
  wallets.length ? wallets : W.ethereum && typeof W.ethereum.request === "function" ? [{ id: "injected", name: "Browser wallet", provider: W.ethereum }] : [];

const remember = (id?: string) => {
  try {
    if (id) localStorage.setItem(WALLET_KEY, id);
    else localStorage.removeItem(WALLET_KEY);
  } catch {
    /* storage blocked: nothing to remember */
  }
};

/** Every EIP-1193 error code in a wallet's or viem's error, and in what it wraps. */
function codesOf(e: any, seen = new Set<object>()): number[] {
  if (!e || typeof e !== "object" || seen.has(e)) return [];
  seen.add(e);
  return [...(typeof e.code === "number" ? [e.code] : []), ...codesOf(e.cause, seen), ...codesOf(e.data?.originalError, seen), ...codesOf(e.error, seen)];
}
/** What went wrong, in words, for the status line. */
function why(e: any): string {
  const codes = codesOf(e);
  if (codes.includes(4001)) return "you cancelled it in your wallet";
  if (codes.includes(-32002)) return "your wallet already has a request waiting: open it and answer that one";
  if (codes.includes(4100)) return "this site isn't connected in your wallet: connect again";
  if (codes.includes(4900) || codes.includes(4901)) return "your wallet is offline or on another network";
  return String(e?.shortMessage ?? e?.details ?? e?.message ?? e).replace(/\.$/, "");
}
const firstAddress = (accs: unknown) => (Array.isArray(accs) ? (accs.find((a) => typeof a === "string" && isAddress(a)) as string | undefined) : undefined);

// Wallet events, on the wallet in use only.
const onAccounts = (accs: unknown) => {
  const a = firstAddress(accs);
  account = a ? getAddress(a) : undefined;
  if (!account) (wallet = provider = undefined), remember();
  void refreshBalances();
};
function use(w: Wallet | undefined, a: Address | undefined) {
  if (wallet && wallet !== w) wallet.provider.removeListener?.("accountsChanged", onAccounts);
  if (w && wallet !== w) w.provider.on?.("accountsChanged", onAccounts);
  wallet = w;
  provider = w?.provider;
  account = a;
}

async function connect(chosen?: Wallet) {
  const list = available();
  if (!list.length) return status("No wallet found. Install one (MetaMask, Rabby, …) to swap; quotes work without it.", "bad");
  if (!chosen && list.length > 1) return openWallets();
  const w = chosen ?? list[0];
  closeWallets();
  // Asking the waiting wallet again only gets -32002; another wallet can still be picked meanwhile.
  if (connecting === w) return status(`Approve the connection in ${w.name}.`);
  const my = ++attempt;
  connecting = w;
  renderConnect();
  status(`Approve the connection in ${w.name}.`);
  try {
    const a = firstAddress(await w.provider.request({ method: "eth_requestAccounts" }));
    if (my !== attempt) return;
    if (!a) throw new Error(`${w.name} shared no account`);
    use(w, getAddress(a));
    remember(w.id);
    status("");
  } catch (e) {
    if (my !== attempt) return;
    status(`Not connected: ${why(e)}.`, "bad");
  } finally {
    if (my === attempt) connecting = undefined;
  }
  await refreshBalances();
}

async function disconnect() {
  const w = wallet;
  closeWallets();
  use(undefined, undefined);
  remember();
  // Also drop the site's permission where the wallet supports it, so the next connect asks again.
  w?.provider.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
  status("Disconnected.");
  await refreshBalances();
}

/** The wallet picked last time, if it still has this site connected: no prompt (eth_accounts never asks). */
async function reconnect() {
  let id: string | null = null;
  try {
    id = localStorage.getItem(WALLET_KEY);
  } catch {
    return;
  }
  if (!id) return;
  await new Promise((r) => setTimeout(r, 300)); // wallets announce asynchronously
  const w = available().find((x) => x.id === id);
  if (!w) return;
  const a = firstAddress(await w.provider.request({ method: "eth_accounts" }).catch(() => []));
  if (a && !account && !connecting) {
    use(w, getAddress(a));
    await refreshBalances();
  }
}

function renderConnect() {
  const b = $<HTMLButtonElement>("connect");
  b.textContent = connecting ? "Connecting…" : account ? short(account) : "Connect wallet";
  b.setAttribute("aria-expanded", String(!$("wallets").hidden));
}

/* the wallet menu: pick a wallet, or see the one in use and disconnect */
function renderWallets() {
  const menu = $("wallets");
  const items: (HTMLElement | string)[] = [];
  const p = (text: string) => Object.assign(document.createElement("p"), { textContent: text });
  const btn = (text: string, onClick: () => void, icon?: string) => {
    const b = Object.assign(document.createElement("button"), { type: "button" });
    // EIP-6963 icons are data URIs; anything else isn't loaded.
    if (icon?.startsWith("data:image/")) b.append(Object.assign(document.createElement("img"), { src: icon, alt: "" }));
    b.append(text);
    b.addEventListener("click", onClick);
    return b;
  };
  if (account && wallet) {
    items.push(p(`Connected with ${wallet.name}: ${short(account)}`), btn("Disconnect", () => void disconnect()));
  }
  const others = available().filter((w) => w !== wallet);
  if (others.length) {
    items.push(p(account ? "Use another wallet" : "Choose a wallet"));
    for (const w of others) items.push(btn(connecting === w ? `${w.name} (waiting)` : w.name, () => void connect(w), w.icon));
  }
  menu.replaceChildren(...items);
}
function openWallets() {
  renderWallets();
  $("wallets").hidden = false;
  renderConnect();
  ($("wallets").querySelector("button") as HTMLButtonElement | null)?.focus();
}
function closeWallets() {
  $("wallets").hidden = true;
  renderConnect();
}

const SEPOLIA = MARKETS[11155111];
async function onSepolia(p: Provider) {
  const want = `0x${sepolia.id.toString(16)}`;
  const now = async () => Number(await p.request({ method: "eth_chainId" })); // hex, or a number from some wallets
  if ((await now()) === sepolia.id) return;
  status("Switch your wallet to Sepolia…");
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch (e: any) {
    if (!codesOf(e).includes(4902) && !/unrecognized chain|not been added|unknown chain/i.test(String(e?.message))) throw e;
    // The wallet doesn't know Sepolia yet: adding it switches to it too.
    await p.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: want, chainName: "Sepolia", nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [SEPOLIA.rpc], blockExplorerUrls: [SEPOLIA.explorer] }],
    });
  }
  if ((await now()) !== sepolia.id) throw new Error("your wallet is still on another network: switch it to Sepolia");
}

const walletClient = () => createWalletClient({ account: account!, chain: sepolia, transport: custom(provider!) });

/** Send one transaction from the wallet and wait for it (receipts are reads, so with Canary they come through anon-rpc too). */
async function sendTx(what: string, tx: { to: Address; data: Hex; value: bigint }) {
  status(`${what}: confirm in your wallet…`);
  const hash = await walletClient().sendTransaction(tx);
  let link = { href: `${market().explorer}/tx/${hash}`, text: short(hash) };
  status(`${what}: sent, waiting for it to be mined.`, "", link);
  // Sped up in the wallet, it's the same transaction; cancelled or replaced, it isn't.
  let replaced: string | undefined;
  const r = await client().waitForTransactionReceipt({
    hash,
    onReplaced: (x) => ((replaced = x.reason), (link = { href: `${market().explorer}/tx/${x.transaction.hash}`, text: short(x.transaction.hash) })),
  });
  if (replaced === "cancelled") throw Object.assign(new Error(`${what} was cancelled in your wallet`), { link });
  if (replaced === "replaced") throw Object.assign(new Error(`${what} was replaced by another transaction in your wallet`), { link });
  if (r.status !== "success") throw Object.assign(new Error(`${what} reverted`), { link });
  return { hash: r.transactionHash, link };
}

/* --- balances, quote ------------------------------------------------------- */

const balances: Record<string, bigint> = {};
async function refreshBalances() {
  renderConnect();
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
  $("mint").textContent = minting ? "Minting…" : `Get 1,000 test ${m.tokens.find((t: Token) => t.mintable)?.symbol ?? ""}`;
  $<HTMLButtonElement>("mint").disabled = busy || minting;

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
  if (!current?.best || busy || minting) return;
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
    status(`Not swapped: ${why(e)}.`, "bad", e?.link);
  } finally {
    busy = false;
    render();
    await refreshBalances();
    void requote();
  }
}

async function mint() {
  const t = market().tokens.find((x: Token) => x.mintable);
  if (!account || !t || busy || minting) return;
  minting = true;
  render();
  try {
    await onSepolia(provider!);
    const { link } = await sendTx(`Mint 1,000 ${t.symbol}`, { to: t.address, data: encodeFunctionData({ abi: ABI.erc20, functionName: "mint", args: [account, parseUnits("1000", t.decimals)] }), value: 0n });
    status(`1,000 ${t.symbol} minted.`, "ok", link);
  } catch (e: any) {
    status(`Not minted: ${why(e)}.`, "bad", e?.link);
  } finally {
    minting = false;
    render();
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
// Connect: one wallet connects at once, several open the menu; connected, the menu shows it and Disconnect.
$("connect").addEventListener("click", () => (!$("wallets").hidden ? closeWallets() : account ? openWallets() : void connect()));
document.addEventListener("click", (e) => {
  if (!$("wallets").hidden && !(e.target as Element | null)?.closest?.("#wallets, #connect")) closeWallets();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("wallets").hidden) closeWallets(), $("connect").focus();
});
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
void reconnect();
