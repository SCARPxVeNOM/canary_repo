import { HexText, Tag } from "../ui";
import { PrivacyRules } from "./PrivacyRules";
import { PublishedReport } from "./PublishedReport";
import { RoleHistory } from "./RoleHistory";
import { TrustChecks, verdictOf } from "./TrustChecks";
import type { AgentPrivacy } from "../types";

const VERDICT = {
  pass: { tone: "green", label: "✓ Verified" },
  fail: { tone: "red", label: "✕ Doesn't check out" },
  unknown: { tone: "amber", label: "Partly verified" },
} as const;

/** Everything readAgentPrivacy() returns for one name. */
export function AgentResult({ result }: { result: AgentPrivacy }) {
  const v = VERDICT[verdictOf(result.checks)];
  return (
    <div className="grid">
      <section className="card span-12" aria-label="Agent">
        <div className="agent-head">
          <div className="avatar" aria-hidden>
            🐤
          </div>
          <div style={{ minWidth: 0 }}>
            <h1 className="mono">{result.name}</h1>
            <div className="muted" style={{ fontSize: 13 }}>
              resolver {result.resolver ? <HexText value={result.resolver} /> : "none"} · Sepolia ·{" "}
              <a href={`https://sepolia.app.ens.domains/${result.name}`} target="_blank" rel="noreferrer">
                open in ENS app ↗
              </a>
            </div>
          </div>
          <span className="verdict">
            <Tag tone={v.tone}>{v.label}</Tag>
          </span>
        </div>
      </section>

      <div className="span-5 stack">
        <TrustChecks checks={result.checks} />
        <RoleHistory changes={result.roleChanges} />
      </div>
      <div className="span-7 stack">
        {result.manifest ? <PrivacyRules manifest={result.manifest} /> : <Missing title="No privacy rules" text={result.manifestError ?? "This name has no privacy.manifest record."} />}
        {result.report ? <PublishedReport report={result.report} /> : <Missing title="No report published" text={result.reportError ?? "This name has no privacy.report record yet."} />}
      </div>
    </div>
  );
}

function Missing({ title, text }: { title: string; text: string }) {
  return (
    <section className="card notice">
      <h2>{title}</h2>
      <p>{text}</p>
    </section>
  );
}
