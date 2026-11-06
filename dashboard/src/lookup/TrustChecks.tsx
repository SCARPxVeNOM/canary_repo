import { Card } from "../ui";
import type { AgentPrivacy } from "../types";

type Result = "pass" | "fail" | "unknown";

/** The checks a reader makes without trusting the operator (AgentPrivacy.checks). */
export function trustChecks(checks: AgentPrivacy["checks"]): { title: string; why: string; result: Result }[] {
  const r = (v: boolean | undefined, invert = false): Result => (v === undefined ? "unknown" : v !== invert ? "pass" : "fail");
  return [
    { title: "Report is signed", why: "privacy.report carries a valid EIP-712 signature.", result: r(checks.reportSigned) },
    { title: "Signed by the declared reporter", why: "The signature recovers to the reporter named in the agent's rules.", result: r(checks.signerIsReporter) },
    { title: "Report matches the current rules", why: "It was made under the rules published now (same policy hash).", result: r(checks.policyMatches) },
    { title: "Reporter can still publish", why: "The reporter key still holds its one-record role on privacy.report.", result: r(checks.reporterCanWrite) },
    { title: "Reporter never revoked", why: "No role change on the resolver took the reporter's write access away.", result: r(checks.reporterRevoked, true) },
  ];
}

export function verdictOf(checks: AgentPrivacy["checks"]): Result {
  const results = trustChecks(checks).map((c) => c.result);
  if (results.includes("fail")) return "fail";
  if (results.includes("unknown")) return "unknown";
  return "pass";
}

export function TrustChecks({ checks }: { checks: AgentPrivacy["checks"] }) {
  const list = trustChecks(checks);
  const passed = list.filter((c) => c.result === "pass").length;
  return (
    <Card title="Trust checks" aside={`${passed} of ${list.length} pass`}>
      <ul className="checks">
        {list.map((c) => (
          <li key={c.title}>
            <span className={`icon ${c.result}`} aria-label={c.result}>
              {c.result === "pass" ? "✓" : c.result === "fail" ? "✕" : "?"}
            </span>
            <span>
              <span className="title">{c.title}</span>
              <br />
              <span className="why">{c.why}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
