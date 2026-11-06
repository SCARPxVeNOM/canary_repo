import { num, pct, type Tone } from "../format";
import { Card, Dot } from "../ui";
import type { Report } from "../types";

type Row = { label: string; tone: Tone; count: number };

/** The headline number, a stacked bar of chain reads, and every category counted. */
export function CoverageCard({ report }: { report: Report }) {
  const { rpc, http, llm } = report;
  const viaAnon = rpc.protected + rpc.ipOnly;

  const rpcRows: Row[] = [
    { label: "Protected", tone: "green", count: rpc.protected },
    { label: "Protected (IP only)", tone: "blue", count: rpc.ipOnly },
    { label: "Failed closed", tone: "amber", count: rpc.failedClosed },
    { label: "Blocked", tone: "yellow", count: rpc.blocked },
    { label: "Direct (declared)", tone: "violet", count: rpc.direct },
  ];
  const httpRows: Row[] = [
    { label: "Via Tor", tone: "green", count: http.anon },
    { label: "Direct (declared)", tone: "violet", count: http.direct },
    { label: "Blocked", tone: "yellow", count: http.blocked },
    { label: "Undeclared", tone: "red", count: http.undeclared },
    { label: "Not inspected", tone: "grey", count: http.notInspected },
    { label: "Failed closed", tone: "amber", count: http.failedClosed },
  ];

  return (
    <Card title="Coverage" aside="this report window">
      <div className="headline">
        <span className="big num">{pct(viaAnon, rpc.total)}%</span>
        <span className="of">
          of chain reads went through anon-rpc · <b className="num">{num(viaAnon)}</b> / {num(rpc.total)}
        </span>
      </div>
      <p className="subline">
        Nothing was sent directly when Tor was down: {num(rpc.failedClosed)} calls failed closed instead.
        {rpc.linked > 0 && ` ${num(rpc.linked)} calls carried two of your wallets together (can't be split).`}
      </p>

      <div className="stackbar" role="img" aria-label={`Chain reads: ${rpcRows.map((r) => `${r.label} ${r.count}`).join(", ")}`}>
        {rpcRows
          .filter((r) => r.count > 0)
          .map((r) => (
            <span key={r.label} className={`tone-${r.tone}`} style={{ flex: r.count }} title={`${r.label}: ${num(r.count)}`} />
          ))}
      </div>

      <div className="legend">
        <div className="group">Chain reads (RPC)</div>
        {rpcRows.map((r) => (
          <LegendRow key={r.label} row={r} />
        ))}
        <div className="group">Other traffic (HTTP)</div>
        {httpRows.map((r) => (
          <LegendRow key={r.label} row={r} />
        ))}
        <div className="group">LLM prompts</div>
        <LegendRow row={{ label: "Addresses pseudonymized", tone: "teal", count: llm.addressesPseudonymized }} />
      </div>
    </Card>
  );
}

function LegendRow({ row }: { row: Row }) {
  return (
    <div className="row">
      <Dot tone={row.tone} />
      <span className={row.count ? "" : "faint"}>{row.label}</span>
      <span className={`count${row.count ? "" : " faint"}`}>{num(row.count)}</span>
    </div>
  );
}
