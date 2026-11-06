import { num } from "../format";
import { Card } from "../ui";
import type { Report } from "../types";

/** What the LLM provider saw: aliases instead of the agent's addresses. */
export function LlmCard({ llm, allowListed, example }: { llm: Report["llm"]; allowListed: number; example: { before: string; after: string } }) {
  return (
    <Card title="LLM prompts" aside={`${allowListed} well-known contracts pass unchanged`}>
      <div className="stats">
        <div className="stat">
          <div className="v">{num(llm.requests)}</div>
          <div className="k">requests to the LLM (declared direct)</div>
        </div>
        <div className="stat">
          <div className="v" style={{ color: "var(--teal)" }}>
            {num(llm.addressesPseudonymized)}
          </div>
          <div className="k">addresses replaced before sending</div>
        </div>
      </div>
      <div className="compare">
        <div className="side">
          <span className="who">Your agent wrote</span>
          <Highlight text={example.before} pattern={/0x[0-9a-fA-F]{40}/g} className="real" />
        </div>
        <div className="side">
          <span className="who">The provider received</span>
          <Highlight text={example.after} pattern={/\b(?:WALLET|ADDR|HASH)_\d+\b/g} />
        </div>
      </div>
    </Card>
  );
}

function Highlight({ text, pattern, className }: { text: string; pattern: RegExp; className?: string }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    out.push(text.slice(last, m.index));
    out.push(
      <mark key={m.index} className={className}>
        {m[0]}
      </mark>,
    );
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}
