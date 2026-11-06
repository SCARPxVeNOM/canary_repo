// Small line icons, drawn for Canary's four outcomes. currentColor, 16 px grid.

import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = ({ size = 16, ...p }: P) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...p,
});

export const Shield = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 1.75 2.75 3.6v4.1c0 3.1 2.2 5.4 5.25 6.55 3.05-1.15 5.25-3.45 5.25-6.55V3.6L8 1.75Z" />
    <path d="m5.6 8 1.7 1.7 3.1-3.3" />
  </svg>
);
export const Half = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 2.25a5.75 5.75 0 0 1 0 11.5Z" fill="currentColor" stroke="none" />
  </svg>
);
export const Slash = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="m4 4 8 8" />
  </svg>
);
export const Eye = (p: P) => (
  <svg {...base(p)}>
    <path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8Z" />
    <circle cx="8" cy="8" r="1.9" />
  </svg>
);
export const Dotted = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="5.75" strokeDasharray="2 2.1" />
    <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);
export const Hatch = (p: P) => (
  <svg {...base({ ...p, viewBox: "0 0 22 14", width: (p.size ?? 16) * 1.5 })} strokeWidth={1.3}>
    <rect x="1" y="2" width="20" height="10" rx="2" strokeDasharray="2.5 2" />
    <path d="m4.5 10.5 5-7M9.5 10.5l5-7M14.5 10.5l4-5.6" />
  </svg>
);
export const Globe = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M2.25 8h11.5M8 2.25c1.6 1.7 2.4 3.6 2.4 5.75S9.6 12.05 8 13.75C6.4 12.05 5.6 10.15 5.6 8S6.4 3.95 8 2.25Z" />
  </svg>
);
export const Info = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 7.25v3.5M8 5.2v.1" />
  </svg>
);
export const Warn = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 2.25 1.9 13h12.2L8 2.25Z" />
    <path d="M8 6.5v3M8 11.2v.1" />
  </svg>
);
export const Check = (p: P) => (
  <svg {...base(p)}>
    <path d="m3.5 8.3 2.9 2.9 6.1-6.4" />
  </svg>
);
export const Route = (p: P) => (
  <svg {...base(p)}>
    <circle cx="4" cy="12.5" r="1.6" />
    <circle cx="12" cy="3.5" r="1.6" />
    <path d="M5.4 11.7c3.2-1.4.6-5.6 3.8-7.2l1.3-.6" />
  </svg>
);
export const Chevron = (p: P) => (
  <svg {...base(p)}>
    <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
  </svg>
);
export const Copy = (p: P) => (
  <svg {...base(p)}>
    <rect x="5.25" y="5.25" width="8" height="8" rx="1.6" />
    <path d="M10.75 5.25v-1.5a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h1.5" />
  </svg>
);
export const External = (p: P) => (
  <svg {...base(p)}>
    <path d="M9.5 2.75h3.75V6.5M13.25 2.75 7.5 8.5M11.5 9.5v2.25a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5V6a1.5 1.5 0 0 1 1.5-1.5H6.5" />
  </svg>
);
export const Download = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 2.5v7.5M4.75 7 8 10.25 11.25 7M3 13.25h10" />
  </svg>
);
