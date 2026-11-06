import { AgentResult } from "./AgentResult";
import { Reading } from "./Reading";
import { SearchHero } from "./SearchHero";
import type { LookupState } from "../types";

export type LookupProps = {
  state: LookupState;
  onSearch: (name: string) => void;
  /** how the lookup reaches the chain, e.g. "Reads go over Tor through your Canary gateway" */
  via: string;
};

/** Look up any agent's ENS name and check its privacy record. */
export function LookupTab({ state, onSearch, via }: LookupProps) {
  if (state.kind === "idle") return <SearchHero onSearch={onSearch} via={via} />;
  const current = state.kind === "found" ? state.result.name : state.name;
  return (
    <>
      <SearchHero key={current} initial={current} onSearch={onSearch} via={via} compact />
      {state.kind === "reading" && <Reading name={state.name} step={state.step} />}
      {state.kind === "found" && <AgentResult result={state.result} />}
      {state.kind === "notFound" && (
        <section className="card notice">
          <div className="icon" aria-hidden>
            🔍
          </div>
          <h2>{state.name} isn't registered</h2>
          <p>No ENS name by that name on Sepolia. Check the spelling, or the network.</p>
        </section>
      )}
      {state.kind === "error" && (
        <section className="card notice" role="alert">
          <div className="icon" aria-hidden>
            ⚠️
          </div>
          <h2>Couldn't read {state.name}</h2>
          <p>{state.message}</p>
        </section>
      )}
    </>
  );
}
