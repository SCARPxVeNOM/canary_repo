import { Card, HexText } from "../ui";
import type { RoleChange } from "../types";

/** When the reporter's write access to privacy.report was granted or revoked (EACRolesChanged). */
export function RoleHistory({ changes }: { changes?: RoleChange[] }) {
  const relevant = (changes ?? []).filter((c) => c.textRole !== "unchanged");
  return (
    <Card title="Reporter access" aside="Enhanced Access Control">
      {relevant.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          No role changes found for the reporter.
        </p>
      ) : (
        <ul className="timeline">
          {[...relevant].reverse().map((c) => (
            <li key={c.transactionHash} style={{ ["--tone" as string]: c.textRole === "granted" ? "var(--green)" : "var(--red)" }}>
              <b>{c.textRole === "granted" ? "Granted" : "Revoked"}</b> write access to <span className="mono">privacy.report</span>
              <br />
              <span className="muted">
                block {c.blockNumber.toLocaleString("en-US")} ·{" "}
                <a href={`https://sepolia.etherscan.io/tx/${c.transactionHash}`} target="_blank" rel="noreferrer">
                  <HexText value={c.transactionHash} />
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="faint" style={{ fontSize: 12.5, margin: "14px 0 0" }}>
        The reporter can write this one record and nothing else on the name: a leaked report key can't change the agent's rules.
      </p>
    </Card>
  );
}
