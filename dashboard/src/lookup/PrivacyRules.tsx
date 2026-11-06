import { RULE } from "../format";
import { Card, HexText, Tag } from "../ui";
import type { Manifest } from "../types";

/** The agent's privacy.manifest: what it may send where. */
export function PrivacyRules({ manifest }: { manifest: Manifest }) {
  const hosts = Object.entries(manifest.hosts);
  return (
    <Card title="Privacy rules" aside="privacy.manifest">
      <table className="list rules">
        <thead>
          <tr>
            <th>Destination</th>
            <th>Rule</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          {hosts.map(([host, rule]) => (
            <tr key={host}>
              <td>{host}</td>
              <td>
                <Tag tone={RULE[rule].tone}>{RULE[rule].label}</Tag>
              </td>
              <td className="muted">{RULE[rule].hint}</td>
            </tr>
          ))}
          <tr>
            <td>any other host</td>
            <td>{manifest.undeclared === "block" ? <Tag tone="yellow">blocked</Tag> : <Tag tone="red">reported</Tag>}</td>
            <td className="muted">{manifest.undeclared === "block" ? "not declared, so refused" : "sent, and counted as undeclared"}</td>
          </tr>
          <tr>
            <td>transactions</td>
            <td>
              <Tag tone={manifest.rpc.write === "direct" ? "violet" : "green"}>{manifest.rpc.write === "anon" ? "via Tor" : manifest.rpc.write}</Tag>
            </td>
            <td className="muted">how signed transactions leave</td>
          </tr>
        </tbody>
      </table>
      <dl className="kv" style={{ marginTop: 16 }}>
        <dt>Reporter</dt>
        <dd>{manifest.reporter ? <HexText value={manifest.reporter} /> : <span className="muted">none declared</span>}</dd>
        <dt>Wallets</dt>
        <dd>{manifest.wallets === "disclosed" ? "published on the name" : "not published"}</dd>
        <dt>LLM allow-list</dt>
        <dd>{manifest.llm?.allow?.length ? `${manifest.llm.allow.length} well-known contracts` : <span className="muted">none</span>}</dd>
      </dl>
      <details className="raw">
        <summary>Raw record</summary>
        <pre>{JSON.stringify(manifest, null, 2)}</pre>
      </details>
    </Card>
  );
}
