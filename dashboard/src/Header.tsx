import { ConnectionPill } from "./ui";
import type { Connection } from "./types";

export type TabId = "live" | "lookup";

const TABS: { id: TabId; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "lookup", label: "Agent lookup" },
];

export function Header({ tab, onTab, connection }: { tab: TabId; onTab: (t: TabId) => void; connection: Connection }) {
  return (
    <header className="topbar">
      <div className="container">
        <div className="brand">
          <span className="bird" aria-hidden>
            ◆
          </span>
          Canary <small>for agents</small>
        </div>
        <nav className="tabs" role="tablist" aria-label="Dashboard sections">
          {TABS.map((t) => (
            <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} id={`tab-${t.id}`} onClick={() => onTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <ConnectionPill connection={connection} />
      </div>
    </header>
  );
}
