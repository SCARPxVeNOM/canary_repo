// Pieces the popup and the dashboard share.

import { Button, Chip, Disclosure, Switch, Tag, TagGroup } from "@heroui/react";
import { useMemo, type ReactNode } from "react";
import { CATEGORY_LABEL } from "../shared.js";
import { Check, Chevron, Copy, Dotted, Eye, Half, Hatch, Shield, Slash, Warn } from "./icons.js";
import {
  ago, BUCKET_LABEL, BUCKETS, channelLabel, clock, filterOf, ipVisible, sentenceOf, short, titleOf,
  type Bucket, type Coverage, type Ev, type Filter, type ManifestView, type Site, type TabState, type Worker,
} from "./model.js";

export const cx = (...xs: (string | number | false | null | undefined)[]) => xs.filter(Boolean).join(" ");

/* --- brand --------------------------------------------------------------- */

export function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className={cx("inline-flex items-center gap-2 font-display font-bold tracking-[-0.01em] text-ink", size === "lg" ? "text-[22px]" : "text-[19px]")}>
      <span aria-hidden className="relative inline-flex items-center">
        <span className="h-2.5 w-2.5 rounded-full bg-accent" />
        <span className="ml-[3px] h-2.5 w-[5px] rounded-r-full border-[1.5px] border-l-0 border-accent" />
      </span>
      Canary
    </span>
  );
}

export function ProtectionSwitch({ on, disabled, onChange }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <Switch isSelected={on} isDisabled={disabled} onChange={onChange} aria-label="Protection on this site" className="flex-row items-center gap-2.5">
      <Switch.Control>
        <Switch.Thumb />
      </Switch.Control>
      <Switch.Content>
        <span className="text-sm font-medium text-ink">{disabled ? "No site" : on ? "Protection on" : "Protection off"}</span>
      </Switch.Content>
    </Switch>
  );
}

/* --- the four outcomes --------------------------------------------------- */

export const BUCKET_ICON: Record<Filter, (p: { size?: number; className?: string }) => ReactNode> = {
  protected: Shield,
  partial: Half,
  blocked: Slash,
  exposed: Eye,
  notInspected: Dotted,
  other: Check,
};
const TONE: Record<Filter, { text: string; soft: string }> = {
  protected: { text: "text-protect", soft: "bg-protect-soft" },
  partial: { text: "text-partial", soft: "bg-partial-soft" },
  blocked: { text: "text-block", soft: "bg-block-soft" },
  exposed: { text: "text-expose", soft: "bg-expose-soft" },
  notInspected: { text: "text-ink-2", soft: "bg-transparent dashed" },
  other: { text: "text-ink-2", soft: "bg-surface-secondary" },
};
export const FILTER_LABEL: Record<Filter, string> = { ...BUCKET_LABEL, notInspected: "Not inspected", other: "No address found" };
export const BAR_COLOR: Record<Bucket, string> = { protected: "bg-protect", partial: "bg-partial", blocked: "bg-block", exposed: "bg-expose" };

/** A status chip: icon, label, and optionally a count. */
export function Outcome({ f, count, label, size = "sm", bare }: { f: Filter; count?: number; label?: string; size?: "sm" | "md"; bare?: boolean }) {
  const I = BUCKET_ICON[f];
  const t = TONE[f];
  return (
    <Chip size={size} className={cx("gap-1 whitespace-nowrap border-0", t.text, !bare && t.soft, bare && "bg-transparent px-0")}>
      <I size={size === "sm" ? 12 : 14} />
      <Chip.Label>
        {label ?? FILTER_LABEL[f]}
        {count !== undefined && <span className="ml-1 tabular-nums opacity-90">· {count}</span>}
      </Chip.Label>
    </Chip>
  );
}

export function Tone({ tone, children, icon }: { tone: "good" | "bad" | "warn" | "muted"; children: ReactNode; icon?: ReactNode }) {
  const c = { good: "text-protect bg-protect-soft", bad: "text-expose bg-expose-soft", warn: "text-partial bg-partial-soft", muted: "text-ink-2 bg-surface-secondary" }[tone];
  return (
    <Chip size="sm" className={cx("gap-1 whitespace-nowrap border-0", c)}>
      {icon}
      <Chip.Label>{children}</Chip.Label>
    </Chip>
  );
}

