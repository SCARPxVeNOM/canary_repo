import type { ReactNode } from "react";
import { CATEGORY, short, type Tone } from "./format";
import type { Category, Connection } from "./types";

export function Card({ title, aside, children, className = "" }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || aside) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {aside && <span className="aside">{aside}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

export const Dot = ({ tone, pulse }: { tone: Tone; pulse?: boolean }) => <span className={`dot tone-${tone}${pulse ? " pulse" : ""}`} aria-hidden />;

export const Tag = ({ tone, children }: { tone: Tone; children: ReactNode }) => <span className={`tag tone-${tone}`}>{children}</span>;

export function CategoryTag({ category, count }: { category: Category; count?: number }) {
  const c = CATEGORY[category];
  return (
    <Tag tone={c.tone}>
      {c.label}
      {count !== undefined && <>&nbsp;×{count.toLocaleString("en-US")}</>}
    </Tag>
  );
}

const CONNECTION: Record<Connection, { label: string; tone: "green" | "amber" | "red" | "grey"; pulse?: boolean }> = {
  serving: { label: "Tor serving", tone: "green" },
  warming: { label: "Tor warming up", tone: "amber", pulse: true },
  failed: { label: "Anon path down", tone: "red" },
  disconnected: { label: "No gateway", tone: "grey" },
};

export function ConnectionPill({ connection }: { connection: Connection }) {
  const c = CONNECTION[connection];
  return (
    <span className={`pill ${c.tone}`} role="status">
      <Dot tone={c.tone} pulse={c.pulse} />
      {c.label}
    </span>
  );
}

/** A long hex value, shortened, with the full value on hover. */
export const HexText = ({ value, head, tail }: { value: string; head?: number; tail?: number }) => (
  <span className="mono" title={value}>
    {short(value, head, tail)}
  </span>
);
