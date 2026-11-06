// The notice Canary shows on the page when you connect a wallet: the site's
// privacy label (privacy-label.ts). In a shadow root so the page's styles
// don't reach it, built from text nodes only. The page can still see or
// remove it: Canary protects you from third parties, not from the page.

import type { PrivacyLabel } from "./privacy-label.js";

const CSS = `
:host { all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 344px; max-width: calc(100vw - 32px);
  --bg: #ffffff; --ink: #112a33; --ink2: #485d64; --muted: #6b8089; --line: #d7e4ea; --accent: #0e6b80;
  --good: #0a6b72; --bad: #ae381c; --warn: #865601; }
@media (prefers-color-scheme: dark) {
  :host { --bg: #102c37; --ink: #e8f3f8; --ink2: #b4cbd3; --muted: #8eaab5; --line: #1f4250; --accent: #4fb7c0;
    --good: #4fb7c0; --bad: #eb9882; --warn: #e0b25a; }
}
.box { box-sizing: border-box; background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 14px;
  padding: 14px 16px; font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 8px 28px rgb(17 42 51 / 0.18); }
.head { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--ink2); }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
.head span.t { flex: 1; letter-spacing: 0.02em; }
button { all: unset; cursor: pointer; color: var(--muted); font-size: 18px; line-height: 1; padding: 0 2px; }
button:focus-visible { outline: 2px solid var(--accent); border-radius: 4px; }
h2 { margin: 8px 0 0; font-size: 15px; font-weight: 600; line-height: 1.3; }
.good { color: var(--good); } .bad { color: var(--bad); } .warn { color: var(--warn); } .muted { color: var(--ink); }
ul { list-style: none; margin: 8px 0 0; padding: 0; }
li { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; font-size: 13px; }
li .h { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
li .k { color: var(--ink2); flex-shrink: 0; }
p { margin: 8px 0 0; font-size: 12.5px; color: var(--ink2); }
p.w { color: var(--warn); }
p.by { color: var(--muted); font-size: 12px; }
`;

const SHOWN_MS = 12_000;
const MAX_ROWS = 4;

function el(tag: string, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function showNotice(l: PrivacyLabel) {
  document.querySelector("[data-canary-notice]")?.remove();
  const host = document.createElement("div");
  host.setAttribute("data-canary-notice", "");
  const root = host.attachShadow({ mode: "open" });
  root.append(el("style", undefined, CSS));

  const box = el("div", "box");
  box.setAttribute("role", "status");
  const head = el("div", "head");
  const close = el("button", undefined, "×");
  close.setAttribute("aria-label", "Dismiss");
  close.addEventListener("click", () => host.remove());
  head.append(el("span", "dot"), el("span", "t", `Canary · privacy label for ${location.hostname}`), close);
  box.append(head, el("h2", l.tone, l.title));

  if (l.rows.length) {
    const ul = el("ul");
    for (const r of l.rows.slice(0, MAX_ROWS)) {
      const li = el("li");
      li.append(el("span", "h", r.host), el("span", "k", r.kind));
      ul.append(li);
    }
    if (l.rows.length > MAX_ROWS) ul.append(el("li", "k", `and ${l.rows.length - MAX_ROWS} more, in the Canary popup`));
    box.append(ul);
  }
  if (l.warning) box.append(el("p", "w", l.warning));
  box.append(el("p", undefined, "Protection is on: Canary stops third-party requests that carry your address, and answers reads through anon-rpc."));
  if (l.by) box.append(el("p", "by", l.by));
  root.append(box);
  (document.body ?? document.documentElement).append(host);

  let timer = setTimeout(() => host.remove(), SHOWN_MS);
  host.addEventListener("mouseenter", () => clearTimeout(timer));
  host.addEventListener("mouseleave", () => (timer = setTimeout(() => host.remove(), SHOWN_MS / 3)));
}
