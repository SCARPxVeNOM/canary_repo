// Canary popup: renders the service worker's per-tab coverage. Wording follows
// idea.md §4: never "private", "safe" or "leak-free".

import { CATEGORY_LABEL, compareDeclared, type Category } from "./shared.js";

declare const chrome: any;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const COLOR: Record<Category, string> = {
  protected: "var(--green)", protectedIpOnly: "var(--blue)", blocked: "var(--yellow)", detected: "var(--red)",
  backend: "var(--muted)", notInspected: "#6b7280", failedClosed: "var(--amber)", direct: "var(--red)", localNode: "#a78bfa",
};
const ORDER: Category[] = ["protected", "protectedIpOnly", "blocked", "detected", "backend", "notInspected", "failedClosed", "direct", "localNode"];

async function tabId(): Promise<number> {
  const q = new URLSearchParams(location.search).get("tabId");
  if (q) return Number(q);
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t.id;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function render() {
  const id = await tabId();
  const st = await chrome.runtime.sendMessage({ type: "state", tabId: id });
  const w = st.worker ?? { state: "idle" };
  const pill = $("worker");
  pill.className = `pill ${w.state}`;
  pill.textContent =
    w.state === "ready" ? `${w.network} · ready${w.bootMs ? ` (${(w.bootMs / 1000).toFixed(1)} s boot)` : ""}`
    : w.state === "warming" ? `${w.network} · warming up…`
    : w.state === "failed" ? `${w.network} · failed` : `${w.network ?? "anon-rpc"} · idle`;
  if (w.state === "failed") pill.title = w.error ?? "";

  const tab = st.tab;
  if (!tab) {
    $("origin").textContent = "Canary isn't running on this page.";
    $("site").querySelectorAll("label").forEach((l) => ((l as HTMLElement).hidden = true));
    $("headline").textContent = "";
    return;
  }
  $("origin").textContent = tab.origin;
  ($("enabled") as HTMLInputElement).checked = st.site.enabled;
  ($("allowDirect") as HTMLInputElement).checked = st.site.allowDirect;

  const c = tab.counts as Record<Category, number>;
  const rpcTotal = c.protected + c.protectedIpOnly + c.failedClosed + c.direct + c.localNode + rpcDetected(tab);
  const viaAnon = c.protected + c.protectedIpOnly;
  $("headline").innerHTML = !st.site.enabled
    ? `<span class="muted">Protection is off for this site.</span>`
    : rpcTotal
      ? `<b>${viaAnon}/${rpcTotal}</b> RPC calls went through anon-rpc (${Math.round((100 * viaAnon) / rpcTotal)}%)`
      : `<span class="muted">No RPC calls yet on this page.</span>`;
  $("counts").innerHTML = ORDER.filter((k) => c[k] || k === "protected" || k === "blocked")
    .map((k) => `<tr><td><span class="dot" style="background:${COLOR[k]}"></span>${CATEGORY_LABEL[k]}</td><td>${c[k]}</td></tr>`)
    .join("");
  const lat = tab.latencies.length
    ? `anon-rpc latency per request: p50 ${pct(tab.latencies, 50)} ms · p95 ${pct(tab.latencies, 95)} ms (n=${tab.latencies.length})`
    : "";
  const p = st.pipeline;
  // Across all tabs: batching merges calls from every page into fewer Tor requests.
  const saved = p?.calls
    ? `${p.calls} calls sent as ${p.requests} anon-rpc requests (${p.cacheHits + p.shared} answered without one)` +
      (tab.noRequest ? ` · on this page: ${tab.noRequest} from cache` : "")
    : "";
  $("latency").innerHTML = [lat, saved].filter(Boolean).map(esc).join("<br>");

  const recips = Object.values(tab.recipients as Record<string, any>).sort((a: any, b: any) => total(b) - total(a));
  $("recipients").innerHTML = recips.length
    ? recips
        .map((r: any) => {
          const cats = ORDER.filter((k) => r.categories[k])
            .map((k) => `<span class="tag" style="color:${COLOR[k]}">${CATEGORY_LABEL[k]} ×${r.categories[k]}</span>`)
            .join("");
          const meta = [r.firstParty ? "first party" : "third party", r.channels.join(", "), r.carriedAddress ? "contained your address" : ""]
            .filter(Boolean)
            .join(" · ");
          return `<tr><td><div class="host">${esc(r.host)}</div><div class="meta">${esc(meta)}</div>${cats}</td></tr>`;
        })
        .join("")
    : `<tr><td class="empty">Nothing observed yet.</td></tr>`;

  renderDeclared(tab);

  $("notesSec").hidden = !tab.notes.length;
  $("notes").innerHTML = tab.notes.map((n: string) => `<li>${esc(n)}</li>`).join("");

  const a = st.addresses;
  $("addresses").innerHTML = a.all.length
    ? a.all.map((x: string) => `<li>${x.slice(0, 8)}…${x.slice(-6)} <span class="muted">${a.wallet.includes(x) ? "from wallet" : "added"}</span></li>`).join("")
    : `<li class="empty">None yet. Connect a wallet, or add one below.</li>`;
}

const CHAIN_NAME: Record<number, string> = { 1: "mainnet", 11155111: "Sepolia" };
const STATUS_LABEL = { declared: "declared", undeclared: "not declared", notSeen: "declared, not seen on this page" };

/** The site's ENS manifest against what this page was seen sending (idea.md §2). */
function renderDeclared(tab: any) {
  const d = tab.declared ?? { state: "pending" };
  const rows = $("declaredRows");
  rows.innerHTML = "";
  const line = (html: string) => ($("declared").innerHTML = html);
  switch (d.state) {
    case "pending":
      return line("Looking for the site's manifest…");
    case "none":
      return line("This site doesn't name an ENS manifest (no /.well-known/canary.json), so there is nothing declared to compare with.");
    case "notFound":
      return line(`<b>${esc(d.ens)}</b> has no <span class="mono">privacy.manifest</span> record.` + verdictLine(d.verdict));
    case "unbound":
      return line(`<b>${esc(d.ens)}</b> points at ${d.url ? esc(d.url) : "no site"}, not this one, so its manifest isn't used here.`);
    case "invalid":
      return line(`<b>${esc(d.ens)}</b> has a malformed manifest: ${esc(d.error)}` + verdictLine(d.verdict));
    case "error":
      return line(`Couldn't read the manifest${d.ens ? ` of <b>${esc(d.ens)}</b>` : ""}: ${esc(d.error)}`);
  }
  const { rows: rs, undeclared } = compareDeclared(d.manifest, Object.values(tab.recipients));
  const seen = rs.filter((r) => r.status !== "notSeen").length;
  line(
    `Manifest of <b>${esc(d.ens)}</b> (ENS, ${CHAIN_NAME[d.chainId] ?? `chain ${d.chainId}`}, read via anon-rpc). ` +
      (undeclared
        ? `<span class="st-undeclared">${undeclared} recipient${undeclared > 1 ? "s" : ""} not declared.</span>`
        : seen
          ? "No undeclared recipients observed on this page so far."
          : "No recipients observed on this page yet.") +
      ` <span class="muted">What wasn't observed may still be sent.</span>` +
      verdictLine(d.verdict),
  );
  rows.innerHTML = rs
    .map((r) => {
      const meta = [r.kind, r.purpose].filter(Boolean).join(" · ");
      return `<tr><td><div class="host">${esc(r.host)}</div><span class="tag st-${r.status}">${STATUS_LABEL[r.status]}</span>${meta ? `<span class="meta"> ${esc(meta)}</span>` : ""}</td></tr>`;
    })
    .join("");
}

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** A verifier's signed verdict (privacy.verdict.canary), with what Canary could check about it. */
function verdictLine(v: any): string {
  const br = "<br><br>";
  if (!v) return `${br}<span class="muted">No verifier's verdict on this name.</span>`;
  if (v.state === "invalid") return `${br}<span class="st-undeclared">The verdict record is malformed (${esc(v.error)}); ignored.</span>`;
  const r = v.verdict;
  if (!v.signed) return `${br}<span class="st-undeclared">The verdict record's signature doesn't verify; ignored.</span>`;
  if (!v.signerIsVerifier) return `${br}<span class="st-undeclared">The verdict claims to be from ${esc(r.verifier)} but isn't signed by its address; ignored.</span>`;
  if (!v.matchesSite) return `${br}<span class="st-undeclared">The verdict is about ${esc(r.name)} at ${esc(r.origin)}, not this site; ignored.</span>`;
  const what =
    r.result === "matches" ? "no undeclared recipients observed"
    : r.result === "undeclared" ? `<span class="st-undeclared">undeclared recipients: ${r.undeclaredHosts.map(esc).join(", ")}</span>`
    : "incomplete (nothing declared to check against)";
  const role =
    v.delegated === false ? ` <span class="st-undeclared">Independent verification revoked: ${esc(r.verifier)} can no longer write this record.</span>`
    : v.delegated === null ? ` <span class="muted">Whether ${esc(r.verifier)} still holds its role can't be checked on this resolver.</span>`
    : "";
  return (
    `${br}Verdict by <b>${esc(r.verifier)}</b> (signed): ${what}, in ${r.flows.length} flow steps on build <span class="mono">${esc(r.buildHash)}</span>, ${day(r.issuedAt)}.` +
    (v.expired ? ` <span class="st-undeclared">Expired ${day(r.expiresAt)}.</span>` : "") +
    role +
    ` <span class="muted">Build not compared with this page.</span>`
  );
}

function total(r: any) {
  return Object.values(r.categories as Record<string, number>).reduce((x, y) => x + y, 0);
}
function rpcDetected(tab: any) {
  // WebSocket RPC we couldn't substitute is counted as "detected"; only those carry methods.
  return Object.values(tab.recipients as Record<string, any>).reduce(
    (n, r: any) => n + (r.methods.length && r.channels.includes("websocket") ? r.categories.detected ?? 0 : 0),
    0,
  );
}

async function setSite(patch: object) {
  const id = await tabId();
  const st = await chrome.runtime.sendMessage({ type: "state", tabId: id });
  if (!st.tab) return;
  await chrome.runtime.sendMessage({ type: "setSite", origin: st.tab.origin, patch });
  await render();
}

$("enabled").addEventListener("change", (e) => setSite({ enabled: (e.target as HTMLInputElement).checked }));
$("allowDirect").addEventListener("change", (e) => setSite({ allowDirect: (e.target as HTMLInputElement).checked }));
$("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = ($("addInput") as HTMLInputElement).value.trim();
  await chrome.runtime.sendMessage({ type: "addAddress", address: v });
  ($("addInput") as HTMLInputElement).value = "";
  await render();
});

void render();
setInterval(render, 1000);
