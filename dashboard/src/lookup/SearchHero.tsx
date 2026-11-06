import { useState } from "react";
import { Dot } from "../ui";

const EXAMPLES = ["trader-01.agents.canary.eth", "scout-07.agents.canary.eth"];

/** The ENS name box. `via` says how the lookup reaches the chain. */
export function SearchHero({ initial = "", onSearch, compact, via }: { initial?: string; onSearch: (name: string) => void; compact?: boolean; via: string }) {
  const [name, setName] = useState(initial);
  const submit = (n: string) => n.trim() && onSearch(n.trim().toLowerCase());

  return (
    <div className="lookup-hero" style={compact ? { padding: "8px 0 24px" } : undefined}>
      {!compact && (
        <>
          <h1>Check an agent's privacy record</h1>
          <p>
            Every Canary agent publishes its privacy rules and a signed report on its ENS name. Anyone can check them, without trusting the
            operator.
          </p>
        </>
      )}
      <form
        className="search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          submit(name);
        }}
      >
        <label htmlFor="ens-name" className="sr-only">
          Agent ENS name
        </label>
        <input id="ens-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="agent-name.eth" autoComplete="off" spellCheck={false} />
        <button className="btn primary" type="submit">
          Check
        </button>
      </form>
      {!compact && (
        <div className="examples">
          Try:{" "}
          {EXAMPLES.map((ex, i) => (
            <span key={ex}>
              {i > 0 && " · "}
              <button
                type="button"
                onClick={() => {
                  setName(ex);
                  submit(ex);
                }}
              >
                {ex}
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="via">
        <Dot tone="green" />
        {via}
      </div>
    </div>
  );
}
