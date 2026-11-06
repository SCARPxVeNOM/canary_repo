// Canary popup: this page's coverage in three tabs, Overview / Activity / Manifest.

import { Button, Tabs } from "@heroui/react";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Globe } from "./icons.js";
import {
  activeTabId, applyTheme, coverage, declaredCount, hostOf, manifestOf, send,
  type Coverage, type Filter, type ManifestView, type Settings, type Site, type TabState, type Worker,
} from "./model.js";
import { CoverageBlock, Empty, EventRow, FILTER_LABEL, FilterChips, headline, LabelCard, Logo, manifestStatusFor, ManifestStatus, ProtectionSwitch, RowStatus, Summary, useFiltered, cx } from "./parts.js";
import { verdictOf } from "./model.js";
import { privacyLabel } from "../privacy-label.js";

declare const chrome: any;

type State = { worker: Worker; tab: TabState | null; site: Site | null; settings: Settings; pipeline?: any };

function App() {
  const [tabId, setTabId] = useState<number>();
  const [st, setSt] = useState<State | null>(null);
  const [view, setView] = useState<"overview" | "activity" | "manifest">("overview");

  useEffect(() => {
    let live = true;
    let id: number | undefined;
    const tick = async () => {
      id ??= await activeTabId();
      if (!live || id === undefined) return;
      setTabId(id);
      const s = await send<State>({ type: "state", tabId: id });
      if (live) setSt(s), applyTheme(s.settings?.theme);
    };
    void tick();
    const t = setInterval(tick, 1000);
    return () => ((live = false), clearInterval(t));
  }, []);

  const tab = st?.tab ?? null;
  const cov = useMemo(() => coverage(tab?.counts), [tab]);
  const m = useMemo(() => manifestOf(tab), [tab]);

  const setSite = async (patch: Partial<Site>) => {
    if (!tab) return;
    await send({ type: "setSite", origin: tab.origin, patch });
    setSt(await send<State>({ type: "state", tabId }));
  };
  const openDashboard = (hash = "") => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${tabId !== undefined && tab ? `?tabId=${tabId}` : ""}${hash}`) });
    window.close();
  };

  return (
    <div className="flex h-[600px] w-[380px] flex-col bg-background">
      <header className="shrink-0 border-b border-line bg-surface px-4 pb-3 pt-3.5">
        <div className="flex items-center justify-between">
          <Logo />
          <ProtectionSwitch on={!!st?.site?.enabled} disabled={!tab} onChange={(v) => setSite({ enabled: v })} />
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-surface-secondary px-3 py-2">
          <Globe size={15} className="shrink-0 text-ink-2" />
          <span id="origin" className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
            {tab ? hostOf(tab.origin) : st ? "No dapp on this page" : "…"}
          </span>
          {tab && <ManifestStatus m={m} />}
        </div>
      </header>

      {!st ? (
        <div className="flex-1" />
      ) : !tab ? (
        <div className="flex-1 p-4">
          <Empty title="Canary isn't running on this page">
            It works on http and https pages. Open a dapp, or open the dashboard to look at earlier sessions.
          </Empty>
        </div>
      ) : (
        <Tabs selectedKey={view} onSelectionChange={(k) => setView(k as typeof view)} className="flex min-h-0 flex-1 flex-col">
          <Tabs.ListContainer className="mx-4 mt-3 shrink-0">
            <Tabs.List aria-label="Popup sections" className="w-full">
              {(["overview", "activity", "manifest"] as const).map((k) => (
                <Tabs.Tab key={k} id={k} className="flex-1">
                  {k === "overview" ? "Overview" : k === "activity" ? "Activity" : "Manifest"}
                  <Tabs.Indicator />
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.ListContainer>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3">
            <Tabs.Panel id="overview">
              <Overview tab={tab} site={st.site!} cov={cov} m={m} worker={st.worker} />
            </Tabs.Panel>
            <Tabs.Panel id="activity">
              <Activity tab={tab} m={m} />
            </Tabs.Panel>
            <Tabs.Panel id="manifest">
              <Manifest tab={tab} m={m} site={st.site!} onBlock={async (hosts) => (await send({ type: "blockHosts", origin: tab.origin, hosts }), setSt(await send({ type: "state", tabId })))} openDashboard={() => openDashboard("#manifest")} />
            </Tabs.Panel>
          </div>
        </Tabs>
      )}

      <footer className="flex shrink-0 gap-2.5 border-t border-line bg-surface px-4 py-3">
        <Button variant="outline" className="flex-1" isDisabled={!tab} onPress={() => setView("activity")}>
          View activity
        </Button>
        <Button variant="primary" className="flex-1" onPress={() => openDashboard(view === "activity" ? "#activity" : view === "manifest" ? "#manifest" : "")}>
          Open dashboard
        </Button>
      </footer>
    </div>
  );
}

/* --- Overview ------------------------------------------------------------ */

function workerLine(w: Worker, tab: TabState) {
  const p = (q: number) => {
    const s = [...tab.latencies].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
  };
  const state = w.state === "ready" ? `ready${w.bootMs ? `, booted in ${(w.bootMs / 1000).toFixed(1)} s` : ""}` : w.state === "warming" ? "connecting to Tor…" : w.state === "failed" ? "unreachable" : "idle";
  const lat = tab.latencies.length ? ` · typical read ${(p(0.5) / 1000).toFixed(1)} s` : "";
  return `anon-rpc ${state}${lat}`;
}

function Overview({ tab, site, cov, m, worker }: { tab: TabState; site: Site; cov: Coverage; m: ManifestView; worker: Worker }) {
  const [title, sub] = headline(tab, site, cov, worker);
  return (
    <div className="space-y-4">
      <div>
        <h1 id="headline" className="font-display text-[21px] font-bold leading-[1.2] tracking-[-0.01em] text-ink">{title}</h1>
        <p className="mt-1.5 text-[14px] leading-snug text-ink-2">{sub}</p>
      </div>
      <Summary tab={tab} cov={cov} m={m} worker={worker} />
      <LabelCard l={privacyLabel(tab.declared)} />
      <section className="rounded-2xl border border-line bg-surface p-4">
        <CoverageBlock cov={cov} at={lastEvent(tab)} compact />
      </section>
      <p className="flex items-center gap-2 text-[12px] text-muted">
        <span className={cx("h-1.5 w-1.5 rounded-full", worker.state === "ready" ? "bg-protect" : worker.state === "failed" ? "bg-expose" : "bg-partial")} />
        {workerLine(worker, tab)}
      </p>
    </div>
  );
}

const lastEvent = (tab: TabState) => tab.events?.at(-1)?.t ?? tab.since;

/* --- Activity ------------------------------------------------------------ */

function Activity({ tab, m }: { tab: TabState; m: ManifestView }) {
  const [filter, setFilter] = useState<Filter | "all">("all");
  const { shown, counts } = useFiltered(tab, filter);
  const total = Object.values(tab.counts).reduce((a, b) => a + b, 0);
  return (
    <div className="space-y-3">
      <p className="text-right text-[12px] text-muted">
        Latest first · {total} this session
      </p>
      <FilterChips value={filter} onChange={setFilter} counts={counts} />
      <div className="space-y-2">
        {shown.length ? (
          shown.slice(0, 60).map((e, i) => <EventRow key={`${e.t}-${i}`} e={e} compact inManifest={manifestStatusFor(m, e.host, e.firstParty)} defaultOpen={i === 0 && filter !== "all"} />)
        ) : (
          <Empty title={filter === "all" ? "Nothing observed yet" : `No ${FILTER_LABEL[filter as Filter].toLowerCase()} requests`}>
            {filter === "all" ? "Requests show up here as the page makes them." : "Nothing in this group on this page so far."}
          </Empty>
        )}
        {shown.length > 60 && <p className="text-center text-[12px] text-muted">Showing the latest 60. The dashboard has all of them.</p>}
      </div>
    </div>
  );
}

/* --- Manifest ------------------------------------------------------------ */

function Manifest({ tab, m, site, onBlock, openDashboard }: { tab: TabState; m: ManifestView; site: Site; onBlock: (hosts: string[]) => void; openDashboard: () => void }) {
  const v = m.kind === "ok" || m.kind === "notFound" || m.kind === "invalid" ? verdictOf((m as any).verdict) : null;
  const undeclared = m.kind === "ok" ? m.rows.filter((r) => r.status === "undeclared").map((r) => r.host) : [];
  const unblocked = undeclared.filter((h) => !site.blockHosts.includes(h));
  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">Declared vs observed</h2>
        <p className="mt-1 text-[13px] leading-snug text-ink-2">
          A dapp can publish in its ENS name who gets your data. Canary compares that promise with what this page sent.
        </p>
      </div>
      {m.kind !== "ok" ? (
        <>
          <div id="declared" className="rounded-xl border border-line bg-surface p-3.5 text-[14px] text-ink">
            {m.text}
            {v && <p className="mt-2 text-[13px] text-ink-2"><b className="font-medium text-ink">{v.title}:</b> {v.text}</p>}
          </div>
          {"label" in m && m.label && <LabelCard l={m.label} />}
        </>
      ) : (
        <>
          <div id="declared" className="rounded-xl border border-line bg-surface p-3.5 text-[14px] text-ink">
            <p>
              <b className="font-semibold">{m.ens}</b> declares {declaredCount(m)}.{" "}
              {m.undeclared ? (
                <span className="text-expose">Canary saw {m.undeclared} more that {m.undeclared === 1 ? "is" : "are"} not declared.</span>
              ) : m.seen ? (
                "No undeclared recipients observed so far."
              ) : (
                "No recipients observed on this page yet."
              )}
            </p>
            {v && <p className="mt-2 text-[13px] text-ink-2"><b className="font-medium text-ink">{v.title}:</b> {v.text}</p>}
            <p className="mt-2 text-[12px] text-muted">Read from ENS through anon-rpc. What wasn't observed may still be sent.</p>
          </div>
          <div id="declaredRows" className="space-y-1.5">
            {m.rows.map((r) => (
              <div key={r.host + r.status} className="flex items-start justify-between gap-2 rounded-xl border border-line bg-surface px-3.5 py-2.5">
                <div className="min-w-0">
                  <p className="truncate font-mono text-[12.5px] text-ink">{r.host}</p>
                  <p className="text-[12px] text-ink-2">
                    {[r.kind, r.purpose].filter(Boolean).join(" · ") || "Not in manifest"}
                    {site.blockHosts.includes(r.host) && " · blocked on this site"}
                  </p>
                </div>
                <RowStatus s={r.status} />
              </div>
            ))}
          </div>
          {unblocked.length > 0 && (
            <Button variant="danger-soft" className="w-full" onPress={() => onBlock(unblocked)}>
              Block undeclared {unblocked.length === 1 ? "recipient" : "recipients"} on this site
            </Button>
          )}
        </>
      )}
      <button className="text-[13px] font-medium text-link underline-offset-2 hover:underline" onClick={openDashboard}>
        Open the full manifest view
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