export function CoverageBar({ cov, className }: { cov: Coverage; className?: string }) {
  if (!cov.total) return <div className={cx("h-2.5 rounded-full bg-surface-secondary", className)} />;
  return (
    <div className={cx("bar flex h-2.5 overflow-hidden rounded-full", className)} role="img" aria-label={BUCKETS.map((b) => `${BUCKET_LABEL[b]} ${cov[b]}`).join(", ")}>
      {BUCKETS.filter((b) => cov[b]).map((b) => (
        <span key={b} className={BAR_COLOR[b]} style={{ flexGrow: cov[b], flexBasis: 0, minWidth: 6 }} />
      ))}
    </div>
  );
}

export function Legend({ cov, className }: { cov: Coverage; className?: string }) {
  return (
    <div className={cx("flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-ink-2", className)}>
      {BUCKETS.map((b) => {
        const I = BUCKET_ICON[b];
        return (
          <span key={b} className="inline-flex items-center gap-1.5">
            <I size={14} className={TONE[b].text} />
            {BUCKET_LABEL[b]} <b className="font-semibold tabular-nums text-ink">{cov[b]}</b>
          </span>
        );
      })}
    </div>
  );
}

/** "41 of 52 observed requests protected or blocked", the bar, the legend and what wasn't counted. */
export function CoverageBlock({ cov, at, compact }: { cov: Coverage; at?: number; compact?: boolean }) {
  return (
    <div>
      <div className={cx("flex flex-wrap items-baseline gap-x-2", compact ? "" : "justify-between")}>
        <p className="leading-snug text-ink-2">
          <span className={cx("mr-1.5 font-display font-bold tracking-[-0.01em] text-ink", compact ? "text-[26px]" : "text-[28px]")}>
            {cov.good} of {cov.total}
          </span>
          observed requests protected or blocked
        </p>
        {at !== undefined && <span className="text-[13px] text-muted">Measured {ago(at)}{compact ? "" : ` · ${cov.total + cov.notInspected + cov.other} requests`}</span>}
      </div>
      <CoverageBar cov={cov} className="mt-3" />
      <Legend cov={cov} className="mt-3" />
      {(cov.notInspected > 0 || cov.other > 0) && (
        <div className="mt-3 space-y-1.5 border-t border-dashed border-line pt-3 text-[13px] text-ink-2">
          {cov.notInspected > 0 && (
            <p className="flex items-start gap-2">
              <Hatch size={13} className="mt-[3px] shrink-0 text-muted" />
              <span>
                {cov.notInspected} {cov.notInspected === 1 ? "request" : "requests"} not inspected: excluded from the count above, not assumed safe.
              </span>
            </p>
          )}
          {cov.other > 0 && (
            <p className="flex items-start gap-2">
              <Check size={13} className="mt-[3px] shrink-0 text-muted" />
              <span>
                {cov.other} other {cov.other === 1 ? "request" : "requests"} carried none of your addresses (dapp APIs, a local node). Listed in Activity.
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* --- one observation ----------------------------------------------------- */

export function EvidenceTable({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(92px,auto)_1fr] rounded-lg bg-inset px-3 text-[13px]">
      {rows.map(([k, v], i) => (
        <div key={k} className={cx("contents")}>
          <dt className={cx("py-2 pr-3 text-ink-2", i && "border-t border-line")}>{k}</dt>
          <dd className={cx("min-w-0 break-words py-2 text-ink", i && "border-t border-line")}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function evidenceOf(e: Ev, inManifest?: string): [string, ReactNode][] {
  const rows: [string, ReactNode][] = [
    ["Outcome", CATEGORY_LABEL[e.category]],
    ["Destination", <span className="font-mono text-[12px]">{e.host || "—"}</span>],
    ["Sent by", `${e.firstParty ? "the dapp (first party)" : "a third party"} · ${channelLabel(e)}`],
    ["Your address", e.address ? <span className="font-mono text-[12px]">{short(e.address)}{e.encoding && e.encoding !== "hex" ? ` (${e.encoding})` : ""}</span> : e.category === "notInspected" ? "Unknown" : e.note === "its URL carried your address" ? "In the URL" : "None found"],
    ["IP visible", ipVisible(e)],
  ];
  if (e.methods?.length) rows.push(["RPC calls", <span className="font-mono text-[12px]">{e.n > 1 ? `${e.n} × ` : ""}{[...new Set(e.methods)].join(", ")}</span>]);
  if (e.ms !== undefined) rows.push(["Round trip", `${e.ms} ms`]);
  if (inManifest) rows.push(["In manifest", inManifest]);
  if (e.note) rows.push(["Note", e.note]);
  rows.push(["Time", new Date(e.t).toLocaleString()]);
  return rows;
}

export function EventRow({ e, inManifest, compact, defaultOpen }: { e: Ev; inManifest?: string; compact?: boolean; defaultOpen?: boolean }) {
  const t = titleOf(e);
  const f = e.category === "notInspected" ? "notInspected" : (({ protected: "protected", protectedIpOnly: "partial", blocked: "blocked", failedClosed: "blocked", detected: "exposed", direct: "exposed" }) as Record<string, Filter>)[e.category] ?? "other";
  return (
    <Disclosure defaultExpanded={defaultOpen} className="rounded-xl border border-line bg-surface">
      <Disclosure.Heading>
        <Disclosure.Trigger className={cx("flex w-full items-start gap-3 text-left", compact ? "px-3.5 py-3" : "px-4 py-3.5")}>
          {!compact && (
            <span className="w-[136px] shrink-0 pt-0.5">
              <Outcome f={f} label={e.category === "failedClosed" ? "Held back" : undefined} />
            </span>
          )}
          <span className="min-w-0 flex-1">
            {compact && (
              <span className="mb-1 block">
                <Outcome f={f} label={e.category === "failedClosed" ? "Held back" : undefined} />
              </span>
            )}
            <span className="block truncate text-[15px] font-medium text-ink">
              {t.code && <code className="mr-1.5 font-mono text-[13px]">{t.code}</code>}
              {t.text}
            </span>
            <span className="mt-0.5 block truncate text-[13px] text-ink-2">
              {channelLabel(e)} · {e.host || "unknown host"} · {clock(e.t)}
              {e.n > 1 && ` · ${e.n} calls`}
            </span>
          </span>
          <Disclosure.Indicator className="mt-1 shrink-0">
            <Chevron size={16} />
          </Disclosure.Indicator>
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className={cx("space-y-3 pb-4", compact ? "px-3.5" : "px-4 sm:pl-[164px]")}>
          <p className="text-[14px] leading-relaxed text-ink">{sentenceOf(e)}</p>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-2">Technical evidence</p>
          <EvidenceTable rows={evidenceOf(e, inManifest)} />
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

/* --- small things -------------------------------------------------------- */

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-2">{children}</p>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center">
      <p className="font-medium text-ink">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-2">{children}</p>}
    </div>
  );
}

export function CopyText({ text, label }: { text: string; label?: string }) {
  return (
    <Button
      size="sm"
      variant="tertiary"
      className="h-7 gap-1.5 rounded-md bg-surface-secondary px-2 font-mono text-[12px] text-ink"
      onPress={() => void navigator.clipboard?.writeText(text)}
      aria-label={`Copy ${text}`}
    >
      <span className="max-w-[180px] truncate">{label ?? text}</span>
      <Copy size={13} className="text-ink-2" />
    </Button>
  );
}

export function ManifestStatus({ m }: { m: ManifestView }) {
  if (m.kind === "ok") return m.undeclared ? <Tone tone="bad" icon={<Warn size={12} />}>{m.undeclared} undeclared</Tone> : <Tone tone="good" icon={<Check size={12} />}>Matches manifest</Tone>;
  if (m.kind === "pending") return <Tone tone="muted" icon={<Dotted size={12} />}>Checking</Tone>;
  if (m.kind === "none" || m.kind === "notFound") return <Tone tone="muted" icon={<Dotted size={12} />}>No manifest</Tone>;
  return <Tone tone="warn" icon={<Dotted size={12} />}>Unverified</Tone>;
}

export function RowStatus({ s }: { s: "declared" | "undeclared" | "notSeen" }) {
  if (s === "declared") return <Tone tone="good" icon={<Check size={12} />}>Matches observed</Tone>;
  if (s === "undeclared") return <Tone tone="bad" icon={<Warn size={12} />}>Undeclared recipient</Tone>;
  return <Tone tone="muted" icon={<Dotted size={12} />}>Not observed</Tone>;
}

/* --- shared by the popup and the dashboard ------------------------------ */

export function headline(tab: TabState, site: Site, cov: Coverage, worker: Worker): [string, string] {
  const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;
  if (!site.enabled) return ["Protection is off on this site", "Requests go out as the dapp wrote them. Turn it back on, then reload the page."];
  if (!cov.total && !cov.notInspected && !cov.other)
    return ["Watching this page", "Nothing observed yet. Canary counts requests as the page makes them; reload the page if it was open before Canary started."];
  const held = tab.counts.failedClosed;
  if (held && !cov.protected && !cov.partial)
    return ["anon-rpc is unreachable right now", `${n(held, "read was", "reads were")} held back instead of going out from your IP.${worker.error ? ` (${worker.error})` : ""}`];
  const title = cov.protected + cov.partial ? "Your reads are going through anon-rpc" : cov.blocked ? "Canary is stopping requests that carry your address" : "Canary is watching this page";
  const sub = cov.exposed
    ? `${n(cov.exposed, "request", "requests")} on this site still went out unprotected.`
    : "Nothing observed on this page sent your address in the clear.";
  return [title, sub];
}

const FILTERS: (Filter | "all")[] = ["all", "protected", "blocked", "exposed", "partial", "notInspected", "other"];

export function useFiltered(tab: TabState, filter: Filter | "all") {
  const evs = useMemo(() => [...(tab.events ?? [])].reverse(), [tab]);
  // Counted in calls, like the coverage numbers: one batch of n JSON-RPC calls is one event.
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const e of evs) {
      c.all += e.n ?? 1;
      c[filterOf(e)] = (c[filterOf(e)] ?? 0) + (e.n ?? 1);
    }
    return c;
  }, [evs]);
  return { all: evs, shown: filter === "all" ? evs : evs.filter((e) => filterOf(e) === filter), counts };
}

export function FilterChips({ value, onChange, counts }: { value: Filter | "all"; onChange: (f: Filter | "all") => void; counts: Record<string, number> }) {
  return (
    <TagGroup
      aria-label="Filter requests"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(k) => onChange([...(k as Set<string>)][0] as Filter | "all")}
    >
      <TagGroup.List className="flex flex-wrap gap-1.5">
        {FILTERS.filter((f) => f === "all" || counts[f] || f === "protected" || f === "blocked" || f === "exposed").map((f) => (
          <Tag
            key={f}
            id={f}
            className="h-7 rounded-full border border-line bg-surface px-2.5 text-[13px] text-ink data-[selected=true]:border-accent data-[selected=true]:bg-wash"
          >
            {f === "all" ? "All" : <Outcome f={f} bare />}
            <span className="ml-1 tabular-nums text-ink-2">{counts[f] ?? 0}</span>
          </Tag>
        ))}
      </TagGroup.List>
    </TagGroup>
  );
}

export function manifestStatusFor(m: ManifestView, host: string, firstParty: boolean): string | undefined {
  if (m.kind !== "ok" || firstParty) return undefined;
  const r = m.rows.find((x) => x.host === host.toLowerCase());
  return r?.status === "declared" ? "Yes, declared" : r?.status === "undeclared" ? "No, undeclared" : undefined;
}

