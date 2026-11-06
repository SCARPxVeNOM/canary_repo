import { useState } from "react";
import { Header, type TabId } from "./Header";
import { LiveTab } from "./live/LiveTab";
import { LookupTab } from "./lookup/LookupTab";
import { EVENTS, LOOKUP_RESULT, LOOKUP_RESULT_BAD, PSEUDONYM_EXAMPLE, REPORT, STATUS } from "./placeholder";
import type { Connection, LookupState } from "./types";

/* Frontend only: nothing here talks to a gateway, Tor or ENS yet. The screens
   take their content as props from placeholder.ts. Wiring it up means:
     - connection, status, report, events: the local gateway (/canary/status, /canary/report, /canary/events)
     - onSearch: readAgentPrivacy() over anon-rpc, moving `lookup` through reading → found / notFound / error */

export function App() {
  const [tab, setTab] = useState<TabId>("live");
  const [connection, setConnection] = useState<Connection>("serving");
  const [lookup, setLookup] = useState<LookupState>({ kind: "idle" });

  const via = connection === "serving" ? "Reads go over Tor, through your Canary gateway" : "Reads go over Tor, from this browser (anon-rpc)";

  return (
    <div className="app">
      <Header tab={tab} onTab={setTab} connection={connection} />
      <main className="container" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "live" ? (
          <LiveTab connection={connection} status={STATUS} report={REPORT} events={EVENTS} pseudonymExample={PSEUDONYM_EXAMPLE} />
        ) : (
          <LookupTab state={lookup} via={via} onSearch={(name) => setLookup({ kind: "reading", name, step: "tor" })} />
        )}
      </main>
      <footer className="site">
        <div className="container">
          <span>Canary · reads through anon-rpc by default · policy and reports on ENS</span>
          <span>Counts are what Canary observed, not a guarantee that nothing else was sent.</span>
        </div>
      </footer>
      {showPreview && <PreviewSwitcher connection={connection} setConnection={setConnection} lookup={lookup} setLookup={setLookup} goto={setTab} />}
    </div>
  );
}

const showPreview = import.meta.env.DEV || new URLSearchParams(location.search).has("preview");

const LOOKUP_PREVIEWS: { id: string; label: string; state: LookupState }[] = [
  { id: "idle", label: "Empty", state: { kind: "idle" } },
  { id: "tor", label: "Tor", state: { kind: "reading", name: LOOKUP_RESULT.name, step: "tor" } },
  { id: "ens", label: "Reading", state: { kind: "reading", name: LOOKUP_RESULT.name, step: "ens" } },
  { id: "found", label: "Verified", state: { kind: "found", result: LOOKUP_RESULT } },
  { id: "bad", label: "Fails", state: { kind: "found", result: LOOKUP_RESULT_BAD } },
  { id: "nf", label: "Not found", state: { kind: "notFound", name: "nobody.agents.canary.eth" } },
  { id: "err", label: "Error", state: { kind: "error", name: LOOKUP_RESULT.name, message: "Tor didn't connect within 60 s. Nothing was read directly." } },
];

/** Dev-only: flip between screen states while there's no logic behind them. */
function PreviewSwitcher(p: {
  connection: Connection;
  setConnection: (c: Connection) => void;
  lookup: LookupState;
  setLookup: (s: LookupState) => void;
  goto: (t: TabId) => void;
}) {
  const conns: Connection[] = ["serving", "warming", "failed", "disconnected"];
  return (
    <details className="preview" aria-label="Preview states">
      <summary>Preview states</summary>
      <div className="row">
        <span>Live</span>
        <div className="chips">
          {conns.map((c) => (
            <button key={c} className="chip" aria-pressed={p.connection === c} onClick={() => (p.setConnection(c), p.goto("live"))}>
              {c}
            </button>
          ))}
        </div>
      </div>
      <div className="row">
        <span>Lookup</span>
        <div className="chips">
          {LOOKUP_PREVIEWS.map((l) => (
            <button key={l.id} className="chip" aria-pressed={JSON.stringify(p.lookup, big) === JSON.stringify(l.state, big)} onClick={() => (p.setLookup(l.state), p.goto("lookup"))}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}

const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
