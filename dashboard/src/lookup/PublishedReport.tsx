import { Card, HexText } from "../ui";
import type { ReportRecord } from "../types";

const day = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);

/** The coarse report on privacy.report: ranges, not exact counts, so it doesn't fingerprint the agent. */
export function PublishedReport({ report }: { report: ReportRecord }) {
  const period = report.days[0] === report.days[1] ? day(report.days[0]) : `${day(report.days[0])} → ${day(report.days[1])}`;
  const cells: [string, string, string?][] = [
    ["Chain reads via Tor", report.rpcViaAnonPct !== undefined ? `${report.rpcViaAnonPct}%` : "–", "var(--green)"],
    ["Chain reads", report.rpcVolume],
    ["Failed closed", report.failedClosed],
    ["Blocked", report.blocked],
    ["Undeclared", report.undeclared],
    ["Addresses pseudonymized", report.llmAddressesPseudonymized, "var(--teal)"],
  ];
  return (
    <Card title="Published report" aside={period}>
      <div className="ranges">
        {cells.map(([k, v, color]) => (
          <div className="stat" key={k}>
            <div className="v" style={color ? { color } : undefined}>
              {v}
            </div>
            <div className="k">{k}</div>
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 12px" }}>
        Counts are published as ranges, so the record doesn't fingerprint the agent's activity. Not inspected: {report.notInspected}.
      </p>
      <dl className="kv">
        <dt>Signer</dt>
        <dd>
          <HexText value={report.signer} />
        </dd>
        <dt>Policy hash</dt>
        <dd>
          <HexText value={report.policyHash} head={10} tail={6} />
        </dd>
        <dt>Full report</dt>
        <dd>
          <HexText value={report.reportHash} head={10} tail={6} />
          {report.evidenceUri && (
            <>
              {" · "}
              <a href={report.evidenceUri} target="_blank" rel="noreferrer">
                evidence
              </a>
            </>
          )}
        </dd>
      </dl>
      <details className="raw">
        <summary>Raw record</summary>
        <pre>{JSON.stringify(report, null, 2)}</pre>
      </details>
    </Card>
  );
}
