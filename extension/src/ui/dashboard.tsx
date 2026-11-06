// Canary dashboard: an extension page with the whole picture for one session
// (a page you have open, or an earlier one from history), the site's ENS
// manifest, and settings. Opened from the popup.

import { Alert, Button, Card, Label, ListBox, Select, Switch, Tabs, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { CATEGORY_LABEL } from "../shared.js";
import { Download, Eye, Info, Route, Shield, Slash, Warn } from "./icons.js";
import {
  applyTheme, CHAIN_NAME, coverage, day, hostOf, manifestOf, send, short, verdictOf,
  type Coverage, type Filter, type ManifestView, type Recipient, type SessionSummary, type Settings, type Site, type TabState, type Worker,
} from "./model.js";
import {
  CopyText, CoverageBar, CoverageBlock, cx, Empty, EventRow, Eyebrow, FILTER_LABEL, FilterChips, Logo, manifestStatusFor, ManifestStatus,
  Outcome, ProtectionSwitch, RowStatus, Tone, useFiltered,
} from "./parts.js";

declare const chrome: any;

type Overview = {
  worker: Worker;
  live: SessionSummary[];
  history: SessionSummary[];
  settings: Settings;
  sites: Record<string, Site>;
  addresses: { wallet: string[]; manual: string[]; all: string[] };
  readEndpoints: Record<string, string>;
  network: string;
  pipeline?: { calls: number; requests: number; cacheHits: number; shared: number };
};
type Session = { key: string; live: boolean; tabId?: number; state: TabState; site: Site };
type Page = "overview" | "activity" | "manifest" | "settings";
const PAGES: [Page, string][] = [["overview", "Overview"], ["activity", "Activity"], ["manifest", "ENS Manifest"], ["settings", "Settings"]];

const pageFromHash = (): Page => (PAGES.find(([p]) => `#${p}` === location.hash)?.[0] ?? "overview");

function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [ov, setOv] = useState<Overview | null>(null);
  const [key, setKey] = useState<string | undefined>(() => {
    const q = new URLSearchParams(location.search);
    return q.get("tabId") ? `tab:${q.get("tabId")}` : q.get("session") ?? undefined;
  });
  const [ses, setSes] = useState<Session | null>(null);
  const [activityFilter, setActivityFilter] = useState<Filter | "all">("all");

  const refresh = useCallback(async () => {
    const o = await send<Overview>({ type: "overview" });
    setOv(o);
    applyTheme(o.settings.theme);
    const k = key ?? o.live[0]?.key ?? o.history[0]?.key;
    if (k && k !== key) setKey(k);
    setSes(k ? await send<Session | null>({ type: "session", key: k }) : null);
  }, [key]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    const on = () => setPage(pageFromHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const go = (p: Page, filter?: Filter | "all") => {
    if (filter) setActivityFilter(filter);
    location.hash = p;
    setPage(p);
    scrollTo({ top: 0 });
  };
  const pick = (k: string) => {
    setKey(k);
    const u = new URL(location.href);
    u.searchParams.delete("tabId");
    u.searchParams.set("session", k);
    history.replaceState(null, "", u);
  };
  const setSite = async (patch: Partial<Site>) => {
    if (!ses) return;
    await send({ type: "setSite", origin: ses.state.origin, patch });
    await refresh();
  };

  const tab = ses?.state ?? null;
  const cov = useMemo(() => coverage(tab?.counts), [tab]);
  const m = useMemo(() => manifestOf(tab), [tab]);
  const sessions = ov ? [...ov.live, ...ov.history] : [];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1180px] items-center gap-8 px-6">
          <Logo size="lg" />
          <nav className="flex gap-1" aria-label="Sections">
            {PAGES.map(([p, label]) => (
              <button
                key={p}
                onClick={() => go(p)}
                aria-current={page === p ? "page" : undefined}
                className={cx("rounded-lg px-3 py-1.5 text-[15px] transition-colors", page === p ? "font-semibold text-ink" : "text-ink-2 hover:bg-surface-secondary hover:text-ink")}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="ml-auto">
            {ses?.live ? <ProtectionSwitch on={ses.site.enabled} onChange={(v) => setSite({ enabled: v })} /> : <span className="text-[13px] text-muted">{ses ? "Earlier session" : ""}</span>}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-6 pb-16 pt-8">
        {!ov ? null : page === "settings" ? (
          <SettingsPage ov={ov} refresh={refresh} />
        ) : !ses || !tab ? (
          <div className="mx-auto max-w-lg pt-10">
            <h1 className="font-display text-[34px] font-bold tracking-[-0.01em] text-ink">Nothing to show yet</h1>
            <p className="mt-2 text-ink-2">Open a dapp with Canary on, then come back here from the popup. Sessions stay on this device only.</p>
          </div>
        ) : page === "overview" ? (
          <OverviewPage ses={ses} tab={tab} cov={cov} m={m} sessions={sessions} pick={pick} go={go} worker={ov.worker} />
        ) : page === "activity" ? (
          <ActivityPage ses={ses} tab={tab} cov={cov} m={m} sessions={sessions} pick={pick} filter={activityFilter} setFilter={setActivityFilter} ov={ov} historyDays={ov.settings.historyDays} />
        ) : (
          <ManifestPage ses={ses} tab={tab} m={m} go={go} refresh={refresh} />
        )}
      </main>
    </div>
  );
}

/* --- layout bits --------------------------------------------------------- */

function PageHead({ eyebrow, title, children, actions }: { eyebrow?: ReactNode; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-6">
      <div className="max-w-3xl">
        {eyebrow && <p className="mb-2 text-[13px] text-ink-2">{eyebrow}</p>}
        <h1 className="font-display text-[40px] font-bold leading-[1.08] tracking-[-0.01em] text-ink">{title}</h1>
        {children && <p className="mt-3 text-[17px] leading-relaxed text-ink-2">{children}</p>}
      </div>
      {actions && <div className="flex gap-2.5">{actions}</div>}
    </div>
  );
}

function Panel({ eyebrow, title, children, className, aside }: { eyebrow?: string; title?: ReactNode; children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <Card className={cx("rounded-2xl p-6", className)}>
      {(eyebrow || title) && (
        <Card.Header className="mb-4 flex-row items-start justify-between gap-4 p-0">
          <div>
            {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
            {title && <Card.Title className="mt-1 font-display text-[19px] font-semibold tracking-[-0.01em] text-ink">{title}</Card.Title>}
          </div>
          {aside}
        </Card.Header>
      )}
      <Card.Content className="p-0">{children}</Card.Content>
    </Card>
  );
}

function SessionList({ sessions, current, pick, compact }: { sessions: SessionSummary[]; current?: string; pick: (k: string) => void; compact?: boolean }) {
  if (!sessions.length) return <p className="px-2 py-3 text-[13px] text-muted">No sessions yet.</p>;
  return (
    <ul className="space-y-1">
      {sessions.map((s) => {
        const c = coverage(s.counts);
        const host = hostOf(s.origin);
        return (
          <li key={s.key}>
            <button
              onClick={() => pick(s.key)}
              className={cx("flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors", s.key === current ? "bg-wash" : "hover:bg-surface-secondary")}
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-surface-secondary font-display text-[14px] font-semibold uppercase text-accent">
                {host.replace(/^www\./, "")[0]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-ink">{s.ens ?? host}</span>
                <span className="block truncate text-[12px] text-ink-2">
                  {s.live ? <span className="text-protect">Open now</span> : day(s.until ?? s.since)}
                  {s.ens ? ` · ${host}` : ""}
                </span>
              </span>
              {!compact && (
                <span className="flex shrink-0 gap-1">
                  {c.protected > 0 && <Outcome f="protected" label={String(c.protected)} />}
                  {c.blocked > 0 && <Outcome f="blocked" label={String(c.blocked)} />}
                  {c.exposed > 0 && <Outcome f="exposed" label={String(c.exposed)} />}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* --- Overview ------------------------------------------------------------ */

function OverviewPage({ ses, tab, cov, m, sessions, pick, go, worker }: { ses: Session; tab: TabState; cov: Coverage; m: ManifestView; sessions: SessionSummary[]; pick: (k: string) => void; go: (p: Page, f?: Filter | "all") => void; worker: Worker }) {
  const host = hostOf(tab.origin);
  const held = tab.counts.failedClosed;
  const things: { icon: ReactNode; title: string; text: ReactNode; chip: ReactNode }[] = [];
  if (cov.protected)
    things.push({
      icon: <Route size={20} className="text-protect" />,
      title: `${cov.protected} balance and contract ${cov.protected === 1 ? "read" : "reads"} went through anon-rpc`,
      text: "Answered by Canary's read endpoint over Tor. The dapp's RPC provider never got them, and nobody saw your IP.",
      chip: <Outcome f="protected" count={cov.protected} />,
    });
  if (cov.partial)
    things.push({
      icon: <Shield size={20} className="text-partial" />,
      title: `${cov.partial} ${cov.partial === 1 ? "call" : "calls"} reached the dapp's provider through anon-rpc`,
      text: "The provider still saw these requests, but not your IP.",
      chip: <Outcome f="partial" count={cov.partial} />,
    });
  if (tab.counts.blocked)
    things.push({
      icon: <Slash size={20} className="text-block" />,
      title: `${tab.counts.blocked} ${tab.counts.blocked === 1 ? "request" : "requests"} carrying your address ${tab.counts.blocked === 1 ? "was" : "were"} stopped`,
      text: "They never left your browser, so your address did not reach them.",
      chip: <Outcome f="blocked" count={tab.counts.blocked} />,
    });
  if (held)
    things.push({
      icon: <Slash size={20} className="text-block" />,
      title: `${held} ${held === 1 ? "read was" : "reads were"} held back while anon-rpc was down`,
      text: "The dapp got an error instead of the request going out from your IP.",
      chip: <Outcome f="blocked" label="Held back" count={held} />,
    });
  if (cov.exposed)
    things.push({
      icon: <Eye size={20} className="text-expose" />,
      title: `${cov.exposed} ${cov.exposed === 1 ? "request" : "requests"} still went out unprotected`,
      text: (
        <>
          {tab.counts.direct ? "Some were sent directly because you allowed it on this site. " : ""}Mostly first-party calls Canary can't reroute without breaking the dapp.{" "}
          <button className="text-link underline underline-offset-2" onClick={() => go("activity", "exposed")}>See which</button>
        </>
      ),
      chip: <Outcome f="exposed" count={cov.exposed} />,
    });

  const last = tab.events?.at(-1)?.t ?? tab.until ?? tab.since;
  return (
    <>
      <PageHead
        eyebrow={`${ses.live ? "Current site" : "Earlier session"} · ${host} · measured ${day(last)}`}
        title={<>See what this dapp shares,<br />and with whom.</>}
        actions={
          <>
            {ses.live && ses.tabId !== undefined && (
              <Button variant="outline" onPress={() => chrome.tabs.reload(ses.tabId)}>Reload page</Button>
            )}
            <Button variant="primary" onPress={() => go("activity")}>Review activity</Button>
          </>
        }
      >
        Canary watched every request {host} made that it could see, answered reads through anon-rpc, and stopped third-party requests carrying your address. Here is what it measured.
      </PageHead>

      <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
        <div className="space-y-6">
          <Panel eyebrow="Measured RPC coverage" title={`Coverage on ${host}`}>
            <CoverageBlock cov={cov} at={last} />
          </Panel>
          <Panel eyebrow="What Canary did" title={things.length ? `${things.length === 1 ? "One thing" : `${["", "", "Two", "Three", "Four", "Five"][things.length]} things`} changed on this page` : "Nothing yet"}>
            {things.length ? (
              <ul className="divide-y divide-line border-t border-line">
                {things.map((t) => (
                  <li key={t.title} className="flex items-start gap-4 py-4">
                    <span className="mt-0.5 shrink-0">{t.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[16px] font-medium text-ink">{t.title}</span>
                      <span className="mt-0.5 block text-[14px] text-ink-2">{t.text}</span>
                    </span>
                    <span className="shrink-0">{t.chip}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="No requests observed yet">Reload the page with Canary on to measure it.</Empty>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          <div className="flex gap-3 rounded-2xl bg-wash p-5">
            <Info size={18} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <p className="text-[15px] font-medium text-ink">Canary reduces what leaks. It does not make you anonymous.</p>
              <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
                The dapp itself always sees your address and IP, and transactions you sign are public on-chain.
                {cov.notInspected ? ` ${cov.notInspected} ${cov.notInspected === 1 ? "request" : "requests"} on this site couldn't be inspected.` : ""}
                {worker.state === "failed" ? " anon-rpc is unreachable right now." : ""}
              </p>
            </div>
          </div>

          <Panel eyebrow="ENS privacy manifest" title="Declared vs observed" aside={<ManifestStatus m={m} />}>
            {"ens" in m && m.ens && <div><CopyText text={m.ens} /></div>}
            <p className="mt-3 text-[14px] leading-relaxed text-ink-2">
              {m.kind === "ok"
                ? `The manifest declares ${m.rows.filter((r) => r.status !== "undeclared").length} recipients. ${m.undeclared ? `Canary saw ${m.undeclared} more that ${m.undeclared === 1 ? "is" : "are"} not declared.` : "Nothing undeclared observed so far."}`
                : m.text}
            </p>
            <button className="mt-3 self-start text-[14px] font-medium text-link underline underline-offset-2" onClick={() => go("manifest")}>Open manifest</button>
          </Panel>

          <Panel eyebrow="History" title="Recent sessions">
            <SessionList sessions={sessions.slice(0, 6)} current={ses.key} pick={pick} />
          </Panel>
        </div>
      </div>
    </>
  );
}

/* --- Activity ------------------------------------------------------------ */

function ActivityPage({ ses, tab, cov, m, sessions, pick, filter, setFilter, ov, historyDays }: { ses: Session; tab: TabState; cov: Coverage; m: ManifestView; sessions: SessionSummary[]; pick: (k: string) => void; filter: Filter | "all"; setFilter: (f: Filter | "all") => void; ov: Overview; historyDays: number }) {
  const host = hostOf(tab.origin);
  const [view, setView] = useState<"requests" | "evidence" | "compare">("requests");
  const { shown, counts } = useFiltered(tab, filter);
  const total = Object.values(tab.counts).reduce((a, b) => a + b, 0);
  const listed = (tab.events ?? []).reduce((a, e) => a + (e.n ?? 1), 0);
  const last = tab.events?.at(-1)?.t ?? tab.until ?? tab.since;
  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), session: tab, site: ses.site }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `canary-${host}-${new Date(tab.since).toISOString().slice(0, 16).replace(/[:T]/g, "")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <>
      <PageHead
        title="Activity"
        actions={
          <>
            {ses.live && ses.tabId !== undefined && <Button variant="outline" onPress={() => chrome.tabs.reload(ses.tabId)}>Reload page</Button>}
            <Button variant="outline" onPress={exportJson}><Download size={15} /> Export evidence (JSON)</Button>
          </>
        }
      >
        Every request Canary observed on {host}, {day(tab.since)} – {time(last)}.
      </PageHead>

      <div className="grid gap-6 lg:grid-cols-[290px_1fr]">
        <aside>
          <p className="mb-2 px-2"><Eyebrow>Sessions</Eyebrow></p>
          <div className="rounded-2xl border border-line bg-surface p-2">
            <SessionList sessions={sessions} current={ses.key} pick={pick} compact />
          </div>
          <p className="mt-3 px-2 text-[13px] text-muted">History stays on this device. Kept for {historyDays} days.</p>
        </aside>

        <div className="min-w-0 space-y-5">
          <Panel eyebrow="Measured RPC coverage" title="This session">
            <CoverageBlock cov={cov} at={last} />
          </Panel>

          <Tabs selectedKey={view} onSelectionChange={(k) => setView(k as typeof view)}>
            <Tabs.ListContainer className="w-fit">
              <Tabs.List aria-label="Activity views">
                <Tabs.Tab id="requests" className="whitespace-nowrap">Requests <span className="ml-1.5 text-[12px] tabular-nums text-ink-2">{total}</span><Tabs.Indicator /></Tabs.Tab>
                <Tabs.Tab id="evidence" className="whitespace-nowrap">Technical evidence<Tabs.Indicator /></Tabs.Tab>
                <Tabs.Tab id="compare" className="whitespace-nowrap">Before / after<Tabs.Indicator /></Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>

            <Tabs.Panel id="requests" className="space-y-3 pt-4">
              <FilterChips value={filter} onChange={setFilter} counts={counts} />
              {shown.length ? (
                <div className="space-y-2">
                  {shown.slice(0, 250).map((e, i) => <EventRow key={`${e.t}-${i}`} e={e} inManifest={manifestStatusFor(m, e.host, e.firstParty)} />)}
                </div>
              ) : (
                <Empty title={filter === "all" ? "Nothing observed yet" : `No ${FILTER_LABEL[filter as Filter].toLowerCase()} requests in this session`} />
              )}
              {listed < total && (
                <p className="text-[13px] text-muted">The list keeps the latest {tab.events?.length ?? 0} observations; the counts above cover all {total}.</p>
              )}
            </Tabs.Panel>

            <Tabs.Panel id="evidence" className="pt-4">
              <Evidence tab={tab} ov={ov} />
            </Tabs.Panel>

            <Tabs.Panel id="compare" className="pt-4">
              <Compare tab={tab} cov={cov} />
            </Tabs.Panel>
          </Tabs>
        </div>
      </div>
    </>
  );
}

function Evidence({ tab, ov }: { tab: TabState; ov: Overview }) {
  const recips = Object.values(tab.recipients).sort((a, b) => sum(b) - sum(a));
  const lat = [...tab.latencies].sort((a, b) => a - b);
  const pct = (q: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : 0);
  return (
    <div className="space-y-5">
      <Panel eyebrow="By destination" title="Who this page talked to">
        {recips.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="text-ink-2">
                <tr className="border-b border-line">
                  <th className="py-2 pr-4 font-medium">Destination</th>
                  <th className="py-2 pr-4 font-medium">Party</th>
                  <th className="py-2 pr-4 font-medium">Channels</th>
                  <th className="py-2 pr-4 font-medium">Your address</th>
                  <th className="py-2 font-medium">What Canary did</th>
                </tr>
              </thead>
              <tbody>
                {recips.map((r: Recipient) => (
                  <tr key={r.host} className="border-b border-line align-top last:border-0">
                    <td className="py-2.5 pr-4 font-mono text-[12px] text-ink">
                      {r.host}
                      {r.methods.length > 0 && <div className="mt-0.5 font-sans text-[12px] text-muted">{r.methods.slice(0, 4).join(", ")}{r.methods.length > 4 ? "…" : ""}</div>}
                    </td>
                    <td className="py-2.5 pr-4 text-ink-2">{r.firstParty ? "First" : "Third"}</td>
                    <td className="py-2.5 pr-4 text-ink-2">{r.channels.join(", ")}</td>
                    <td className="py-2.5 pr-4 text-ink-2">{r.carriedAddress ? "Seen in requests" : "Not seen"}</td>
                    <td className="py-2.5 text-ink-2">
                      {Object.entries(r.categories).map(([k, n]) => (
                        <div key={k}>{CATEGORY_LABEL[k as keyof typeof CATEGORY_LABEL]} × {n}</div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No destinations yet" />
        )}
      </Panel>
      <div className="grid gap-5 md:grid-cols-2">
        <Panel eyebrow="anon-rpc" title="How reads went">
          <dl className="space-y-2 text-[14px]">
            <Row k="Network" v={ov.network} />
            <Row k="Tor client" v={ov.worker.state === "ready" ? `ready${ov.worker.bootMs ? `, booted in ${(ov.worker.bootMs / 1000).toFixed(1)} s` : ""}` : ov.worker.state} />
            <Row k="Read latency" v={lat.length ? `p50 ${pct(0.5)} ms · p95 ${pct(0.95)} ms (n=${lat.length})` : "no reads yet"} />
            <Row k="From cache" v={`${tab.noRequest ?? 0} calls answered without a request`} />
            {ov.pipeline?.calls ? <Row k="All tabs" v={`${ov.pipeline.calls} calls sent as ${ov.pipeline.requests} anon-rpc requests`} /> : null}
            <Row k="Read endpoints" v={Object.keys(ov.readEndpoints).map((c) => CHAIN_NAME[Number(c)] ?? `chain ${c}`).join(", ")} />
          </dl>
        </Panel>
        <Panel eyebrow="Notes" title="What Canary flagged">
          {tab.notes.length ? (
            <ul className="list-disc space-y-1.5 pl-5 text-[14px] text-ink-2">{tab.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          ) : (
            <p className="text-[14px] text-ink-2">Nothing unusual on this page.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: ReactNode }) => (
  <div className="flex gap-3">
    <dt className="w-32 shrink-0 text-ink-2">{k}</dt>
    <dd className="min-w-0 text-ink">{v}</dd>
  </div>
);
const sum = (r: Recipient) => Object.values(r.categories).reduce((a, b) => a + (b ?? 0), 0);

/** The same requests, without Canary: what each group would have done. Worked out from this session's own observations. */
function Compare({ tab, cov }: { tab: TabState; cov: Coverage }) {
  const c = tab.counts;
  const rpc = c.protected + c.protectedIpOnly + c.failedClosed;
  const without: Coverage = { protected: 0, partial: 0, blocked: 0, exposed: cov.total, total: cov.total, good: 0, notInspected: cov.notInspected, other: cov.other };
  const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;
  const rows: [string, string, ReactNode][] = [
    [n(c.protected, "read call", "read calls"), "Sent to the dapp's RPC provider from your IP, next to your address", <Outcome f="protected" label="Answered over anon-rpc" />],
    [n(c.protectedIpOnly, "other RPC call", "other RPC calls"), "Sent to the dapp's RPC provider from your IP", <Outcome f="partial" label="Forwarded over anon-rpc" />],
    [n(c.blocked, "request carrying your address", "requests carrying your address"), "Reached third parties with your address", <Outcome f="blocked" label="Stopped in the browser" />],
    [n(c.failedClosed, "read while anon-rpc was down", "reads while anon-rpc was down"), "Sent from your IP", <Outcome f="blocked" label="Held back" />],
    [n(c.detected + c.direct, "unprotected request", "unprotected requests"), "Sent as written", <Outcome f="exposed" label="Same: sent as written" />],
  ];
  return (
    <div className="space-y-5">
      <div className="grid gap-5 md:grid-cols-2">
        <Panel eyebrow="Without Canary" title={`${cov.total} of ${cov.total} would have gone out`}>
          <CoverageBar cov={without} />
          <p className="mt-3 text-[14px] text-ink-2">Every one of these requests leaves from your IP, and {rpc} RPC calls tie your IP to your address at the provider.</p>
        </Panel>
        <Panel eyebrow="With Canary" title={`${cov.good} of ${cov.total} protected or blocked`}>
          <CoverageBar cov={cov} />
          <p className="mt-3 text-[14px] text-ink-2">{cov.exposed ? `${cov.exposed} still went out unprotected.` : "Nothing observed went out unprotected."}</p>
        </Panel>
      </div>
      <Panel eyebrow="Row by row" title="Same requests, two outcomes">
        <table className="w-full text-left text-[14px]">
          <thead className="text-[13px] text-ink-2">
            <tr className="border-b border-line">
              <th className="py-2 pr-4 font-medium">Requests</th>
              <th className="py-2 pr-4 font-medium">Without Canary</th>
              <th className="py-2 font-medium">With Canary</th>
            </tr>
          </thead>
          <tbody>
            {rows.filter(([label]) => !label.startsWith("0 ")).map(([label, a, b]) => (
              <tr key={label} className="border-b border-line last:border-0">
                <td className="py-3 pr-4 font-medium text-ink">{label}</td>
                <td className="py-3 pr-4 text-ink-2">{a}</td>
                <td className="py-3">{b}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-[13px] text-muted">Worked out from what Canary observed in this session, not from a second run.</p>
      </Panel>
    </div>
  );
}

/* --- ENS manifest -------------------------------------------------------- */

function ManifestPage({ ses, tab, m, go, refresh }: { ses: Session; tab: TabState; m: ManifestView; go: (p: Page, f?: Filter | "all") => void; refresh: () => Promise<void> }) {
  const v = "verdict" in m ? verdictOf(m.verdict) : null;
  const undeclared = m.kind === "ok" ? m.rows.filter((r) => r.status === "undeclared") : [];
  const unblocked = undeclared.map((r) => r.host).filter((h) => !ses.site.blockHosts.includes(h));
  const recipients = tab.recipients;
  // What actually reached a host. Requests Canary answered itself or stopped never did.
  const receives = (host: string) => {
    const r = recipients[host];
    if (!r) return null;
    const has = (...ks: string[]) => ks.some((k) => (r.categories as Record<string, number | undefined>)[k]);
    const sent = has("protectedIpOnly", "detected", "direct");
    const what = [r.carriedAddress && sent && "Wallet address", r.methods.length > 0 && sent && "RPC calls", has("detected", "direct", "backend", "notInspected") && "IP"].filter(Boolean);
    return what.length ? what.join(", ") : "Nothing: Canary answered or stopped every request";
  };
  const hosts = undeclared.map((r) => r.host);
  const list = hosts.length > 1 ? `${hosts.slice(0, -1).join(", ")} and ${hosts.at(-1)}` : hosts[0];
  const them = hosts.length === 1 ? "it" : "them";
  const block = async (hosts: string[]) => {
    await send({ type: "blockHosts", origin: tab.origin, hosts });
    await refresh();
  };
  const unblock = async (host: string) => {
    await send({ type: "unblockHost", origin: tab.origin, host });
    await refresh();
  };

  return (
    <>
      <PageHead title="ENS privacy manifest">
        A dapp can publish, in its ENS name, who gets your data and why. Canary compares that promise with what it actually saw.
      </PageHead>

      <div className="-mt-4 mb-6 flex flex-wrap items-center gap-2">
        {"ens" in m && m.ens && <CopyText text={m.ens} />}
        <ManifestStatus m={m} />
        {v && <Tone tone={v.tone}>{v.title}</Tone>}
      </div>

      {undeclared.length > 0 && (
        <Alert status="danger" className="mb-6 rounded-2xl border-0 bg-expose-soft">
          <Alert.Indicator><Warn size={18} /></Alert.Indicator>
          <Alert.Content>
            <Alert.Title className="text-expose">{undeclared.length} {undeclared.length === 1 ? "recipient is" : "recipients are"} not in the manifest</Alert.Title>
            <Alert.Description className="text-ink">
              This page tried to send your address or RPC calls to {list}, but {"ens" in m ? m.ens : "the site"} does not declare {them}. What actually reached {them} is listed below.{" "}
              {unblocked.length ? `Canary can block ${them} for this site.` : `You blocked ${them} on this site.`}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div>
          {m.kind === "ok" ? (
            <>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-display text-[24px] font-semibold tracking-[-0.01em] text-ink">Recipients</h2>
                <p className="text-[13px] text-ink-2">
                  {m.rows.length - undeclared.length} declared · {undeclared.length} undeclared · compared with {ses.live ? "this session" : `the session of ${day(tab.since)}`}
                </p>
              </div>
              <div className="space-y-3">
                {m.rows.map((r) => (
                  <div key={r.host + r.status} className="rounded-2xl border border-line bg-surface p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[16px] font-medium text-ink">{r.host}</p>
                        <p className="font-mono text-[12px] text-ink-2">{r.status === "undeclared" ? "Not in manifest" : r.kind}</p>
                      </div>
                      <RowStatus s={r.status} />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-8 gap-y-1 text-[14px]">
                      <span><span className="text-ink-2">Receives </span><b className="font-medium text-ink">{receives(r.host) ?? "Nothing seen this session"}</b></span>
                      {r.purpose && <span><span className="text-ink-2">Purpose </span><b className="font-medium text-ink">{r.purpose}</b></span>}
                      {ses.site.blockHosts.includes(r.host) && (
                        <span className="text-block">
                          Blocked on this site ·{" "}
                          <button className="underline underline-offset-2" onClick={() => unblock(r.host)}>Unblock</button>
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-4">
                {unblocked.length > 0 && (
                  <Button variant="danger-soft" onPress={() => block(unblocked)}>
                    <Slash size={15} /> Block undeclared {unblocked.length === 1 ? "recipient" : "recipients"}
                  </Button>
                )}
                <button className="text-[14px] font-medium text-link" onClick={() => go("activity", "all")}>See the requests</button>
              </div>
              {unblocked.length > 0 && <p className="mt-2 text-[13px] text-muted">Blocking applies to this site from now on. Some dapps need undeclared hosts to work; you can unblock them here.</p>}
            </>
          ) : (
            <Panel title={m.kind === "pending" ? "Checking…" : m.kind === "none" ? "No manifest named" : "No usable manifest"}>
              <p className="text-[15px] text-ink-2">{m.text}</p>
              {v && <p className="mt-3 text-[14px] text-ink-2"><b className="font-medium text-ink">{v.title}:</b> {v.text}</p>}
              <p className="mt-3 text-[14px] text-ink-2">
                A site names its manifest with <code className="font-mono text-[12px]">/.well-known/canary.json</code> pointing at an ENS name with a <code className="font-mono text-[12px]">privacy.manifest</code> text record.
              </p>
            </Panel>
          )}
        </div>

        <div className="space-y-6">
          <Panel eyebrow="Technical evidence" title="Manifest record">
            <dl className="rounded-xl bg-inset px-4 text-[13px]">
              {[
                ["ENS name", "ens" in m && m.ens ? <span className="font-mono">{m.ens}</span> : "—"],
                ["Text record", <span className="font-mono">privacy.manifest</span>],
                ["Chain", m.kind === "ok" ? CHAIN_NAME[m.chainId] ?? `chain ${m.chainId}` : "—"],
                ["Verdict", v ? v.text : "None on this name"],
                ["Resolved", m.kind === "pending" ? "Not yet" : `${day(tab.since)}, via anon-rpc`],
              ].map(([k, val], i) => (
                <div key={String(k)} className={cx("grid grid-cols-[100px_1fr] gap-3 py-2.5", i > 0 && "border-t border-line")}>
                  <dt className="text-ink-2">{k}</dt>
                  <dd className="min-w-0 break-words text-ink">{val}</dd>
                </div>
              ))}
            </dl>
          </Panel>
          <Panel eyebrow="How to read this" title="Four outcomes">
            <ul className="space-y-3 text-[14px] text-ink-2">
              <li className="flex items-start gap-3"><Tone tone="good">Matches</Tone><span>Declared and seen.</span></li>
              <li className="flex items-start gap-3"><Tone tone="bad">Undeclared</Tone><span>Seen, but not promised.</span></li>
              <li className="flex items-start gap-3"><Tone tone="muted">Not observed</Tone><span>Promised, not seen this session. Not a failure.</span></li>
              <li className="flex items-start gap-3"><Tone tone="warn">Unverified</Tone><span>The record or its signature couldn't be checked.</span></li>
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}

/* --- Settings ------------------------------------------------------------ */

function SettingRow({ title, children, control, boxed }: { title: string; children: ReactNode; control: ReactNode; boxed?: boolean }) {
  return (
    <div className={cx("flex items-start justify-between gap-6 py-4", !boxed && "first:pt-0 last:pb-0")}>
      <div className="min-w-0">
        <p className="text-[15px] font-medium text-ink">{title}</p>
        <p className="mt-0.5 text-[14px] leading-relaxed text-ink-2">{children}</p>
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Switch isSelected={on} onChange={onChange} aria-label={label}>
      <Switch.Control><Switch.Thumb /></Switch.Control>
    </Switch>
  );
}

function SettingsPage({ ov, refresh }: { ov: Overview; refresh: () => Promise<void> }) {
  const [addr, setAddr] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const set = async (patch: Partial<Settings>) => (await send({ type: "setSettings", patch }), await refresh());
  const setSite = async (origin: string, patch: Partial<Site>) => (await send({ type: "setSite", origin, patch }), await refresh());
  const sites = Object.entries(ov.sites).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="grid gap-10 lg:grid-cols-[280px_1fr]">
      <div>
        <h1 className="font-display text-[34px] font-bold tracking-[-0.01em] text-ink">Settings</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">Each setting says what it costs as well as what it protects. Changes apply immediately, and stay on this device.</p>
      </div>

      <div className="space-y-6">
        <Panel title="Sites">
          {sites.length ? (
            <div className="divide-y divide-line">
              {sites.map(([origin, s]) => (
                <div key={origin} className="py-4 first:pt-0 last:pb-0">
                  <p className="mb-2 font-mono text-[13px] text-ink">{hostOf(origin)}</p>
                  <div className="divide-y divide-line rounded-xl border border-line px-4">
                    <SettingRow boxed title="Protect this site" control={<Toggle label={`Protect ${origin}`} on={{ ...s }.enabled ?? true} onChange={(v) => setSite(origin, { enabled: v })} />}>
                      Reads go through anon-rpc over Tor and third-party requests carrying your address are stopped. Slower: each read takes a Tor round trip. Reload the page to apply.
                    </SettingRow>
                    <SettingRow boxed title="If anon-rpc is down, send reads from my IP" control={<Toggle label={`Direct fallback on ${origin}`} on={!!s.allowDirect} onChange={(v) => setSite(origin, { allowDirect: v })} />}>
                      Keeps the dapp working when Tor can't be reached, at the cost of your IP going to its RPC provider. Off: the dapp gets an error instead.
                    </SettingRow>
                    {(s.blockHosts ?? []).length > 0 && (
                      <SettingRow boxed title="Blocked recipients" control={null}>
                        {s.blockHosts.map((h) => (
                          <span key={h} className="mr-3 inline-flex items-center gap-1.5">
                            <span className="font-mono text-[12px] text-ink">{h}</span>
                            <button className="text-[13px] text-link underline" onClick={async () => (await send({ type: "unblockHost", origin, host: h }), await refresh())}>Unblock</button>
                          </span>
                        ))}
                      </SettingRow>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[14px] text-ink-2">Every site is protected by default. Sites you change from the popup show up here.</p>
          )}
        </Panel>

        <Panel title="Your addresses">
          <p className="text-[14px] text-ink-2">Canary looks for these in what pages send. It learns them from your wallet; you can add others to watch.</p>
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
            {ov.addresses.all.length ? (
              ov.addresses.all.map((a) => (
                <li key={a} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="font-mono text-[13px] text-ink" title={a}>{short(a)}</span>
                  <span className="text-[13px] text-muted">{ov.addresses.wallet.includes(a) ? "from your wallet" : "added by you"}</span>
                  <button className="text-[13px] text-link underline" onClick={async () => (await send({ type: "removeAddress", address: a }), await refresh())}>Remove</button>
                </li>
              ))
            ) : (
              <li className="px-4 py-3 text-[14px] text-ink-2">None yet. Connect a wallet on a dapp, or add one below.</li>
            )}
          </ul>
          <form
            className="mt-3 flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              await send({ type: "addAddress", address: addr.trim() });
              setAddr("");
              await refresh();
            }}
          >
            <input
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              placeholder="0x… an address to watch"
              className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-[var(--field-background)] px-3 font-mono text-[13px] text-ink outline-none focus:border-accent"
            />
            <Button type="submit" variant="outline" isDisabled={!/^0x[0-9a-fA-F]{40}$/.test(addr.trim())}>Add</Button>
          </form>
        </Panel>

        <Panel title="Data and appearance">
          <div className="divide-y divide-line">
            <SettingRow
              title="Keep history for"
              control={
                <Select aria-label="Keep history for" selectedKey={String(ov.settings.historyDays)} onSelectionChange={(k) => set({ historyDays: Number(k) })} className="w-36">
                  <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {[1, 7, 30, 90].map((d) => (
                        <ListBox.Item key={d} id={String(d)} textValue={`${d} days`}>
                          <Label>{d === 1 ? "1 day" : `${d} days`}</Label>
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              }
            >
              Stored only on this device. Nothing is sent to Canary.
            </SettingRow>
            <SettingRow
              title="Theme"
              control={
                <ToggleButtonGroup selectionMode="single" disallowEmptySelection selectedKeys={[ov.settings.theme]} onSelectionChange={(k) => set({ theme: [...(k as Set<string>)][0] as Settings["theme"] })} aria-label="Theme" size="sm">
                  {(["system", "light", "dark"] as const).map((t, i) => (
                    <ToggleButton key={t} id={t}>
                      {i > 0 && <ToggleButtonGroup.Separator />}
                      {t[0].toUpperCase() + t.slice(1)}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
              }
            >
              Follows your system by default.
            </SettingRow>
            <SettingRow
              title="Clear history"
              control={
                confirmClear ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onPress={() => setConfirmClear(false)}>Keep</Button>
                    <Button size="sm" variant="danger" onPress={async () => (await send({ type: "clearHistory" }), setConfirmClear(false), await refresh())}>Clear {ov.history.length}</Button>
                  </div>
                ) : (
                  <Button size="sm" variant="danger-soft" isDisabled={!ov.history.length} onPress={() => setConfirmClear(true)}>Clear history</Button>
                )
              }
            >
              Removes every recorded session and its evidence ({ov.history.length} now). Pages you have open keep their numbers. This cannot be undone.
            </SettingRow>
          </div>
        </Panel>

        <Panel title="Network">
          <dl className="space-y-2 text-[14px]">
            <Row k="anon-rpc network" v={ov.network} />
            <Row k="Tor client" v={ov.worker.state === "failed" ? `unreachable${ov.worker.error ? ` (${ov.worker.error})` : ""}` : ov.worker.state} />
            <Row k="Read endpoints" v={Object.keys(ov.readEndpoints).map((c) => CHAIN_NAME[Number(c)] ?? `chain ${c}`).join(", ")} />
          </dl>
        </Panel>

        <div className="flex gap-3 rounded-2xl border border-line bg-inset p-5">
          <Info size={18} className="mt-0.5 shrink-0 text-ink-2" />
          <div>
            <p className="text-[15px] font-medium text-ink">What Canary cannot inspect</p>
            <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
              Service workers, WebRTC, your wallet extension's own RPC calls, binary or encrypted payloads, and anything the dapp does on its servers. These show as "Not inspected" or not at all, never as safe.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
