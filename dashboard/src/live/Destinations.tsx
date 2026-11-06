import { num } from "../format";
import { Card, CategoryTag } from "../ui";
import type { Category, Report } from "../types";

/** Where the agent's traffic went, per host, and what Canary did with it. */
export function Destinations({ hosts }: { hosts: Report["hosts"] }) {
  const rows = Object.entries(hosts)
    .map(([host, cats]) => ({ host, cats: Object.entries(cats) as [Category, number][], total: Object.values(cats).reduce((a, b) => a + (b ?? 0), 0) }))
    .sort((a, b) => b.total - a.total);

  return (
    <Card title="Destinations" aside={`${rows.length} hosts`}>
      <table className="list">
        <thead>
          <tr>
            <th>Host</th>
            <th>What Canary did</th>
            <th className="right">Calls</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.host}>
              <td style={{ fontWeight: 500, overflowWrap: "anywhere" }}>{r.host}</td>
              <td>
                <span className="chips">
                  {r.cats.map(([c, n]) => (
                    <CategoryTag key={c} category={c} count={n} />
                  ))}
                </span>
              </td>
              <td className="right num">{num(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
