/** Progress while the lookup connects to Tor and reads the name's records. */
export function Reading({ name, step }: { name: string; step: "tor" | "ens" }) {
  const steps = [
    { id: "tor", label: "Connecting to Tor" },
    { id: "ens", label: `Reading ${name} on ENS` },
    { id: "verify", label: "Checking the signature and the reporter's role" },
  ];
  const current = steps.findIndex((s) => s.id === step);
  return (
    <section className="card notice" aria-live="polite" aria-busy="true">
      <div className="progress">
        {steps.map((s, i) => (
          <div key={s.id} className={`step${i < current ? " done" : ""}`}>
            {i < current ? <span className="tick">✓</span> : i === current ? <span className="spinner" aria-hidden /> : <span className="tick pending">·</span>}
            {s.label}
          </div>
        ))}
      </div>
      <p className="faint" style={{ marginTop: 18, fontSize: 12.5 }}>
        The first lookup waits for a Tor circuit; later ones are about a second.
      </p>
    </section>
  );
}
