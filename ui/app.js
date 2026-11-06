// Canary UI: renders the sample panel from data. Wording follows idea.md §4:
// never "private", "safe" or "leak-free"; "nothing observed" is not "nothing sent".
// Category names match extension/src/shared.ts (CATEGORY_LABEL).
(() => {
  "use strict";

  // Illustrative sample. Replace with the extension's per-tab state later.
  const DATA = {
    site: "leakydash.example",
    ensName: "leakydash.eth",
    counts: { protected: 28, blocked: 3, detected: 0, notInspected: 2, backend: 4 },
    recipients: [
      { host: "rpc-provider.example", party: "third party", channels: ["fetch"], carried: false, cats: [["Protected", 28, "ok"]], declared: { kind: "rpc", purpose: "Read chain state" } },
      { host: "tracker.example", party: "third party", channels: ["fetch", "beacon"], carried: true, cats: [["Blocked", 3, "warn"]], declared: null },
      { host: "api.leakydash.example", party: "first party", channels: ["fetch"], carried: false, cats: [["Backend / indexer", 4, "off"]], declared: { kind: "backend", purpose: "Points and positions" } },
      { host: "stream.leakydash.example", party: "first party", channels: ["websocket"], carried: false, cats: [["Not inspected", 2, "off"]], declared: { kind: "backend", purpose: "Live prices" } },
    ],
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const icon = (name, cls = "") => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  // Coverage = (protected + blocked) / everything Canary classified as an
  // outcome for this page. Backend traffic is listed by destination, not counted.
  const c = DATA.counts;
  const rpcTotal = c.protected;
  const classified = c.protected + c.blocked + c.detected + c.notInspected;
  const coverage = classified ? Math.round((100 * (c.protected + c.blocked)) / classified) : 0;
  const undeclaredBlocked = DATA.recipients.filter((r) => !r.declared);
  const matches = DATA.recipients.every((r) => r.declared || r.cats.every(([n]) => n === "Blocked"));

  const state = { on: true, tab: "overview" };

  function overview() {
    if (!state.on) {
      return `
        <div class="banner banner--off">${icon("warn")}<span>Protection is off for this site.</span></div>
        <p class="note">Reload the page after switching on. While off, this page's requests go out as the dapp wrote them.</p>`;
    }
    return `
      <div class="banner">${icon("shield-check")}<span>Reads protected, leaks blocked</span></div>
      <div class="rows">
        <div class="row">${icon("bolt")}<span class="row-label">Reads via anon-rpc (EF)</span><span class="chip chip--ok">${icon("check", "i-sm")}${c.protected}/${rpcTotal}</span></div>
        <div class="row">${icon("ban")}<span class="row-label">3rd-party leaks blocked</span><span class="chip chip--ok">${c.blocked} blocked</span></div>
        <div class="row">${icon("doc")}<span class="row-label">ENS privacy manifest</span><span class="chip ${matches ? "chip--ok" : "chip--warn"}">${matches ? `Matches ${icon("check", "i-sm")}` : "Mismatch"}</span></div>
        <div class="row">${icon("bars")}<span class="row-label">Coverage</span><span class="chip chip--ok">${coverage}% protected</span></div>
      </div>
      <p class="note">Coverage counts protected and blocked requests out of all ${classified} classified. ${c.notInspected} not inspected. Backend traffic is listed under Activity.</p>`;
  }

  function activity() {
    const items = DATA.recipients.map((r) => {
      const tags = r.cats.map(([n, k, tone]) => `<span class="chip chip--${tone}">${esc(n)} ×${k}</span>`).join("");
      const meta = [r.party, r.channels.join(", "), r.carried ? "contained your address" : ""].filter(Boolean).join(" · ");
      return `<li class="item"><div class="item-host">${esc(r.host)}</div><div class="item-meta">${esc(meta)}</div><div class="tags">${tags}</div></li>`;
    });
    return `<p class="note">What the page tried to send, and what Canary did with it.</p><ul class="list">${items.join("")}</ul>`;
  }

  function manifest() {
    const declared = DATA.recipients.filter((r) => r.declared).map((r) => {
      const seen = r.cats.some(([n]) => n === "Not inspected")
        ? `<span class="chip chip--off">Not inspected</span>`
        : `<span class="chip chip--ok">${icon("check", "i-sm")}Observed</span>`;
      return `<li class="item"><div class="item-head"><span class="item-host">${esc(r.host)}</span>${seen}</div><div class="item-meta">${esc(r.declared.kind)} · ${esc(r.declared.purpose)}</div></li>`;
    });
    const extra = undeclaredBlocked.map((r) => {
      const n = r.cats.reduce((a, [, k]) => a + k, 0);
      return `<li class="item"><div class="item-head"><span class="item-host">${esc(r.host)}</span><span class="chip chip--warn">Undeclared, blocked ×${n}</span></div><div class="item-meta">Not in the manifest. Carried your address, so Canary stopped it.</div></li>`;
    });
    return `
      <p class="note">Declared in <strong>${esc(DATA.ensName)}</strong> (ENSv2) versus observed on this page.</p>
      <ul class="list">${declared.join("")}${extra.join("")}</ul>
      <p class="note">${extra.length} undeclared recipient${extra.length === 1 ? "" : "s"} blocked before delivery. A match is not a promise: see “Not inspected”.</p>`;
  }

  function render() {
    $("view").innerHTML = state.tab === "overview" ? overview() : state.tab === "activity" ? activity() : manifest();
    $("view").setAttribute("aria-labelledby", `tab-${state.tab}`);
    document.querySelectorAll(".tabs [role=tab]").forEach((t) => {
      const sel = t.id === `tab-${state.tab}`;
      t.setAttribute("aria-selected", String(sel));
      t.tabIndex = sel ? 0 : -1;
    });
    const sw = $("switch");
    sw.setAttribute("aria-checked", String(state.on));
    $("switch-label").textContent = state.on ? "Protection On" : "Protection Off";
  }

  $("switch").addEventListener("click", () => { state.on = !state.on; render(); });

  const tabs = [...document.querySelectorAll(".tabs [role=tab]")];
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => { state.tab = t.id.replace("tab-", ""); render(); });
    t.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const n = tabs[(i + d + tabs.length) % tabs.length];
      state.tab = n.id.replace("tab-", "");
      render();
      n.focus();
    });
  });

  render();
})();
