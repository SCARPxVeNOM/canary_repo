import { CoverageCard } from "./CoverageCard";
import { Destinations } from "./Destinations";
import { Feed } from "./Feed";
import { HealthStrip } from "./HealthStrip";
import { LlmCard } from "./LlmCard";
import { NotConnected } from "./NotConnected";
import { ReportCard } from "./ReportCard";
import type { Connection, Egress, GatewayStatus, SignedReport } from "../types";

export type LiveProps = {
  connection: Connection;
  status: GatewayStatus;
  report: SignedReport;
  events: Egress[];
  pseudonymExample: { before: string; after: string };
};

/** The operator's view of their own gateway. */
export function LiveTab({ connection, status, report, events, pseudonymExample }: LiveProps) {
  if (connection === "disconnected") return <NotConnected />;
  return (
    <div className="grid">
      <div className="span-12">
        {connection === "warming" && (
          <div className="banner amber" role="status">
            <span className="spinner" aria-hidden />
            Tor is still connecting. Requests wait, or fail closed after the timeout; nothing is sent directly.
          </div>
        )}
        {connection === "failed" && (
          <div className="banner red" role="alert">
            <b>Anon path down.</b> Every request fails closed until Tor is back; nothing is sent directly.
          </div>
        )}
        <HealthStrip status={status} connection={connection} />
      </div>
      <div className="span-7 stack">
        <CoverageCard report={report.report} />
        <Feed events={events} />
      </div>
      <div className="span-5 stack">
        <ReportCard signed={report} ens={status.ens} />
        <LlmCard llm={report.report.llm} allowListed={status.llmAllow.length} example={pseudonymExample} />
        <Destinations hosts={report.report.hosts} />
      </div>
    </div>
  );
}
