import { useState } from "react";
import { CHANNEL_LABEL, clock, seconds, short } from "../format";
import { Card, CategoryTag, Tag } from "../ui";
import type { Egress } from "../types";

type Filter = "all" | "rpc" | "http" | "llm" | "stopped";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "rpc", label: "Chain reads" },
  { id: "http", label: "HTTP" },
  { id: "llm", label: "LLM" },
  { id: "stopped", label: "Blocked & failed" },
];

const matches = (f: Filter, e: Egress) =>
  f === "all" ||
  (f === "rpc" && e.channel === "rpc") ||
  (f === "llm" && e.channel === "llm") ||
  (f === "http" && (e.channel === "proxy" || e.channel === "connect" || e.channel === "sdk")) ||
  (f === "stopped" && (e.category === "blocked" || e.category === "failedClosed" || e.category === "undeclared"));

/** Every decision the gateway makes, newest first (GET /canary/events). */
export function Feed({ events, paused, onTogglePause }: { events: Egress[]; paused?: boolean; onTogglePause?: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = events.filter((e) => matches(filter, e));

  return (
    <Card
      title="Live feed"
      aside={
        <button className="btn ghost" onClick={onTogglePause} aria-pressed={!!paused}>
          {paused ? "▶ Resume" : "❚❚ Pause"}
        </button>
      }
    >
      <div className="chips" role="group" aria-label="Filter the feed" style={{ marginBottom: 12 }}>
        {FILTERS.map((f) => (
          <button key={f.id} className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="muted" style={{ margin: "24px 0", textAlign: "center" }}>
          Nothing here yet.
        </p>
      ) : (
        <ul className="feed" aria-live={paused ? "off" : "polite"}>
          {shown.map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <span className="time">{clock(e.at)}</span>
              <span>
                <Tag tone="grey">{CHANNEL_LABEL[e.channel]}</Tag>
              </span>
              <span className="what">
                <span className="host">{e.host}</span>
                <span className="detail">{detail(e)}</span>
              </span>
              <span className="tagcell">
                <CategoryTag category={e.category} count={e.count} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function detail(e: Egress) {
  const parts: string[] = [];
  if (e.methods?.length) parts.push(e.methods.join(", "));
  if (e.address) parts.push(`carried ${short(e.address)}`);
  if (e.ms !== undefined) parts.push(seconds(e.ms));
  if (e.note) parts.push(e.note);
  return parts.join(" · ");
}
