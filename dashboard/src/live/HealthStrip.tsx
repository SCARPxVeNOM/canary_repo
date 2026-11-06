import { CHAIN_NAME, seconds } from "../format";
import { ConnectionPill, HexText } from "../ui";
import type { Connection, GatewayStatus } from "../types";

/** One line of facts about the gateway: is Tor carrying calls, on what, under which policy. */
export function HealthStrip({ status, connection }: { status: GatewayStatus; connection: Connection }) {
  const ens = status.ens;
  return (
    <section className="card health" aria-label="Gateway health">
      <Item label="Anon path">
        <ConnectionPill connection={connection} />
      </Item>
      <Item label="Network">
        {status.backend.network}
        {connection === "serving" && status.backend.bootMs !== undefined && <span className="muted">· ready in {seconds(status.backend.bootMs)}</span>}
      </Item>
      <Item label="Chains">{status.chains.map((c) => CHAIN_NAME[c] ?? `chain ${c}`).join(" · ")}</Item>
      <Item label="Agent">{status.agent ? <span className="mono">{status.agent}</span> : <span className="muted">unnamed</span>}</Item>
      <Item label="Policy">
        <span>{ens?.manifest.source === "ens" ? "from ENS" : "local file"}</span>
        <HexText value={status.policyHash} />
      </Item>
      <Item label="Unknown hosts">{status.undeclared === "block" ? "blocked" : "reported"}</Item>
    </section>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="item">
      <span className="label">{label}</span>
      <span className="value">{children}</span>
    </div>
  );
}
