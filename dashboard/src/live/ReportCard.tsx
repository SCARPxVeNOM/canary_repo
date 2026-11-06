import { dateTime, seconds } from "../format";
import { Card, HexText, Tag } from "../ui";
import type { EnsStatus, SignedReport } from "../types";

/** The signed egress report for the current window, and its last publication on ENS. */
export function ReportCard({ signed, ens, onPublish, onRotate }: { signed: SignedReport; ens?: EnsStatus; onPublish?: () => void; onRotate?: () => void }) {
  const r = signed.report;
  return (
    <Card title="Signed report" aside={signed.signature ? <Tag tone="green">EIP-712 signed</Tag> : <Tag tone="grey">unsigned</Tag>}>
      <dl className="kv">
        <dt>Window</dt>
        <dd>
          {dateTime(r.window[0] * 1000)} → {dateTime(r.window[1] * 1000)}
        </dd>
        <dt>Latency</dt>
        <dd>
          p50 {r.latencyMs.p50 !== undefined ? seconds(r.latencyMs.p50) : "–"} · p95 {r.latencyMs.p95 !== undefined ? seconds(r.latencyMs.p95) : "–"}
        </dd>
        <dt>Signed by</dt>
        <dd>{signed.signer ? <HexText value={signed.signer} /> : <span className="muted">no report key</span>}</dd>
        <dt>Report hash</dt>
        <dd>
          <HexText value={signed.reportHash} head={10} tail={6} />
        </dd>
        <dt>On ENS</dt>
        <dd>
          {ens?.lastPublish ? (
            <>
              published {dateTime(ens.lastPublish.at)} ·{" "}
              <a href={`https://sepolia.etherscan.io/tx/${ens.lastPublish.tx}`} target="_blank" rel="noreferrer">
                tx <HexText value={ens.lastPublish.tx} />
              </a>
            </>
          ) : (
            <span className="muted">not published yet</span>
          )}
        </dd>
        {ens && (
          <>
            <dt>Report role</dt>
            <dd>{roleText(ens.reportRole)}</dd>
          </>
        )}
      </dl>
      <div className="actions">
        <button className="btn primary" onClick={onPublish}>
          Publish to ENS
        </button>
        <button className="btn" onClick={onRotate}>
          Start new window
        </button>
      </div>
    </Card>
  );
}

function roleText(role: EnsStatus["reportRole"]) {
  if (role === "granted") return <Tag tone="green">can write privacy.report</Tag>;
  if (role === "revoked") return <Tag tone="red">revoked</Tag>;
  if (role === "not-granted") return <Tag tone="amber">not granted yet</Tag>;
  return <span className="muted">checking…</span>;
}
